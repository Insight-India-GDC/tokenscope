/*
 * APAC pilot seed (Wave C).
 *
 * Per docs/build/mvp-lite-epic.md §Epic 2 verifiable end state:
 *   1 region + 1 BU + 3 teams + 6 teammates + 8 projects + 3 allocations + 2 inbox items.
 *
 * MVP-Final convergence (Wave 2a): inbox items are NO LONGER hand-coded
 * here. Instead the seed inserts the underlying preconditions (allocations,
 * attribution_records, sync_conflict rows, actual_spend rows) and at the
 * end runs the producer workers — runBudgetAlert, runVelocityWatch,
 * runConnectorHealth, runReconciliation. The inbox is then derived from
 * the same SQL the read APIs use, so the demo can no longer drift away
 * from the homepage live numbers.
 *
 * Idempotent: deletes pilot rows first (by canonical code where possible),
 * then re-inserts. Safe to re-run on the same dev DB.
 */
import { createHash, randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import { createDbClient } from './connect'
import * as schema from './schema'
import { runBudgetAlert } from '../server/workers/budget-alert'
import { runVelocityWatch } from '../server/workers/velocity-watch'
import { runConnectorHealth } from '../server/workers/connector-health'
import { runReconciliation } from '../server/workers/reconciliation'
import { currentServerDeployEnv, isDemoCapableEnv } from '../shared/env/deploy-env'

async function main() {
  // Demo/pilot seed — refuse on a non-demo-capable env (dev/staging/production/
  // unknown) so demo data can never be injected into a real-user environment.
  // Bare local + CI classify to 'local' (demo-capable) so dev/test seeding works.
  // SEED_FORCE=1 overrides for a deliberate, controlled run.
  const deployEnv = currentServerDeployEnv()
  if (!isDemoCapableEnv(deployEnv) && process.env.SEED_FORCE !== '1') {
    console.error(`Refusing to seed demo data on env='${deployEnv}' (not demo-capable). Set SEED_FORCE=1 to override.`)
    process.exit(1)
  }

  const url = process.env.DATABASE_URL
  if (!url) {
    console.error('DATABASE_URL not set')
    process.exit(1)
  }

  const client = createDbClient(url, { max: 1, idle_timeout: 5 })
  const db = drizzle(client, { schema })

  // Guard the destructive reset path. Default is append-only — running
  // db:seed twice on the same DB will collide on unique constraints
  // (region.code='apac', project.code, etc.), which is loud and safer
  // than silently nuking dev-side rows. SEED_RESET=true explicitly opts
  // into the wipe.
  const reset = process.env.SEED_RESET === 'true'

  try {
    if (reset) {
      console.warn('SEED_RESET=true — wiping pilot tables before re-seed')
      // TRUNCATE ... CASCADE bypasses the audit_event append-only trigger
      // (which only fires on UPDATE/DELETE statements, not TRUNCATE) and
      // cleans up FK dependencies in one shot. Order doesn't matter with
      // CASCADE. Includes audit_event because dev-mode runs (login,
      // attest) accrete rows that reference teammates.
      await client.unsafe(`
        TRUNCATE TABLE
          inbox_item, allocation, project_assignment, attribution_record,
          attribution_aggregate, instance_attestation_health,
          instance_attestation, actual_spend, project, project_lifecycle_policy,
          teammate_identity_map, teammate,
          org_unit, region, audit_event, sync_conflict
        RESTART IDENTITY CASCADE
      `)
    }

    // ── Region: DEMO ─────────────────────────────────────────────────
    // ALL synthetic/fixture data lives in the DEMO region so the real
    // regions (APAC, EMEA, North America — seeded clean below) stay
    // pristine for dogfooding. Demo teammates are tagged demo-*@example.com
    // / "(demo)". This whole dataset is dropped when we move to the corporate
    // Dev environment. See docs/build/dogfood-followups.md.
    const [demoRegion] = await db
      .insert(schema.region)
      .values({ code: 'demo', displayName: 'DEMO' })
      .returning()
    if (!demoRegion) throw new Error('seed: DEMO region insert failed')

    // Platform project-lifecycle policy baseline (D9). Migration 0028 plants this
    // on a fresh DB; re-plant here (idempotently) because SEED_RESET's
    // TRUNCATE … region CASCADE wipes project_lifecycle_policy too. The resolver
    // hard-falls back to {2,7} if it's ever absent, so this is belt-and-braces.
    await db
      .insert(schema.projectLifecyclePolicy)
      .values({ scopeType: 'platform', scopeId: null, graceHours: 2, warnDays: 7 })
      .onConflictDoNothing()

    // ── BU + 3 Teams ─────────────────────────────────────────────────
    // Each practice IS a cost-owning unit alongside the BU. Per
    // docs/design/user-journeys-functional.md §J6 "each cost-owning
    // unit": billable projects roll up to the practice that bears the
    // spend; internal projects roll up to the BU. The finance per-CoU
    // rollup filters `WHERE is_cost_owning_unit = TRUE`, so the BU and
    // all three practices appear as rows. If this changes (e.g. only
    // the BU is a CoU), the finance.get.ts and finance/export.get.ts
    // queries need to switch to a path-roll-up instead of the flag.
    const [bu] = await db
      .insert(schema.orgUnit)
      .values({
        regionId: demoRegion.id,
        path: 'demo.services',
        code: 'services',
        displayName: 'DEMO Services',
        unitType: 'bu',
        isCostOwningUnit: true,
      })
      .returning()
    if (!bu) throw new Error('seed: BU insert failed')

    const teamRows = await db
      .insert(schema.orgUnit)
      .values([
        {
          regionId: demoRegion.id,
          parentId: bu.id,
          path: 'demo.services.delta',
          code: 'delta',
          displayName: 'Practice Delta',
          unitType: 'practice',
          // Practices ARE cost-owning per the design: billable projects
          // hang off a practice and the practice bears the spend. Without
          // this, the finance per-CoU rollup shows only the BU and the
          // billable-project totals are invisible.
          isCostOwningUnit: true,
        },
        {
          regionId: demoRegion.id,
          parentId: bu.id,
          path: 'demo.services.echo',
          code: 'echo',
          displayName: 'Practice Echo',
          unitType: 'practice',
          // Practices ARE cost-owning per the design: billable projects
          // hang off a practice and the practice bears the spend. Without
          // this, the finance per-CoU rollup shows only the BU and the
          // billable-project totals are invisible.
          isCostOwningUnit: true,
        },
        {
          regionId: demoRegion.id,
          parentId: bu.id,
          path: 'demo.services.foxtrot',
          code: 'foxtrot',
          displayName: 'Practice Foxtrot',
          unitType: 'practice',
          // Practices ARE cost-owning per the design: billable projects
          // hang off a practice and the practice bears the spend. Without
          // this, the finance per-CoU rollup shows only the BU and the
          // billable-project totals are invisible.
          isCostOwningUnit: true,
        },
      ])
      .returning()
    const [teamDelta, teamEcho, teamFoxtrot] = teamRows
    if (!teamDelta || !teamEcho || !teamFoxtrot) {
      throw new Error('seed: team insert failed')
    }

    // ── 6 team members + 2 demo-persona teammates (admin + finance) ──
    // Pilot quota is 6 (per docs/build/mvp-lite-epic.md §Epic 2 EVS);
    // the two extras are persona-only and sit on the BU directly so
    // they're orthogonal to team rollups. shared/auth/roles.ts
    // references all 8 by email.
    // Wave-V (R2 F12): each persona's role is set explicitly so the
    // teammate.role column (migration 0005) anchors stop-impersonating's
    // restore path. Defaults map to the PERSONAS table in shared/auth/
    // roles.ts — keep the two in sync.
    const teammateSeeds: Array<{
      email: string
      displayName: string
      teamId: string
      role: string
    }> = [
      { email: 'demo-priya.iyer@example.com', displayName: 'Priya Iyer (demo)', teamId: teamDelta.id, role: 'developer' },
      { email: 'demo-jason.wu@example.com', displayName: 'Jason Wu (demo)', teamId: teamDelta.id, role: 'developer' },
      { email: 'demo-anil.verma@example.com', displayName: 'Anil Verma (demo)', teamId: teamEcho.id, role: 'manager' },
      { email: 'demo-mei.tanaka@example.com', displayName: 'Mei Tanaka (demo)', teamId: teamEcho.id, role: 'developer' },
      { email: 'demo-liam.osullivan@example.com', displayName: "Liam O'Sullivan (demo)", teamId: teamFoxtrot.id, role: 'developer' },
      { email: 'demo-aarti.shah@example.com', displayName: 'Aarti Shah (demo)', teamId: teamFoxtrot.id, role: 'developer' },
      { email: 'demo-lena.park@example.com', displayName: 'Lena Park (demo)', teamId: bu.id, role: 'admin' },
      { email: 'demo-mara.holloway@example.com', displayName: 'Mara Holloway (demo)', teamId: bu.id, role: 'developer' },
      // CC-owner persona (J1, mig 0048): org role is plain DEVELOPER — the
      // P&L visibility comes from cou_owner rows, proving ownership is a
      // relationship, not a role-enum entry.
      { email: 'demo-owen.cole@example.com', displayName: 'Owen Cole (demo)', teamId: bu.id, role: 'developer' },
    ]

    const teammates = await db
      .insert(schema.teammate)
      .values(
        teammateSeeds.map((t) => ({
          entraOid: `oid-${t.email.split('@')[0]}`,
          email: t.email,
          displayName: t.displayName,
          role: t.role,
          regionId: demoRegion.id,
          orgUnitId: t.teamId,
        })),
      )
      .returning()

    // ── 8 projects (2-3 per team) ────────────────────────────────────
    const projectSeeds = [
      { code: 'CSL-AII', displayName: 'Contoso League · AI Insights', cou: teamDelta.id, type: 'billable' },
      { code: 'CSL-DRP', displayName: 'Contoso League · Data Replatform', cou: teamDelta.id, type: 'billable' },
      { code: 'NWB-CIB', displayName: 'Northwind Bank · CIB Modernise', cou: teamEcho.id, type: 'billable' },
      { code: 'NWB-RDM', displayName: 'Northwind Bank · Risk Data Mart', cou: teamEcho.id, type: 'billable' },
      { code: 'WGB-PMG', displayName: 'Woodgrove Bank · Payments Migration', cou: teamFoxtrot.id, type: 'billable' },
      { code: 'WGB-AGT', displayName: 'Woodgrove Bank · Agent Pilot', cou: teamFoxtrot.id, type: 'pursuit' },
      { code: 'INT-PLT', displayName: 'Internal · Platform Team', cou: bu.id, type: 'internal' },
      { code: 'INT-COE', displayName: 'Internal · AI CoE', cou: bu.id, type: 'internal' },
    ]
    const projects = await db
      .insert(schema.project)
      .values(
        projectSeeds.map((p) => ({
          code: p.code,
          codeHash: sha256Hex(p.code),
          displayName: p.displayName,
          type: p.type,
          regionId: demoRegion.id,
          costOwningUnitId: p.cou,
          isAuthorised: true,
          isOnboarded: true,
        })),
      )
      .returning()

    // ── Real top-level regions (clean) ───────────────────────────────
    // APAC / EMEA / North America are seeded EMPTY (region + one default
    // BU each) for dogfooding — a platform-admin assigns region admins who
    // then build out org units / projects / teammates. The default BU
    // exists because (a) JIT teammate creation needs a placement target and
    // (b) a project needs a cost-owning org unit. JIT places new logins in
    // the lexicographically-first region ('apac'), so real sign-ins land in
    // clean APAC, not DEMO. See docs/build/dogfood-followups.md.
    const realRegions = await seedRealRegions(db)
    console.warn(`Real regions seeded clean: ${realRegions.join(', ')}`)

    // provider_org registry (migration 0009) — admin-managed in production; here
    // we seed a couple of indicative rows so the org-lane path is exercisable.
    // NOT in the SEED_RESET truncate list (it's config, not pilot data), so this
    // is idempotent + survives reseeds. Reconciled orgs (with KV admin keys) are
    // added by an admin. See docs/design/client-attribution-auth-spec.md §2.1.
    // NOTE: anthropic rows MUST carry a valid api_kind (mig 0063 CHECK) — an INSERT
    // without it violates the constraint on a fresh DB. The demo org is telemetry-only
    // (no key, never polled), so 'claude-code-admin' is inert here (matches the
    // migration's conservative backfill default). github rows carry NO api_kind.
    // CANONICAL CASING (mig 0064): external_org_id MUST be lowercase (CHECK-
    // constrained, mirrors the enterprise key in 0062) — the github org slug is
    // lowercased ('acme-appdev'); display_name stays pretty. The
    // conflict target matches the expression index (provider, lower(external_org_id)).
    await client.unsafe(`
      INSERT INTO provider_org (provider, external_org_id, display_name, reconciliation_mode, billing, api_kind, notes)
      VALUES
        ('anthropic', '6591f783-f5bc-43b1-b680-ec53a33b236c', 'Demo (Claude org)', 'indicative', 'tracked', 'claude-code-admin',
         'Telemetry-only demo org — no admin key, excluded from reconciliation.'),
        ('github', 'acme-appdev', 'Acme AppDev (GitHub)', 'indicative', 'tracked', NULL,
         'Example of the ~11 Insight GitHub orgs; reconciled once a usage token is registered.')
      ON CONFLICT (provider, (lower(external_org_id))) DO NOTHING
    `)

    // REAL org/enterprise onboarding is done via the ADMIN UI — Admin → Reconciliation →
    // Providers (POST /api/v1/admin/reconciliation/{orgs,enterprises}, with the Anthropic
    // org-id discover flow) — NOT seed templates. The rows here are DEMO fixtures only.

    // provider_enterprise registry (migration 0038, two-level lane) — the GitHub
    // credential-custody grain (one manage_billing PAT reads every child org). The
    // partner-demo enterprise is RECONCILED: reconciliation-sync + identity-sync pick
    // it up and resolve its credential via credential_secret_name='partner-demo' ->
    // env NUXT_GITHUB_PAT_PARTNER_DEMO (KV ref in sandbox). Its license orgs are all
    // NFR demos, so the adapter classes their spend `indicative` (not finance-reportable).
    // Config row (not pilot data) — idempotent; DO UPDATE keeps mode/credential current.
    //
    // CANONICAL CASING (P1-7 / mig 0062): external_id MUST be lowercase — the
    // onboarding boundary. It is CHECK-constrained lowercase, and provider_enterprise_unique
    // is now the expression index (provider, lower(external_id)); the conflict target
    // must match that expression, hence `(provider, (lower(external_id)))`.
    await client.unsafe(`
      INSERT INTO provider_enterprise (provider, external_id, display_name, reconciliation_mode, billing, credential_secret_name, notes)
      VALUES
        ('github', 'acme-partner-demo', 'Acme Partner Demo (GitHub Enterprise)', 'reconciled', 'tracked', 'partner-demo',
         'NFR/demo enterprise; Copilot AI-credit reconciliation via the manage_billing PAT. Spend is indicative (demo orgs).')
      ON CONFLICT (provider, (lower(external_id))) DO UPDATE SET
        display_name = EXCLUDED.display_name,
        reconciliation_mode = EXCLUDED.reconciliation_mode,
        billing = EXCLUDED.billing,
        credential_secret_name = EXCLUDED.credential_secret_name,
        notes = EXCLUDED.notes
    `)

    // (Additional enterprises/orgs — production GitHub enterprises, real Anthropic orgs —
    // are onboarded via the admin UI, NOT seed templates. See Admin → Reconciliation →
    // Providers and docs/build/copilot-multi-org-onboarding.md for the operator runbook.)

    // Rate cards: migration 0004_default_rate_card.sql owns the
    // canonical anthropic:claude-code card, but the TRUNCATE … CASCADE above
    // wipes it via the teammate→rate_card FK chain. Re-insert with the same ID
    // as migration 0004 (mirrored verbatim) so ON CONFLICT DO NOTHING keeps
    // append-mode runs idempotent.
    // NOTE: github:copilot-cli does NOT use a rate card (cost = AI-credit
    // constant per COPILOT_AI_CREDIT_USD in azure-monitor-reader.ts, mig 0036).
    // Emitter unit names must match these rate_line entries
    // ('input', 'output', 'cache-read', 'cache-write') — the joiner does
    // exact-string filter.
    await client.unsafe(`
      INSERT INTO rate_card (id, scope_key, effective, basis, provenance, version)
      VALUES
        ('90000000-0000-4000-8000-000000000001', 'anthropic:claude-code',
         '[2026-01-01, 2099-01-01)'::tstzrange, 'list',
         '{"source": "pilot-placeholder"}'::jsonb, 1)
      ON CONFLICT DO NOTHING;

      INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model, notes)
      VALUES
        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 3.00,  NULL, 'Sonnet input placeholder'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 15.00, NULL, 'Sonnet output placeholder'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.30,  NULL, 'placeholder'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 3.75,  NULL, 'placeholder')
      ON CONFLICT DO NOTHING;

      -- Model-specific rate lines (mirror of migration 0061): correct Anthropic
      -- public list prices as of 2026-06 (per 1M tokens). Without these, every
      -- model falls back to the wildcard (model = NULL) SONNET placeholders above
      -- and is mis-costed (e.g. claude-opus-4-8 priced at Sonnet rates). The
      -- wildcard rows stay as the fallback for unknown future models. cache-read =
      -- 0.1× input; cache-write = 1.25× input (5-minute TTL basis).
      INSERT INTO rate_line (rate_card_id, unit, unit_qty, unit_cost_usd, model, notes)
      VALUES
        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-8', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-8', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-8', 'Opus 4.x — 0.1× input'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-8', 'Opus 4.x — 1.25× input (5m TTL)'),

        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-7', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-7', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-7', 'Opus 4.x — 0.1× input'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-7', 'Opus 4.x — 1.25× input (5m TTL)'),

        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 5.00,  'claude-opus-4-6', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 25.00, 'claude-opus-4-6', 'Opus 4.x list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.50,  'claude-opus-4-6', 'Opus 4.x — 0.1× input'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 6.25,  'claude-opus-4-6', 'Opus 4.x — 1.25× input (5m TTL)'),

        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 3.00,  'claude-sonnet-4-6', 'Sonnet 4.6 list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 15.00, 'claude-sonnet-4-6', 'Sonnet 4.6 list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.30,  'claude-sonnet-4-6', 'Sonnet 4.6 — 0.1× input'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 3.75,  'claude-sonnet-4-6', 'Sonnet 4.6 — 1.25× input (5m TTL)'),

        ('90000000-0000-4000-8000-000000000001', 'input',       1000000, 1.00,  'claude-haiku-4-5', 'Haiku 4.5 list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'output',      1000000, 5.00,  'claude-haiku-4-5', 'Haiku 4.5 list — 2026-06'),
        ('90000000-0000-4000-8000-000000000001', 'cache-read',  1000000, 0.10,  'claude-haiku-4-5', 'Haiku 4.5 — 0.1× input'),
        ('90000000-0000-4000-8000-000000000001', 'cache-write', 1000000, 1.25,  'claude-haiku-4-5', 'Haiku 4.5 — 1.25× input (5m TTL)')
      ON CONFLICT DO NOTHING;
    `)

    // Governance dials: migrations 0049, 0112 and 0164 own the canonical platform
    // rows, but SEED_RESET's TRUNCATE … CASCADE wipes them via the teammate→
    // governance_setting(updated_by) FK chain — same trap as rate_card above.
    // The resolver (server/utils/governance-settings.ts) has NO fallback: a
    // missing platform key 500s every reader (org-units, velocity-watch, the
    // reconciliation engine). Re-insert the platform defaults verbatim (values
    // MUST mirror 0049 + 0112 + 0164); the partial-unique platform index makes
    // ON CONFLICT DO NOTHING safe for append-mode runs.
    await client.unsafe(`
      INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric)
      VALUES
        ('velocity.spike_threshold',        'platform', NULL, 0.25),
        ('reconciliation.gap_threshold',    'platform', NULL, 0.1),
        ('reconciliation.epsilon_usd',      'platform', NULL, 0.01),
        ('reconciliation.lag_buffer_hours', 'platform', NULL, 48),
        ('placement.default_unit_warn_threshold', 'platform', NULL, 20),
        ('projects.pm_own_region_only',     'platform', NULL, 0)
      ON CONFLICT DO NOTHING
    `)

    // Governance cutover singleton (id = 1): migration 0104 seeds it, but the
    // same TRUNCATE … CASCADE wipes it via its *_by → teammate FKs, and
    // server/governance/cutover.ts throws on an absent row (every
    // governance-cutover endpoint and the provider_org billing-edit lock 500).
    // Mirrors 0104's INSERT; the PK makes ON CONFLICT DO NOTHING safe.
    await client.unsafe(`
      INSERT INTO governance_cutover_state (id, status) VALUES (1, 'not_started')
      ON CONFLICT DO NOTHING
    `)

    // ── Project assignments (developer-to-project membership) ───────
    // Per docs/build/mvp-lite-epic.md §Epic 5: the per-actor "your
    // projects" bucket grid is driven by project_assignment. Without
    // these rows the developer landing shows the "ask your admin to
    // assign you" empty state, which masks the entire month-to-date
    // bucket UX.
    const assignmentSeeds: Array<{ projectCode: string; email: string; role?: 'manager' | 'member' }> = [
      // Priya (developer persona) — both Delta projects, so the bucket
      // grid renders two cards on first login. PM of CSL-AII (J2): a
      // developer-role PM proves budget authority flows from the
      // assignment role, not the org role.
      { projectCode: 'CSL-AII', email: 'demo-priya.iyer@example.com', role: 'manager' },
      { projectCode: 'CSL-DRP', email: 'demo-priya.iyer@example.com' },
      { projectCode: 'INT-PLT', email: 'demo-priya.iyer@example.com' },
      // Jason — second pair on Delta.
      { projectCode: 'CSL-AII', email: 'demo-jason.wu@example.com' },
      { projectCode: 'CSL-DRP', email: 'demo-jason.wu@example.com' },
      // Anil (manager persona) + Mei — both Echo projects.
      { projectCode: 'NWB-CIB', email: 'demo-anil.verma@example.com' },
      { projectCode: 'NWB-RDM', email: 'demo-anil.verma@example.com' },
      { projectCode: 'NWB-CIB', email: 'demo-mei.tanaka@example.com' },
      // Foxtrot pair.
      { projectCode: 'WGB-PMG', email: 'demo-liam.osullivan@example.com' },
      { projectCode: 'WGB-AGT', email: 'demo-aarti.shah@example.com' },
    ]
    const projectByCode = new Map(projects.map((p) => [p.code, p]))
    const teammateByEmail = new Map(teammates.map((t) => [t.email, t]))
    const assignmentRows = assignmentSeeds
      .map((a) => {
        const proj = projectByCode.get(a.projectCode)
        const tm = teammateByEmail.get(a.email)
        if (!proj || !tm) return null
        return {
          projectId: proj.id,
          teammateId: tm.id,
          // Open-ended membership starting 60 days ago — usage.get.ts
          // filters on `lower(effective) <= monthStart` so the window
          // must straddle the first of this month.
          effective: '[2026-03-01T00:00:00+00,)',
          role: a.role ?? 'member',
          source: 'seed',
          isPinned: true,
        }
      })
      .filter((r): r is NonNullable<typeof r> => r !== null)
    await db.insert(schema.projectAssignment).values(assignmentRows)

    // ── CC ownership (J1, mig 0048) ──────────────────────────────────
    // Owen owns Practices Delta + Echo: multi-CC ownership, cross-CC
    // project membership visible from his "My cost centres" view (Delta's
    // CSL-AII has members from Delta; Echo's NWB-CIB from Echo).
    const owen = teammateByEmail.get('demo-owen.cole@example.com')
    if (owen) {
      await db.insert(schema.couOwner).values([
        { orgUnitId: teamDelta.id, teammateId: owen.id },
        { orgUnitId: teamEcho.id, teammateId: owen.id },
      ])
    }

    // ── Report-access grants (mig 0129) ──────────────────────────────
    // Roles no longer confer elevated report access on their own, which is the
    // whole reason `global-finops` could be retired. Mara is a plain DEVELOPER
    // and needs BOTH permissions, or her landing (/reporting?scope=finance)
    // opens on a baseline 403 instead of real data — she is the demo of exactly
    // that: the company-wide finance lens delivered by grants, administering
    // nothing. (She was briefly seeded as platform-admin when the role was
    // retired, which turned the finance persona into the org-wide super-admin.)
    // Lena (region admin) gets NOTHING — standard-mode parity: `admin` never
    // held elevation, grant or no grant.
    const mara = teammateByEmail.get('demo-mara.holloway@example.com')
    if (mara) {
      await db.insert(schema.reportAccessGrant).values([
        { teammateId: mara.id, permission: 'operational', grantedBy: null },
        { teammateId: mara.id, permission: 'finance', grantedBy: null },
      ])
    }

    // ── Allocations ──────────────────────────────────────────────────
    // Need a synthetic audit_event for the FK — write three events first.
    const [allocEvent1, allocEvent2, allocEvent3] = await db
      .insert(schema.auditEvent)
      .values([
        { eventType: 'allocation-created', actorSystem: 'seed', payload: { note: 'seed' } },
        { eventType: 'allocation-created', actorSystem: 'seed', payload: { note: 'seed' } },
        { eventType: 'allocation-created', actorSystem: 'seed', payload: { note: 'seed' } },
      ])
      .returning()
    if (!allocEvent1 || !allocEvent2 || !allocEvent3) {
      throw new Error('seed: allocation audit-event insert failed')
    }

    const [proj1, proj2, proj3] = projects
    if (!proj1 || !proj2 || !proj3) throw new Error('seed: project rows missing')

    // J5: CSL-AII also gets a CURRENT-month baseline so the PM journey
    // (viewer.budget_allocation_id → /allocations/{id} editor) and the
    // allocation bars have a live budget. Derive the range from the real clock:
    // a hard-coded "current" month silently expires and makes the E2E fixture
    // report "no budget" when the calendar rolls.
    const now = new Date()
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1))
    const nextMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
    const currentMonthEffective = `[${monthStart.toISOString()},${nextMonthStart.toISOString()})`
    const [allocEvent4] = await db
      .insert(schema.auditEvent)
      .values([{ eventType: 'allocation-created', actorSystem: 'seed', payload: { note: 'seed-current' } }])
      .returning()
    if (!allocEvent4) throw new Error('seed: allocation audit-event insert failed')

    await db.insert(schema.allocation).values([
      {
        scopeType: 'project',
        scopeId: proj1.id,
        budgetUsd: '12500.00',
        effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
        allocationKind: 'baseline',
        auditEventId: allocEvent1.id,
      },
      {
        scopeType: 'project',
        scopeId: proj1.id,
        budgetUsd: '12500.00',
        effective: currentMonthEffective,
        allocationKind: 'baseline',
        auditEventId: allocEvent4.id,
      },
      {
        scopeType: 'project',
        scopeId: proj2.id,
        budgetUsd: '4200.00',
        effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
        allocationKind: 'baseline',
        auditEventId: allocEvent2.id,
      },
      {
        scopeType: 'project',
        scopeId: proj3.id,
        budgetUsd: '8800.00',
        effective: '[2026-05-01T00:00:00+00,2026-06-01T00:00:00+00)',
        allocationKind: 'baseline',
        auditEventId: allocEvent3.id,
      },
    ])

    // ── Producer preconditions ───────────────────────────────────────
    // Wave 2a: inbox items are now derived from real data. The seed
    // emits the attribution_record / sync_conflict / actual_spend rows
    // that TRIGGER each producer; the producers run at the end of
    // main() and write the inbox_item rows themselves. This removes the
    // class of bug where the inbox claims numbers that contradict the
    // homepage SQL.
    const priya = teammates.find((t) => t.email === 'demo-priya.iyer@example.com')
    const anil = teammates.find((t) => t.email === 'demo-anil.verma@example.com')
    if (!priya || !anil) throw new Error('seed: producer-input teammates missing')

    // The default rate_card from migration 0004 (anthropic:claude-code).
    // attribution_record requires rate_card_id + version; we pin to the
    // anthropic card so the rate-line join lines up. Version=1 matches
    // the migration.
    const ANTHROPIC_RATE_CARD_ID = '90000000-0000-4000-8000-000000000001'
    const RATE_CARD_VERSION = 1

    // Anchor the producer-input dates to the current real-clock month
    // and ISO-week. The producer workers use `new Date()` internally;
    // matching that here keeps the seed honest — change the clock and
    // the demo data still satisfies the producer thresholds.
    const currentWeekStart = isoWeekStartUtc(now)

    // Priya's 5-week velocity ramp on CSL-DRP — 4 prior weeks of ~$100
    // each + a current-week spike to ~$145. Delta ≈ +45 % → over the
    // velocity-watch threshold (25 %), so runVelocityWatch will emit a
    // velocity-warning to priya. CSL-DRP cap = $4,200 so this is well
    // under-budget on its own.
    const priyaVelocityEvents: Array<{ when: Date; cost: number }> = [
      { when: addDaysUtc(addWeeksUtc(currentWeekStart, -4), 2), cost: 98 },
      { when: addDaysUtc(addWeeksUtc(currentWeekStart, -3), 2), cost: 96 },
      { when: addDaysUtc(addWeeksUtc(currentWeekStart, -2), 2), cost: 110 },
      { when: addDaysUtc(addWeeksUtc(currentWeekStart, -1), 2), cost: 105 },
      { when: addDaysUtc(currentWeekStart, 2), cost: 145 },
    ]
    for (const ev of priyaVelocityEvents) {
      await insertSpendRecord(db, {
        teammate: priya,
        project: proj2, // CSL-DRP
        regionId: demoRegion.id,
        orgUnitId: teamDelta.id,
        costOwningUnitId: teamDelta.id,
        rateCardId: ANTHROPIC_RATE_CARD_ID,
        rateCardVersion: RATE_CARD_VERSION,
        costUsd: ev.cost,
        tsEvent: ev.when,
      })
    }

    // Anil's CSL-AII spike — single concentrated event in the current
    // month that pushes CSL-AII over its $12,500 cap by $210. The
    // over-budget producer fires for CSL-AII; the dispatcher's
    // contributor-first rule routes the alert to anil (the actual
    // contributor) and NOT to priya, so:
    //   - priya (developer persona) sees CSL-DRP $456 healthy + her
    //     velocity-warning + her untagged-backlog. NO over-budget item.
    //   - anil (manager persona) sees the CSL-AII over-budget item.
    //     He's a manager who occasionally codes; his contribution
    //     dominated CSL-AII this month, so he's the right recipient.
    //
    // Anil has no prior weekly attribution, so velocity-watch's "needs
    // 4 prior populated weeks" guard means he does NOT also receive a
    // velocity-warning — keeping the demo's category-per-persona
    // narrative clean.
    await insertSpendRecord(db, {
      teammate: anil,
      project: proj1, // CSL-AII
      regionId: demoRegion.id,
      // anil's home org_unit is teamEcho; for THIS particular spend
      // record we attribute it under the project's CoU (teamDelta).
      // Cross-team contribution is allowed by the data model — anil
      // is the person, teamDelta is where this work was booked.
      orgUnitId: teamDelta.id,
      costOwningUnitId: teamDelta.id,
      rateCardId: ANTHROPIC_RATE_CARD_ID,
      rateCardVersion: RATE_CARD_VERSION,
      costUsd: 12710,
      // Mid-current-week so it's unambiguously in the current ISO week
      // but also unambiguously >= monthStart (May 1) for budget-alert.
      tsEvent: latestOf(addDaysUtc(currentWeekStart, 1), addDaysUtc(monthStart, 1)),
    })

    // Connector-health source — one pending sync_conflict on proj3
    // (NWB-CIB). runConnectorHealth picks it up and dispatches a
    // sync-conflict inbox item to admins (lena.park per dispatch rule).
    await db.insert(schema.syncConflict).values({
      connectorId: 'Pathway · APAC',
      targetTable: 'project',
      targetPk: proj3.id,
      manualRowSnapshot: { costOwningUnit: 'MED · Retail risk' },
      syncRowPayload: { costOwningUnit: 'MED · Risk Analytics' },
      resolution: 'pending',
    })

    // Reconciliation source — give priya actual_spend rows whose total
    // is > 10 % above her OTel attribution total ($554 from the velocity
    // ramp; the CSL-AII spike now lives on jason). Picking $700 →
    // gap ≈ 21 %, well over the 10 % threshold. runReconciliation
    // dispatches an untagged-backlog info item to priya. Source defaults
    // to 'anthropic-analytics-api' (the reconciliation worker filters
    // on that source).
    const reconDates = [
      addDaysUtc(monthStart, 4),
      addDaysUtc(monthStart, 10),
      addDaysUtc(monthStart, 16),
      addDaysUtc(monthStart, 22),
    ]
    const reconAmounts = [200, 180, 175, 145] // sums to $700
    await db.insert(schema.actualSpend).values(
      reconDates.map((d, i) => ({
        teammateId: priya.id,
        date: d.toISOString().slice(0, 10),
        tool: 'claude-code',
        inputTokens: 50_000n,
        outputTokens: 12_000n,
        costUsd: reconAmounts[i]!.toFixed(6),
      })),
    )

    // ── Producer pass ────────────────────────────────────────────────
    // After all seed inserts, run the four producers so the demo inbox
    // is derived from the same SQL the live UI uses. Any divergence
    // between these two surfaces is now a bug, not a discrepancy by
    // design.
    const budgetResult = await runBudgetAlert(db)
    const velocityResult = await runVelocityWatch(db)
    const connectorResult = await runConnectorHealth(db)
    const reconResult = await runReconciliation(db)

    const inboxCountRows = (await client.unsafe(`
      SELECT COUNT(*)::text AS inbox_count FROM inbox_item
    `)) as Array<{ inbox_count: string }>
    const inboxCount = inboxCountRows[0]?.inbox_count ?? '0'

    // Status output to stdout; warn is reserved for actual warnings so
    // operator log monitors that page on warn-level don't flag these.
    process.stdout.write(
      `Seed complete: 1 region + 1 BU + ${teamRows.length} teams + ${teammates.length} teammates (incl. 2 demo personas) + ${projects.length} projects + 3 allocations\n`,
    )
    process.stdout.write(
      `Producer pass: budget-alert dispatched=${budgetResult.alertsDispatched}, ` +
        `velocity-watch dispatched=${velocityResult.alertsDispatched}, ` +
        `connector-health dispatched=${connectorResult.alertsDispatched}, ` +
        `reconciliation flagged=${reconResult.gapsFlagged} → ${inboxCount} inbox_item rows\n`,
    )
  } finally {
    await client.end({ timeout: 5 })
  }
}

