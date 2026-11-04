// @vitest-environment node
/*
 * Admin directory-exclusion CRUD (mig 0083) + the search-filter it drives.
 * Org-wide config (platform-admin); a region admin cannot edit.
 * Covers the match-all footgun rejection, the matched_existing_count warning,
 * and that a configured pattern removes the account from the people-picker.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { startTestDb, stopTestDb, type TestDb } from '../helpers/db'
import { injectTestSession } from '../../helpers/auth'
import type { Session } from '../../../server/utils/auth'
import listHandler from '../../../server/api/v1/admin/directory-exclusions/index.get'
import addHandler from '../../../server/api/v1/admin/directory-exclusions/index.post'
import delHandler from '../../../server/api/v1/admin/directory-exclusions/[id].delete'
import searchHandler from '../../../server/api/v1/admin/directory/search.get'
import { isExcludedUpn, loadDirectoryExclusionPatterns } from '../../../server/utils/directory-exclusions'

let t: TestDb
let regionId = ''
let unitId = ''
const FINOPS_ID = '00000000-0000-0000-0000-0000000000e1'

function ev(opts: { session: Session; body?: unknown; params?: Record<string, string>; url?: string; method?: string }) {
  const headers: Record<string, string> = { host: 'localhost:3450', origin: 'http://localhost:3450' }
  const method = opts.method ?? 'POST'
  const url = opts.url ?? '/x'
  const e = {
    method, path: url, context: { params: opts.params ?? {} },
    node: {
      req: { method, url, body: opts.body, socket: { remoteAddress: '127.0.0.1' }, get headers() { return { ...headers, 'content-type': 'application/json' } } },
      res: { _headers: {} as Record<string, unknown>, statusCode: 200, getHeader() {}, setHeader() {}, removeHeader() {}, appendHeader() {}, get headersSent() { return false } },
    },
  }
  injectTestSession(e as unknown as Parameters<typeof injectTestSession>[0], opts.session)
  return e as never
}
const finops = (): Session => ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'platform-admin', regionId, orgPath: 'de' } as Session)
const regionAdmin = (): Session => ({ teammateId: FINOPS_ID, email: 'fx@x.test', displayName: 'Fx', role: 'admin', regionId, orgPath: 'de' } as Session)

beforeAll(async () => {
  delete process.env.NUXT_GRAPH_DIRECTORY_MODE // mock directory
  t = await startTestDb(); process.env.DATABASE_URL = t.url
  const [r] = await t.client<{ id: string }[]>`INSERT INTO region (code, display_name) VALUES ('de', 'DE') RETURNING id::text AS id`
  regionId = r!.id
  const [u] = await t.client<{ id: string }[]>`INSERT INTO org_unit (region_id, parent_id, path, code, display_name, unit_type) VALUES (${regionId}::uuid, NULL, 'de'::ltree, 'default', 'DE', 'bu') RETURNING id::text AS id`
  unitId = u!.id
  await t.client`INSERT INTO teammate (id, entra_oid, email, display_name, region_id, org_unit_id, role) VALUES (${FINOPS_ID}::uuid, 'oid-fx', 'fx@x.test', 'Fx', ${regionId}::uuid, ${unitId}::uuid, 'platform-admin')`
}, 180_000)
afterAll(async () => { if (t) await stopTestDb(t) }, 30_000)

beforeEach(async () => {
  await t.client`DELETE FROM directory_exclusion_pattern`
  await t.client`DELETE FROM teammate WHERE source = 'directory'`
})

describe('admin directory-exclusions CRUD', () => {
  it('adds, lists, and removes a pattern (platform-admin)', async () => {
    const added = (await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com', note: 'CLD admins' } }))) as { id: string; pattern: string }
    expect(added.pattern).toBe('*@contoso.onmicrosoft.com')
    const listed = (await listHandler(ev({ session: finops(), method: 'GET' }))) as { patterns: { id: string; pattern: string }[] }
    expect(listed.patterns.map((p) => p.pattern)).toContain('*@contoso.onmicrosoft.com')
    await delHandler(ev({ session: finops(), method: 'DELETE', params: { id: added.id } }))
    const after = (await listHandler(ev({ session: finops(), method: 'GET' }))) as { patterns: unknown[] }
    expect(after.patterns).toHaveLength(0)
  })

  it('rejects the match-all footgun (400)', async () => {
    for (const pattern of ['*', '*@*', '*@*.com']) {
      await expect(addHandler(ev({ session: finops(), body: { pattern } }))).rejects.toMatchObject({ statusCode: 400 })
    }
  })

  it('409s a duplicate pattern (case-insensitive)', async () => {
    await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } }))
    await expect(
      addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } })),
    ).rejects.toMatchObject({ statusCode: 409 })
  })

  it('a region admin cannot edit the org-wide policy (403)', async () => {
    await expect(
      addHandler(ev({ session: regionAdmin(), body: { pattern: '*@contoso.onmicrosoft.com' } })),
    ).rejects.toMatchObject({ statusCode: 403 })
  })

  it('a region admin cannot remove a pattern either (403), and it stays', async () => {
    const added = (await addHandler(ev({ session: finops(), body: { pattern: '*@svc.example.test' } }))) as { id: string }
    await expect(
      delHandler(ev({ session: regionAdmin(), method: 'DELETE', params: { id: added.id } })),
    ).rejects.toMatchObject({ statusCode: 403 })
    const listed = (await listHandler(ev({ session: regionAdmin(), method: 'GET' }))) as { patterns: { id: string }[] }
    expect(listed.patterns.map((p) => p.id)).toContain(added.id)
  })

  // RLS binds only a non-owner, and the test user owns the table (and is a superuser), so each
  // case creates a throwaway NOLOGIN role inside its own transaction; the transaction never
  // commits, so the role and any row go with it. The Admin twin proves the harness enforces
  // nothing extra: the same insert under the platform-admin scope value succeeds.
  async function insertAs(scope: string): Promise<'inserted'> {
    const ROLLBACK = new Error('rollback')
    try {
      await t.client.begin(async (tx) => {
        await tx`CREATE ROLE de_rls_probe NOLOGIN`
        await tx`GRANT SELECT, INSERT ON directory_exclusion_pattern TO de_rls_probe`
        await tx`SET LOCAL ROLE de_rls_probe`
        await tx`SELECT set_config('app.user_role', ${scope}, true)`
        await tx`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@rls.example.test')`
        throw ROLLBACK
      })
    } catch (err) {
      if (err === ROLLBACK) return 'inserted'
      throw err
    }
    throw new Error('unreachable')
  }

  it('the database refuses a Region admin write even past the route (mig 0167)', async () => {
    await expect(insertAs('admin')).rejects.toThrow(/row-level security/)
  })

  it('the database admits the same write under the Admin scope (mig 0167 red twin)', async () => {
    await expect(insertAs('global-finops')).resolves.toBe('inserted')
  })

  it('returns matched_existing_count so the UI can warn before excluding real people', async () => {
    // A teammate whose stored email is on the onmicrosoft domain.
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES ('cld-1', 'someone-cld@contoso.onmicrosoft.com', 'X', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'directory')`
    const added = (await addHandler(ev({ session: finops(), body: { pattern: '*@contoso.onmicrosoft.com' } }))) as { matched_existing_count: number }
    expect(added.matched_existing_count).toBe(1)
  })

  it('the ESCAPE-as-template-literal bug: an underscore pattern still matches its literal target (matched_existing_count agrees with isExcludedUpn over the same roster)', async () => {
    /*
     * Regression pin for the `ESCAPE '\'`-as-a-template-literal collapse
     * (server/utils/sql-like.ts): written as a literal inside the SQL template,
     * `ESCAPE '\'` becomes `ESCAPE ''` before Postgres ever sees it, which
     * DISABLES escape processing entirely — a backslash in the LIKE body then
     * means a literal backslash character, not "the next character is
     * literal". upnGlobToSqlLike('*_svc@example.com') produces the body
     * `%\_svc@example.com`: with escaping enabled that reads "ends with a
     * literal underscore, svc@example.com"; with it disabled it reads "ends
     * with an actual backslash character, underscore, svc@example.com" — which
     * NO real email contains, so the broken form silently reports 0 instead
     * of 1. This is the SAME "preview reports 0, admin approves blind"
     * failure the story's Must-not-break section warns about, reached via a
     * different route (an inert escape instead of a double escape).
     */
    await t.client`INSERT INTO teammate (entra_oid, email, display_name, region_id, org_unit_id, role, source)
      VALUES
        ('svc-underscore', 'build_svc@example.com', 'Build Svc', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'directory'),
        ('svc-x-not-underscore', 'buildXsvc@example.com', 'Build X Svc', ${regionId}::uuid, ${unitId}::uuid, 'developer', 'directory')`
    const pattern = '*_svc@example.com'
    const added = (await addHandler(ev({ session: finops(), body: { pattern } }))) as { matched_existing_count: number }

    // The literal underscore must match ONLY build_svc@example.com. A broken
    // ESCAPE clause reports 0 (see above) — buildXsvc@example.com never
    // matches either way, so this assertion alone pins the regression.
    expect(added.matched_existing_count).toBe(1)

    // Preview (DB-side LIKE) and enforcement (isExcludedUpn / upnGlobMatches,
    // in-process) must AGREE over the identical roster — the "Must not break"
    // invariant: the retro-cleanup worker consumes isExcludedUpn, not the LIKE
    // path, so a desync here means the preview lied about what the worker will
    // actually do.
    const roster = ['build_svc@example.com', 'buildXsvc@example.com']
    const enforcementCount = roster.filter((upn) => isExcludedUpn(upn, [pattern])).length
    expect(enforcementCount).toBe(1)
    expect(added.matched_existing_count).toBe(enforcementCount)
  })
})

