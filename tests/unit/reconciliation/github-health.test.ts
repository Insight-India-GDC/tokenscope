/*
 * GitHub reconciliation health — unit tests for the classified, key-safe probe
 * (server/reconciliation/github-health.ts). Pure + fully injectable (credential resolver,
 * probe client, roster), so no network/DB. Drives EACH verdict — including the transient
 * (upstream-transient) and infra (probe-error) verdicts and the client's LITERAL fail
 * strings — and asserts the load-bearing safety property: NO secret (App key / PEM /
 * installation token / PAT) leaks into the output.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import {
  computeGithubEnterpriseHealth,
  classifyGithubHealthError,
  isSamlEndpointError,
  githubProbeDay,
  synthesiseVerdict,
  colorFor,
  type GithubEnterpriseRow,
  type ComputeGithubHealthOpts,
  type HealthProbeClient,
} from '../../../server/reconciliation/github-health'
import { MissingGithubAppKeyError } from '../../../server/reconciliation/credentials'
// The REAL client (no module mocks in this file) — the tightened-budget tests drive it
// against a stubbed global fetch to prove the fetch-budget plumbing end-to-end.
import { GithubCopilotClient } from '../../../server/reconciliation/adapters/github-client'

// A fake secret we thread through the credential value; the SAFETY tests grep the whole
// JSON output for it and must never find it.
const FAKE_SECRET = 'SUPER-SECRET-PEM-OR-PAT-abc123'

const APP_ENT: GithubEnterpriseRow = { enterpriseId: 'ent-uuid-1', externalId: 'acme-ent', githubAppId: '4242' }
const PAT_ENT: GithubEnterpriseRow = { enterpriseId: 'ent-uuid-2', externalId: 'acme-pat', githubAppId: null }

const NOW = new Date('2026-06-30T10:00:00Z')

/** A createError-shaped upstream failure, EXACTLY as GithubCopilotClient.fail() throws it:
 *  the createError envelope is a 502 (data.status=502) and the REAL status is in detail. */
function upstream(status: number, extra?: string): unknown {
  return { statusCode: 502, data: { status: 502, detail: `surface returned HTTP ${status}${extra ? ` :: ${extra}` : ''}` } }
}
/** A raw node network error (what resilientFetch re-throws). */
function netErr(code: string): unknown {
  return Object.assign(new Error(`request to https://api.github.com failed, reason: ${code}`), { code })
}
/** The client's LITERAL not-ready fail shape (github-client.ts getUserDailyCredits). */
function notReadyErr(): unknown {
  return { statusCode: 502, data: { status: 502, detail: 'copilot metrics users-1-day (report not ready — no download_links) returned HTTP 200' } }
}
/** The client's LITERAL report_day-mismatch fail shape (anti-mis-dating guard). */
function reportDayMismatchErr(): unknown {
  return { statusCode: 502, data: { status: 502, detail: 'copilot metrics users-1-day (report_day 2026-06-27 != requested 2026-06-28) returned HTTP 200' } }
}
/*
 * The REAL github-CLIENT endpoint failure shape (createError data envelope): a
 * github-upstream `type` + the SURFACE string in detail — what listSamlIdentities() throws on a
 * non-OK HTTP for the externalIdentities GraphQL POST (after the org installation token minted).
 * The `type` is what distinguishes an endpoint failure from an App-auth failure.
 */
function endpointErr(surface: string, status: number, extra?: string): unknown {
  return {
    statusCode: 502,
    data: { status: 502, type: 'https://tokenscope.example.com/errors/github-upstream', detail: `${surface} returned HTTP ${status}${extra ? ` :: ${extra}` : ''}` },
  }
}
/*
 * The REAL github-SAML failure shape: a 200 GraphQL response carrying errors (FORBIDDEN /
 * INSUFFICIENT_SCOPES) — listSamlIdentities() throws it with a github-saml `type`. Like the
 * github-upstream endpoint error, it proves the org token minted (the GraphQL was reached).
 */
function samlErr(errorTypes: string[]): unknown {
  return {
    statusCode: 502,
    data: { status: 502, type: 'https://tokenscope.example.com/errors/github-saml', detail: errorTypes.join(',') },
  }
}
/*
 * The REAL github-APP-AUTH failure shape (install-lookup / token-mint): a github-app-upstream
 * `type`, marking the App-AUTH layer (NOT the endpoint) as the failure origin → appAuth ✗.
 */
function appAuthErr(surface: string, status: number): unknown {
  return {
    statusCode: 502,
    data: { status: 502, type: 'https://tokenscope.example.com/errors/github-app-upstream', detail: `${surface} returned HTTP ${status}` },
  }
}
/** A real ZodError (schema drift / an HTML page where JSON was expected, then parsed). */
function zodErr(): unknown {
  try {
    z.object({ download_links: z.array(z.string()) }).parse({ download_links: 'network TLS ECONNREFUSED' })
  } catch (e) {
    return e
  }
  throw new Error('unreachable')
}