interface SpendRecordInput {
  teammate: { id: string; email: string }
  project: { id: string; code: string }
  regionId: string
  orgUnitId: string
  costOwningUnitId: string
  rateCardId: string
  rateCardVersion: number
  costUsd: number
  tsEvent: Date
}

async function insertSpendRecord(
  db: ReturnType<typeof drizzle<typeof schema>>,
  input: SpendRecordInput,
): Promise<void> {
  // attribution_record requires a parent instance_attestation; create
  // one per emit so the row chain is consistent. session_token_hash
  // must be unique — use a per-call random suffix.
  const instanceId = randomUUID()
  const tokenHash = createHash('sha256')
    .update(`${input.teammate.email}:${input.project.code}:${instanceId}`)
    .digest('hex')
  await db.insert(schema.instanceAttestation).values({
    instanceId,
    principalOid: `oid-${input.teammate.email.split('@')[0]}`,
    principalEmail: input.teammate.email,
    teammateId: input.teammate.id,
    projectCodeHash: sha256Hex(input.project.code),
    rawProjectCode: input.project.code,
    tool: 'claude-code',
    sessionTokenHash: tokenHash,
    tsStart: input.tsEvent,
    regionId: input.regionId,
    orgUnitId: input.orgUnitId,
    costOwningUnitId: input.costOwningUnitId,
  })
  await db.insert(schema.attributionRecord).values({
    instanceId,
    teammateId: input.teammate.id,
    projectId: input.project.id,
    regionId: input.regionId,
    orgUnitId: input.orgUnitId,
    costOwningUnitId: input.costOwningUnitId,
    tool: 'claude-code',
    model: 'claude-opus-4-1',
    tokenType: 'output',
    tokens: 1000n,
    costUsd: input.costUsd.toFixed(6),
    rateCardId: input.rateCardId,
    rateCardVersion: input.rateCardVersion,
    // Joiner vocabulary (azure-monitor-reader.ts): tier-1/estimated is the
    // rate-card-priced primary class. Seed rows previously used the
    // out-of-vocabulary 'baseline'/'rate-card', which made the finance
    // attribution_pct read 0 against seeded data (sprint design §3.5).
    fidelityTier: 'tier-1',
    costBasis: 'estimated',
    tsEvent: input.tsEvent,
  })
}