describe('search filter honours the exclusion policy', () => {
  it('hides an excluded (onmicrosoft) account from the picker; standard account stays', async () => {
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*@contoso.onmicrosoft.com')`
    const res = (await searchHandler(ev({ session: finops(), method: 'GET', url: '/x?q=rio' }))) as { results: { oid: string }[] }
    const oids = res.results.map((r) => r.oid)
    expect(oids).toContain('dir-oid-0007') // standard account still pickable
    expect(oids).not.toContain('dir-oid-0007-cld') // privileged account hidden
  })

  it('FAIL-OPEN: with no pattern, the onmicrosoft account is still listed', async () => {
    const res = (await searchHandler(ev({ session: finops(), method: 'GET', url: '/x?q=rio' }))) as { results: { oid: string }[] }
    expect(res.results.map((r) => r.oid)).toContain('dir-oid-0007-cld')
  })
})

describe('defense-in-depth: read-time validation', () => {
  it('SKIPS a match-all pattern that reached the table by a non-API path', async () => {
    // A direct insert bypassing the POST validator (bulk import / psql fix).
    await t.client`INSERT INTO directory_exclusion_pattern (pattern) VALUES ('*')`
    const patterns = await loadDirectoryExclusionPatterns(t.db as unknown as Parameters<typeof loadDirectoryExclusionPatterns>[0])
    expect(patterns).not.toContain('*') // never applied → picker isn't emptied
  })
})