/*
 * Build opts for an APP-mode enterprise with an injected client + roster. resolveCredential
 * is stubbed to return an App credential carrying FAKE_SECRET as the value; probeClient
 * returns the supplied stub (so the real GithubAppAuth ctor never runs).
 */
function appOpts(client: HealthProbeClient, roster: string[] = [], selfOnly: string[] = []): ComputeGithubHealthOpts {
  return {
    now: NOW,
    resolveCredential: async () => ({ secretName: 'acme', value: FAKE_SECRET, level: 'enterprise', kind: 'github-app', appId: '4242' }),
    probeClient: () => client,
    resolveRoster: async () => new Map(roster.map((l) => [l.toLowerCase(), `tm-${l}`])),
    resolveSelfOnly: async () => new Map(selfOnly.map((l) => [l.toLowerCase(), `${l}@example.com`])),
    // App mode probes a representative onboarded license org's externalIdentities. A single-org
    // list means chooseRepresentativeLicenseOrg returns it directly (no seat call).
    resolveLicenseOrgs: async () => ['acme-org'],
  }
}
function patOpts(client: HealthProbeClient, roster: string[] = [], selfOnly: string[] = []): ComputeGithubHealthOpts {
  return {
    now: NOW,
    resolveCredential: async () => ({ secretName: 'acme', value: FAKE_SECRET, level: 'enterprise', kind: 'github-pat' }),
    probeClient: () => client,
    resolveRoster: async () => new Map(roster.map((l) => [l.toLowerCase(), `tm-${l}`])),
    resolveSelfOnly: async () => new Map(selfOnly.map((l) => [l.toLowerCase(), `${l}@example.com`])),
  }
}

const fakeDb = {} as never // never touched — the roster + credential resolvers are injected.

describe('githubProbeDay — today − 2 (finalized) UTC day', () => {
  it('subtracts two days', () => {
    expect(githubProbeDay(new Date('2026-06-30T10:00:00Z'))).toBe('2026-06-28')
  })
  it('crosses a month boundary', () => {
    expect(githubProbeDay(new Date('2026-07-01T00:30:00Z'))).toBe('2026-06-29')
  })
})