function isoWeekStartUtc(d: Date): Date {
  const day = d.getUTCDay()
  const offset = (day + 6) % 7
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - offset, 0, 0, 0, 0),
  )
}

function addWeeksUtc(d: Date, weeks: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 7 * weeks, 0, 0, 0, 0),
  )
}

function addDaysUtc(d: Date, days: number): Date {
  return new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + days, 12, 0, 0, 0),
  )
}

function latestOf(a: Date, b: Date): Date {
  return a.getTime() >= b.getTime() ? a : b
}

function sha256Hex(input: string): string {
  // Lightweight in-process hash; not security-sensitive here (seed only).
  // Real attestation uses HMAC-SHA-256 with a Key-Vault-stored key per
  // data-model.md Q-DM-1.
  return createHash('sha256').update(input).digest('hex')
}

/* EMEA-region enrichment (Epic 13). */

interface DrizzleLike {
  insert: (table: unknown) => {
    values: (rows: unknown) => { returning: () => Promise<Array<{ id: string }>> }
  }
}

// Seed the real top-level regions EMPTY: region + one default cost-owning BU
// each. The BU exists so JIT placement has a target and a region admin can
// create a project (needs a cost-owning org unit) before building the real
// tree. ltree paths use '_' (hyphens are illegal ltree labels), region codes
// keep their hyphens. Add more regions here as they come online (until the
// region-create UI lands — docs/build/dogfood-followups.md).
async function seedRealRegions(db: DrizzleLike): Promise<string[]> {
  const dbA = db as unknown as {
    insert: (table: unknown) => {
      values: (rows: unknown) => { returning: () => Promise<Array<{ id: string }>> }
    }
  }
  const regions = [
    { code: 'apac', displayName: 'APAC' },
    { code: 'emea', displayName: 'EMEA' },
    { code: 'north-america', displayName: 'North America' },
  ]
  const seeded: string[] = []
  for (const r of regions) {
    const [region] = await dbA
      .insert(schema.region)
      .values({ code: r.code, displayName: r.displayName })
      .returning()
    if (!region) throw new Error(`seed: ${r.code} region insert failed`)
    await dbA
      .insert(schema.orgUnit)
      .values({
        regionId: region.id,
        path: r.code.replace(/-/g, '_'),
        code: 'default',
        displayName: `${r.displayName} (default)`,
        unitType: 'bu',
        isCostOwningUnit: true,
      })
      .returning()
    seeded.push(r.displayName)
  }
  return seeded
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