describe('classifyGithubHealthError — status/code/surface → safe bucket', () => {
  it('maps HTTP statuses out of the wrapped detail (never a body)', () => {
    expect(classifyGithubHealthError(upstream(401), 'github-app')).toBe('auth-failed')
    expect(classifyGithubHealthError(upstream(403), 'github-app')).toBe('auth-failed')
    expect(classifyGithubHealthError(upstream(429), 'github-app')).toBe('rate-limited')
    expect(classifyGithubHealthError(upstream(500), 'github-app')).toBe('upstream-error')
    expect(classifyGithubHealthError(upstream(503), 'github-app')).toBe('upstream-error')
  })
  it('404 is MODE-AWARE (M2): App → not-installed; PAT → auth-failed (scope/SSO hiding)', () => {
    expect(classifyGithubHealthError(upstream(404), 'github-app')).toBe('not-installed')
    expect(classifyGithubHealthError(upstream(404), 'github-pat')).toBe('auth-failed')
    expect(classifyGithubHealthError(upstream(404, 'no install'), 'github-app')).toBe('not-installed')
    expect(classifyGithubHealthError(upstream(404, 'no install'), 'github-pat')).toBe('auth-failed')
  })
  it('maps node egress codes to egress-blocked', () => {
    for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND', 'ECONNRESET']) {
      expect(classifyGithubHealthError(netErr(code), 'github-app')).toBe('egress-blocked')
    }
  })
  it("the client's LITERAL not-ready fail (HTTP 200 in detail) → not-ready, NOT a red bucket (M1)", () => {
    expect(classifyGithubHealthError(notReadyErr(), 'github-app')).toBe('not-ready')
  })
  it("the client's LITERAL report_day-mismatch fail → not-ready (M1)", () => {
    expect(classifyGithubHealthError(reportDayMismatchErr(), 'github-app')).toBe('not-ready')
  })
  it('a SyntaxError (HTML error page fed to res.json) → upstream-error, never egress', () => {
    expect(classifyGithubHealthError(new SyntaxError('Unexpected token < in JSON at position 0'), 'github-app')).toBe('upstream-error')
  })
  it('a ZodError (drifted shape) → upstream-error, even when its message carries egress-y text', () => {
    // The ZodError's issue text embeds "network TLS ECONNREFUSED" (a field VALUE) — the
    // parse-error check must fire BEFORE the egress regex so this never reads as egress.
    expect(classifyGithubHealthError(zodErr(), 'github-app')).toBe('upstream-error')
  })
  it('maps a malformed App key + missing App key', () => {
    expect(classifyGithubHealthError(new Error('github-app-auth: App private key is not valid base64'), 'github-app')).toBe('key-malformed')
    expect(classifyGithubHealthError(new MissingGithubAppKeyError('acme-ent', 'acme'), 'github-app')).toBe('no-credential')
  })
  it('a "no install" surface without a status: App → not-installed; PAT → upstream-error', () => {
    expect(classifyGithubHealthError({ data: { detail: 'installation lookup: no install' } }, 'github-app')).toBe('not-installed')
    expect(classifyGithubHealthError({ data: { detail: 'installation lookup: no install' } }, 'github-pat')).toBe('upstream-error')
  })
  it('a github-saml type (GraphQL FORBIDDEN/INSUFFICIENT_SCOPES, HTTP 200) → auth-failed, TYPE-based not body (MEDIUM-1)', () => {
    // The org-admin-read denial is a 200 carrying GraphQL errors → the fixed github-saml type,
    // classified from the TYPE alone (no HTTP status, no body read). Actionable red, not amber.
    expect(classifyGithubHealthError(samlErr(['FORBIDDEN']), 'github-app')).toBe('auth-failed')
    expect(classifyGithubHealthError(samlErr(['INSUFFICIENT_SCOPES']), 'github-app')).toBe('auth-failed')
  })
  it('a TRANSIENT externalIdentities error (429/5xx github-upstream) stays transient, NOT auth-failed (MEDIUM-1 guard)', () => {
    // A rate-limit / 5xx on the SAME externalIdentities call is a NON-OK HTTP → a github-upstream
    // envelope with an "HTTP <n>" status (not a github-saml type), so it must classify by status —
    // never swept into auth-failed by the github-saml rule.
    expect(classifyGithubHealthError(endpointErr('graphql externalIdentities', 429), 'github-app')).toBe('rate-limited')
    expect(classifyGithubHealthError(endpointErr('graphql externalIdentities', 503), 'github-app')).toBe('upstream-error')
  })
  it('the tight-budget fetch abort (DOMException TimeoutError/AbortError) → egress-blocked', () => {
    // AbortSignal.timeout rejects undici fetch with a DOMException named 'TimeoutError' —
    // the genuine transport-level signature of a black-holed call under the tight budget.
    expect(classifyGithubHealthError(new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'github-pat')).toBe('egress-blocked')
    expect(classifyGithubHealthError(new DOMException('This operation was aborted', 'AbortError'), 'github-app')).toBe('egress-blocked')
  })
  it('the stage-deadline BACKSTOP sentinel → probe-window-exceeded, NOT egress (NEW-M1)', () => {
    const sentinel = Object.assign(new Error('github health probe: seats exceeded the 20000 ms probe window (backstop)'), { code: 'PROBE_WINDOW_EXCEEDED' })
    expect(classifyGithubHealthError(sentinel, 'github-app')).toBe('probe-window-exceeded')
    expect(classifyGithubHealthError(sentinel, 'github-pat')).toBe('probe-window-exceeded')
  })
  it('an unclassifiable error defaults to upstream-error (transient), NEVER egress/auth (H1)', () => {
    expect(classifyGithubHealthError(new Error('something odd'), 'github-app')).toBe('upstream-error')
    expect(classifyGithubHealthError({}, 'github-pat')).toBe('upstream-error')
  })
})

describe('isSamlEndpointError — origin discrimination (POSITIVE, fail-safe)', () => {
  it('true for a github-upstream envelope whose surface is the externalIdentities GraphQL', () => {
    expect(isSamlEndpointError(endpointErr('graphql externalIdentities', 403))).toBe(true)
    expect(isSamlEndpointError(endpointErr('graphql externalIdentities', 401))).toBe(true)
  })
  it('true for a github-saml envelope (a 200 carrying GraphQL FORBIDDEN / INSUFFICIENT_SCOPES)', () => {
    expect(isSamlEndpointError(samlErr(['FORBIDDEN']))).toBe(true)
    expect(isSamlEndpointError(samlErr(['INSUFFICIENT_SCOPES']))).toBe(true)
  })
  it('false for an App-AUTH envelope (install-lookup / token-mint) — the wrong `type`', () => {
    expect(isSamlEndpointError(appAuthErr('app/installations/{id}/access_tokens', 403))).toBe(false)
    expect(isSamlEndpointError(appAuthErr('orgs/{org}/installation', 403))).toBe(false)
  })
  it('false for a github-upstream envelope whose surface is NOT externalIdentities (e.g. the install lookup)', () => {
    expect(isSamlEndpointError(endpointErr('enterprises/{ent}/installation (no install)', 404))).toBe(false)
  })
  it('false for a raw egress throw / a generic error / null (no envelope to prove the endpoint)', () => {
    expect(isSamlEndpointError(netErr('ECONNREFUSED'))).toBe(false)
    expect(isSamlEndpointError(upstream(403))).toBe(false) // no `type` → unproven
    expect(isSamlEndpointError(null)).toBe(false)
    expect(isSamlEndpointError({})).toBe(false)
  })
})

describe('synthesiseVerdict + colorFor — the vocabulary → color table', () => {
  it('healthy → green', () => {
    expect(colorFor(synthesiseVerdict({ credential: { ok: true }, licenses: { ok: true, count: 3, rosterMatched: 2 }, metrics: { ok: true, recordCount: 3, matchedRecords: 2 } }))).toBe('green')
  })
  it('the incomplete/transient/infra verdicts → amber', () => {
    expect(colorFor('no-teammate-match')).toBe('amber')
    expect(colorFor('metrics-empty')).toBe('amber')
    expect(colorFor('upstream-transient')).toBe('amber')
    expect(colorFor('probe-error')).toBe('amber')
  })
  it('the hard structural breaks → red', () => {
    expect(colorFor('auth-failed')).toBe('red')
    expect(colorFor('egress-blocked')).toBe('red')
    expect(colorFor('not-installed')).toBe('red')
    expect(colorFor('key-malformed')).toBe('red')
    expect(colorFor('no-credential')).toBe('red')
  })
  it('transient reasons synthesise upstream-transient, NOT egress-blocked (H1 / NEW-M1)', () => {
    for (const reason of ['rate-limited', 'not-ready', 'upstream-error', 'probe-window-exceeded'] as const) {
      expect(synthesiseVerdict({ credential: { ok: true }, licenses: { ok: false, reason }, metrics: { ok: false, skipped: true, reason } })).toBe('upstream-transient')
      expect(synthesiseVerdict({ credential: { ok: true }, licenses: { ok: true, count: 1, rosterMatched: 1 }, metrics: { ok: false, reason } })).toBe('upstream-transient')
    }
  })
})

describe('computeGithubEnterpriseHealth — App-mode verdict ladder', () => {
  it('healthy — licenses + metrics ok, records>0, matched>0', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }, { login: 'bob' }],
      getUserDailyCredits: async () => [{ login: 'alice' }, { login: 'bob' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice', 'bob']))
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green', credentialKind: 'github-app', probeDay: '2026-06-28' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 2 })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 2, matchedRecords: 2 })
  })

  it('no-teammate-match — metrics returns records but NONE map to a teammate (empty roster)', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => [{ login: 'alice' }, { login: 'bob' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, [])) // roster empty
    expect(h).toMatchObject({ verdict: 'no-teammate-match', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 2, matchedRecords: 0 })
  })

  it('metrics-empty — metrics ok but zero records', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => [],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'metrics-empty', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 0, matchedRecords: 0 })
  })

  it('upstream-transient AMBER — the metrics report is not ready yet (LITERAL client fail, M1/M5)', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => { throw notReadyErr() },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: false, reason: 'not-ready' })
  })

  it('upstream-transient AMBER — report_day mismatch (LITERAL client fail, M1/M5)', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => { throw reportDayMismatchErr() },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.metrics).toMatchObject({ ok: false, reason: 'not-ready' })
  })

  it('upstream-transient AMBER — 429 rate limit on licenses; metrics SKIPPED (L5), one call only', async () => {
    let licensesCalls = 0
    let metricsCalls = 0
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { licensesCalls++; throw upstream(429) },
      getUserDailyCredits: async () => { metricsCalls++; return [] },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'rate-limited' })
    expect(h.stages.metrics).toMatchObject({ ok: false, skipped: true, reason: 'rate-limited' })
    expect(licensesCalls).toBe(1)
    expect(metricsCalls).toBe(0) // doomed second call never fired
  })

  it('upstream-transient AMBER — a 500 / SyntaxError (HTML page) / ZodError on metrics', async () => {
    for (const err of [upstream(500), new SyntaxError('Unexpected token < in JSON at position 0'), zodErr()]) {
      const client: HealthProbeClient = {
        listSamlIdentities: async () => [{ login: 'alice' }],
        getUserDailyCredits: async () => { throw err },
      }
      const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
      expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
      expect(h.stages.metrics).toMatchObject({ ok: false, reason: 'upstream-error' })
    }
  })

  it('auth-failed on the externalIdentities ENDPOINT (HTTP 403) → appAuth ✓ (org token minted) + org-admin-read hint on licenses', async () => {
    // A non-OK HTTP 403 on the externalIdentities GraphQL POST (github-upstream envelope) proves
    // the ORG installation token WAS minted to reach it, so appAuth is ✓ and the ✗ lands ONLY on
    // licenses — which carries the fixed, actionable "organization_administration: read" hint.
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw endpointErr('graphql externalIdentities', 403) },
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.appAuth?.reason).toBeUndefined()
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
  })

  it('a github-saml FORBIDDEN (GraphQL errors, HTTP 200) → appAuth ✓ (token minted) + auth-failed RED + org-admin-read hint (MEDIUM-1)', async () => {
    // A real org missing organization_administration:read returns a 200 with GraphQL errors
    // (FORBIDDEN) — the client stamps that a github-saml type. That proves the org token minted
    // (appAuth ✓), and it is a PERMISSION gap, so it must classify auth-failed (red, ACTIONABLE)
    // with the org-admin-read hint — the SAME treatment an HTTP 401/403 endpoint denial gets.
    // Retrying never fixes a permission gap, so amber "retry later" (the old behaviour) misled.
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw samlErr(['FORBIDDEN']) },
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.appAuth?.reason).toBeUndefined()
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
    // The metrics stage is NOT skipped for auth-failed (only egress/rate-limit/structural skip),
    // but the verdict is already the early-stage auth-failed break.
  })

  it('a github-saml INSUFFICIENT_SCOPES (HTTP 200) → auth-failed RED + org-admin-read hint (MEDIUM-1)', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw samlErr(['INSUFFICIENT_SCOPES']) },
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
  })

  it('auth-failed in the App-AUTH layer (token mint / install-lookup) → appAuth ✗, NO org-admin-read hint', async () => {
    // A github-app-upstream envelope means the App-auth layer itself failed (bad JWT / App not
    // authorised) — that is NOT an org-admin-read gap, so appAuth is ✗ and licenses carries no hint.
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw appAuthErr('app/installations/{id}/access_tokens', 403) },
      getUserDailyCredits: async () => [],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: false, reason: 'auth-failed' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed' })
    expect(h.stages.licenses.hint).toBeUndefined()
  })

  it('not-installed — a 404 installation lookup (App mode) → appAuth ✗, NO hint', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw upstream(404, 'no install') },
      getUserDailyCredits: async () => [],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client))
    expect(h).toMatchObject({ verdict: 'not-installed', color: 'red' })
    expect(h.stages.appAuth).toMatchObject({ ok: false, reason: 'not-installed' })
    expect(h.stages.licenses.hint).toBeUndefined()
  })

  it('no-license-orgs AMBER — App wired but no license org onboarded (provider_org empty); externalIdentities never called; metrics SKIPPED', async () => {
    let samlCalls = 0
    let metricsCalls = 0
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { samlCalls++; return [{ login: 'alice' }] },
      getUserDailyCredits: async () => { metricsCalls++; return [{ login: 'alice' }] },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, { ...appOpts(client, ['alice']), resolveLicenseOrgs: async () => [] })
    expect(h).toMatchObject({ verdict: 'no-license-orgs', color: 'amber' })
    expect(h.stages.appAuth).toMatchObject({ ok: false, reason: 'no-license-orgs' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'no-license-orgs' })
    expect(h.stages.metrics).toMatchObject({ ok: false, skipped: true, reason: 'no-license-orgs' })
    expect(samlCalls).toBe(0) // no org to read → externalIdentities never called
    expect(metricsCalls).toBe(0) // structural break → metrics skipped, never faked
  })

  it('probe-error AMBER — the provider_org (license-org) read fails → NOT a fabricated pipeline verdict (M3)', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, { ...appOpts(client, ['alice']), resolveLicenseOrgs: async () => { throw new Error('relation does not exist') } })
    expect(h).toMatchObject({ verdict: 'probe-error', color: 'amber' })
    expect(h.stages.appAuth).toMatchObject({ ok: false, reason: 'probe-internal-error' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'probe-internal-error' })
    expect(h.stages.metrics).toMatchObject({ ok: false, skipped: true, reason: 'probe-internal-error' })
  })

  it('representative-org selection — probes the SEAT-BEARING org, not the alphabetically-first empty one (MEDIUM-2)', async () => {
    // Insight-DI-NA-Test sorts first but has NO seats (a test org); zzz-prod has seats + identities.
    // The probe must read zzz-prod's externalIdentities (2 identities), NOT the empty first org —
    // otherwise the licenses stage reads [] and the enterprise-grain metrics can synthesise a false
    // healthy while a real seat-bearing org silently drops.
    const seatsByOrg: Record<string, Array<{ login: string }>> = {
      'insight-di-na-test': [], // no seats
      'zzz-prod': [{ login: 'alice' }],
    }
    const identitiesByOrg: Record<string, Array<{ login: string }>> = {
      'insight-di-na-test': [],
      'zzz-prod': [{ login: 'alice' }, { login: 'bob' }],
    }
    let readOrg: string | undefined
    const client: HealthProbeClient = {
      listOrgCopilotSeats: async (org) => seatsByOrg[org] ?? [],
      listSamlIdentities: async (org) => { readOrg = org; return identitiesByOrg[org] ?? [] },
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, {
      ...appOpts(client, ['alice']),
      resolveLicenseOrgs: async () => ['insight-di-na-test', 'zzz-prod'], // already ORDER BY external_org_id
    })
    expect(readOrg).toBe('zzz-prod') // read the seat-bearing org, NOT the empty first
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 1 }) // zzz-prod's identity count
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green' })
  })

  it('representative-org selection — no org has seats → falls back to the FIRST onboarded org (count-0 still surfaces, MEDIUM-2)', async () => {
    let readOrg: string | undefined
    let seatCalls = 0
    const client: HealthProbeClient = {
      listOrgCopilotSeats: async () => { seatCalls++; return [] }, // none seat-bearing (or none installed)
      listSamlIdentities: async (org) => { readOrg = org; return [] }, // first org reads empty
      getUserDailyCredits: async () => [],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, {
      ...appOpts(client, []),
      resolveLicenseOrgs: async () => ['aaa-first', 'bbb-second'],
    })
    expect(seatCalls).toBe(2) // probed both, found no seats
    expect(readOrg).toBe('aaa-first') // fell back to the first onboarded org
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 0 }) // count-0 surfaces (not masked)
    expect(h).toMatchObject({ verdict: 'metrics-empty', color: 'amber' })
  })

  it('representative-org selection — a seat call that THROWS is skipped; a later seat-bearing org still wins (MEDIUM-2)', async () => {
    // A per-org seat call throwing (e.g. a transient org-scoped error) must NOT abort selection —
    // it is treated as not-confirmed-seat-bearing and the next seat-bearing org is chosen.
    const client: HealthProbeClient = {
      listOrgCopilotSeats: async (org) => { if (org === 'aaa-first') throw new Error('boom'); return [{ login: 'alice' }] },
      listSamlIdentities: async (org) => (org === 'bbb-second' ? [{ login: 'alice' }] : []),
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, {
      ...appOpts(client, ['alice']),
      resolveLicenseOrgs: async () => ['aaa-first', 'bbb-second'],
    })
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 1, rosterMatched: 1 })
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green' })
  })

  it('egress-blocked — ECONNREFUSED on the first authed call; metrics SKIPPED (L5)', async () => {
    let metricsCalls = 0
    const client: HealthProbeClient = {
      listSamlIdentities: async () => { throw netErr('ECONNREFUSED') },
      getUserDailyCredits: async () => { metricsCalls++; return [] },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(client))
    expect(h).toMatchObject({ verdict: 'egress-blocked', color: 'red' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'egress-blocked' })
    expect(h.stages.metrics).toMatchObject({ ok: false, skipped: true, reason: 'egress-blocked' })
    expect(metricsCalls).toBe(0)
  })

  it('probe-window-exceeded AMBER — the stage-deadline BACKSTOP fires (NEW-M1: NOT egress)', async () => {
    // A never-settling client promise hits the 20s backstop (here 30ms). With the tight
    // per-attempt fetch budget, a REAL black hole would have thrown a transport timeout
    // long before — so the backstop must NOT claim egress; it is transient amber.
    const client: HealthProbeClient = {
      listSamlIdentities: () => new Promise(() => {}), // never settles (pathological slowness)
      getUserDailyCredits: async () => [],
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, { ...appOpts(client, ['alice']), stageDeadlineMs: 30 })
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'probe-window-exceeded' })
  })

  it('key-malformed — the client build (GithubAppAuth ctor) throws a github-app-auth error', async () => {
    const opts: ComputeGithubHealthOpts = {
      now: NOW,
      resolveCredential: async () => ({ secretName: 'acme', value: FAKE_SECRET, level: 'enterprise', kind: 'github-app', appId: '4242' }),
      probeClient: () => { throw new Error('github-app-auth: App private key is not valid base64') },
      resolveRoster: async () => new Map(),
      resolveSelfOnly: async () => new Map(),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, opts)
    expect(h).toMatchObject({ verdict: 'key-malformed', color: 'red', keyPresent: true })
    expect(h.stages.credential).toMatchObject({ ok: false, reason: 'key-malformed' })
  })

  it('no-credential — the resolver returns null (nothing wired)', async () => {
    const opts: ComputeGithubHealthOpts = { now: NOW, resolveCredential: async () => null, resolveRoster: async () => new Map(), resolveSelfOnly: async () => new Map() }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, opts)
    expect(h).toMatchObject({ verdict: 'no-credential', color: 'red', keyPresent: false })
  })

  it('no-credential — App mode intended but no key wired (MissingGithubAppKeyError)', async () => {
    const opts: ComputeGithubHealthOpts = {
      now: NOW,
      resolveCredential: async () => { throw new MissingGithubAppKeyError('acme-ent', 'acme') },
      resolveRoster: async () => new Map(),
      resolveSelfOnly: async () => new Map(),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, opts)
    expect(h).toMatchObject({ verdict: 'no-credential', color: 'red' })
  })
})

describe('computeGithubEnterpriseHealth — probe-error (M3: infra must not impersonate verdicts)', () => {
  it('a DB failure in the credential resolver → probe-error, NOT no-credential', async () => {
    const opts: ComputeGithubHealthOpts = {
      now: NOW,
      resolveCredential: async () => { throw new Error('connection terminated unexpectedly') },
      resolveRoster: async () => new Map(),
      resolveSelfOnly: async () => new Map(),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, opts)
    expect(h).toMatchObject({ verdict: 'probe-error', color: 'amber' })
    expect(h.stages.credential).toMatchObject({ ok: false, reason: 'probe-internal-error' })
  })

  it('a roster DB-read failure → probe-error, NOT a fabricated no-teammate-match', async () => {
    const client: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const opts: ComputeGithubHealthOpts = {
      ...appOpts(client, ['alice']),
      resolveRoster: async () => { throw new Error('relation does not exist') },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, opts)
    expect(h).toMatchObject({ verdict: 'probe-error', color: 'amber' })
    expect(h.verdict).not.toBe('no-teammate-match')
    // NEW-L1: the credential DID resolve — the ✗ must land on the later stages, not the
    // credential line.
    expect(h.stages.credential).toMatchObject({ ok: true })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'probe-internal-error' })
  })
})

describe('computeGithubEnterpriseHealth — PAT-mode path', () => {
  it('healthy — seats + a per-login ai_credit/usage read with usage items', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }, { assignee: { login: 'bob' } }],
      getAiCreditUsage: async () => ({ usageItems: [{ grossQuantity: 5 }, { grossQuantity: 2 }] }),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, ['alice', 'bob']))
    expect(h).toMatchObject({ verdict: 'healthy', color: 'green', credentialKind: 'github-pat' })
    expect(h.stages.appAuth).toBeUndefined() // no appAuth stage on the PAT path
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 2 })
    // Honest counts (L2): recordCount = what the read ACTUALLY returned.
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 2, matchedRecords: 2 })
  })

  it('metrics-empty — the probed login had NO usage items that day (honest counts, L2)', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }],
      getAiCreditUsage: async () => ({ usageItems: [] }),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, ['alice']))
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 0, matchedRecords: 0 })
    expect(h.verdict).toBe('metrics-empty')
  })

  it('no-teammate-match — seats present but none map to a teammate; metrics SKIPPED not faked (L2)', async () => {
    let usageCalls = 0
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }, { assignee: { login: 'bob' } }],
      getAiCreditUsage: async () => { usageCalls++; return { usageItems: [] } },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, [])) // empty roster
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 2, rosterMatched: 0 })
    expect(h.stages.metrics).toMatchObject({ ok: true, skipped: true })
    expect(h.stages.metrics.recordCount).toBeUndefined() // never a fabricated read
    expect(usageCalls).toBe(0)
    expect(h.verdict).toBe('no-teammate-match')
    expect(h.color).toBe('amber')
  })

  it('a login bound only by a self-claim is counted apart from the matched ones (#451)', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }, { assignee: { login: 'Bob' } }, { assignee: { login: 'carol' } }],
      getAiCreditUsage: async () => ({ usageItems: [{ grossQuantity: 1 }] }),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, ['alice', 'bob'], ['bob']))
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 3, rosterMatched: 1, selfClaimed: 1 })
    expect(h.verdict).toBe('healthy')
  })

  // "Matched" means verified (#451, #493): with only self-claimed seats the read works but nothing
  // a verified binding attributes, so the probe asks an admin to bind them rather than say healthy.
  it('only self-claimed logins: metrics reads one, matches none, and the verdict says so (#451)', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }],
      getAiCreditUsage: async () => ({ usageItems: [{ grossQuantity: 1 }] }),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, ['alice'], ['alice']))
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 1, rosterMatched: 0, selfClaimed: 1 })
    expect(h.stages.metrics).toMatchObject({ ok: true, recordCount: 1, matchedRecords: 0 })
    expect(h.verdict).toBe('no-teammate-match')
  })

  it('a self-claim DB-read failure → probe-error, NOT a fabricated count (#451)', async () => {
    const client: HealthProbeClient = { listSeats: async () => [{ assignee: { login: 'alice' } }], getAiCreditUsage: async () => ({}) }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, {
      ...patOpts(client, ['alice']),
      resolveSelfOnly: async () => { throw new Error('relation does not exist') },
    })
    expect(h.verdict).toBe('probe-error')
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'probe-internal-error' })
  })

  it('metrics-empty — no seats at all (nothing to attribute)', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [],
      getAiCreditUsage: async () => ({ usageItems: [] }),
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, []))
    expect(h.stages.licenses).toMatchObject({ ok: true, count: 0, rosterMatched: 0 })
    expect(h.verdict).toBe('metrics-empty')
  })

  it('auth-failed — a 403 on listSeats (PAT mode) → NO enterprise-admin hint (different permission)', async () => {
    // Even a REAL github-upstream-typed seats 403 must NOT carry the org-admin-read hint: the hint
    // is App-mode externalIdentities ONLY (PAT seats is a manage_billing/read:enterprise scope).
    const client: HealthProbeClient = { listSeats: async () => { throw endpointErr('enterprises/{ent}/copilot/billing/seats', 403) }, getAiCreditUsage: async () => ({}) }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed' })
    expect(h.stages.licenses.hint).toBeUndefined()
    expect(h.stages.appAuth).toBeUndefined() // no appAuth stage on the PAT path
  })

  it('auth-failed — a PAT-mode 404 (scope/SSO hiding) is NOT "not-installed" (M2/M5)', async () => {
    const client: HealthProbeClient = { listSeats: async () => { throw upstream(404) }, getAiCreditUsage: async () => ({}) }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client))
    expect(h).toMatchObject({ verdict: 'auth-failed', color: 'red' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed' })
  })

  it('egress-blocked — ETIMEDOUT on the ai_credit read after seats matched', async () => {
    const client: HealthProbeClient = {
      listSeats: async () => [{ assignee: { login: 'alice' } }],
      getAiCreditUsage: async () => { throw netErr('ETIMEDOUT') },
    }
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, patOpts(client, ['alice']))
    expect(h).toMatchObject({ verdict: 'egress-blocked', color: 'red' })
    expect(h.stages.metrics).toMatchObject({ ok: false, reason: 'egress-blocked' })
  })
})

describe('tightened probe budget (NEW-M1) — REAL client + stubbed global fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  /** A tight-budget REAL PAT client (short timeout, 0 retries), as the probe factory builds. */
  function tightPatClient(timeoutMs: number): HealthProbeClient {
    return GithubCopilotClient.withPat('acme-pat', 'fake-pat-not-used', { timeoutMs, retries: 0 }) as HealthProbeClient
  }

  it('a 429 with a LONG retry-after surfaces immediately as rate-limited (no retry sleep to race the deadline)', async () => {
    // retry-after 30s: with the default budget resilientFetch would SLEEP toward the
    // retry — racing the 20s stage deadline into a false "egress blocked". With
    // retries: 0 the 429 returns at once and classifies rate-limited → transient amber.
    vi.stubGlobal('fetch', async () => new Response('', { status: 429, headers: { 'retry-after': '30' } }))
    const started = Date.now()
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, {
      ...patOpts(tightPatClient(2_000), ['alice']),
      probeClient: () => tightPatClient(2_000),
    })
    expect(Date.now() - started).toBeLessThan(5_000) // immediate — deadline never in play
    expect(h).toMatchObject({ verdict: 'upstream-transient', color: 'amber' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'rate-limited' }) // NOT probe-window/egress
  })

  it('a black-holed call under the tight budget fails FAST with a transport timeout → egress-blocked RED', async () => {
    // The stub never resolves; it rejects only when resilientFetch's AbortSignal.timeout
    // fires — exactly how undici surfaces a black-holed/silently-dropped connection.
    vi.stubGlobal('fetch', (_url: string, init?: RequestInit) =>
      new Promise((_, reject) => {
        const sig = init?.signal as AbortSignal | undefined
        if (!sig) return
        if (sig.aborted) return reject(sig.reason)
        sig.addEventListener('abort', () => reject(sig.reason))
      }),
    )
    const started = Date.now()
    const h = await computeGithubEnterpriseHealth(fakeDb, PAT_ENT, {
      ...patOpts(tightPatClient(60), ['alice']),
      probeClient: () => tightPatClient(60),
    })
    expect(Date.now() - started).toBeLessThan(5_000) // fast, honest red — not a 504
    expect(h).toMatchObject({ verdict: 'egress-blocked', color: 'red' })
    expect(h.stages.licenses).toMatchObject({ ok: false, reason: 'egress-blocked' })
  })
})

describe('SAFETY — no secret ever leaks into the output', () => {
  it('the App key/PAT value never appears anywhere in the health JSON', async () => {
    const appClient: HealthProbeClient = {
      listSamlIdentities: async () => [{ login: 'alice' }],
      getUserDailyCredits: async () => [{ login: 'alice' }],
    }
    const app = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(appClient, ['alice']))
    expect(JSON.stringify(app)).not.toContain(FAKE_SECRET)

    // Also on the FAILURE path (a thrown upstream error carrying a body-ish string — the
    // users-1-day surface DOES append a sanitized ≤200-char body snippet to detail; it must
    // never be copied into the result).
    const failing: HealthProbeClient = {
      listSamlIdentities: async () => { throw upstream(401, `token=${FAKE_SECRET}`) },
      getUserDailyCredits: async () => [],
    }
    const failed = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(failing, ['alice']))
    expect(failed.verdict).toBe('auth-failed')
    expect(JSON.stringify(failed)).not.toContain(FAKE_SECRET)
  })

  it('the org-admin-read hint is a FIXED enum, never a copy of the upstream body carrying the secret', async () => {
    // An externalIdentities endpoint 403 whose detail carries the secret → hint is set, but only
    // to the closed enum 'org-admin-read-denied'; neither the hint nor the JSON echoes the body.
    const failing: HealthProbeClient = {
      listSamlIdentities: async () => { throw endpointErr('graphql externalIdentities', 403, `token=${FAKE_SECRET}`) },
      getUserDailyCredits: async () => [],
    }
    const failed = await computeGithubEnterpriseHealth(fakeDb, APP_ENT, appOpts(failing, ['alice']))
    expect(failed.stages.appAuth).toMatchObject({ ok: true })
    expect(failed.stages.licenses).toMatchObject({ ok: false, reason: 'auth-failed', hint: 'org-admin-read-denied' })
    expect(failed.stages.licenses.hint).toBe('org-admin-read-denied')
    expect(JSON.stringify(failed)).not.toContain(FAKE_SECRET)
  })
})
