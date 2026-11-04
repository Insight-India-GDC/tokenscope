/*
 * Inbox dispatcher — routes each inbox-item category to the actor who can
 * resolve it. Per docs/build/mvp-lite-epic.md §Epic 3: "Per-actor inbox
 * dispatcher utility (route conflict / alert / action-request → right
 * recipient(s))" and journeys 1 / 4 / 5.
 *
 * The routing rule table is small and code-side rather than DB-side at
 * v1 per data-model.md §inbox_item ("Routing rules are implemented in
 * the notification dispatcher, not stored as a separate table").
 *
 * Each rule is pure: takes the dispatch input + the DB and returns the
 * recipient teammate id(s). Inserts are batched by the caller so callers
 * can dispatch many items in one transaction.
 */
import { consola } from 'consola'
import type { PostgresJsDatabase } from 'drizzle-orm/postgres-js'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../../drizzle/schema'
import { isUuid } from '../utils/uuid'
import { monthStartIso as monthStartIsoFor } from '../utils/period'

export type InboxCategory =
  | 'sync-conflict'
  | 'velocity-warning'
  | 'over-budget'
  | 'untagged-backlog'
  | 'over-attribution' // reconciled-lane otel spend exceeds the authoritative Anthropic actual (forgery/mis-tag backstop)
  | 'reconciliation-gap' // OTel-attributed vs Anthropic-actuals gap exceeds the alert bar (ADR-0005 §4 safety net; the detection-based P2 defense leans on it)
  | 'structural-conflict' // TODO(convergence-followup): no producer wired; schema lacks structural-divergence detection
  | 'connector-health' // PRODUCED by the connector-health worker (owed-bill aging: pending_placement rows un-placed past the grace window); admin-routed
  | 'read-path-stale' // the OTel read path (azure-monitor-read gatherer) has silently stalled/failed while clients still emit (read-path-health worker); admin-routed
  | 'joiner-selection-cap' // the scheduled azure-monitor-read selection matched more joinable devices than its per-run cap, so the surplus went unscanned (azure-monitor-reader's recordJoinerSelectionCap); admin-routed. The EARLY warning: read-path-stale needs the whole reader to stall and attribution-gap needs a device to fall 72h behind, so neither sees a fleet that has simply outgrown the cap
  | 'attribution-gap' // ONE instance is minting ingest credentials (so it is emitting) while its attribution has fallen days behind (attribution-gap worker); admin-routed. read-path-stale gates on FLEET-wide signals and cannot see a single starved instance — the 2026-07-24 dead-zone outage was invisible to every other alarm
  | 'copilot-bill-unsettled' // a Copilot org-month has usage but no read license SKU line (copilot-pool-bill worker) — the month reports unsettled; admin-routed (finance concern)
  | 'copilot-bill-unclassified' // a Copilot org-month booked unclassified SKU spend, or the C1 conservation assertion tripped (copilot-pool-bill worker, mig 0085) — classify the SKU + re-run the month; admin-routed (finance concern)
  | 'project-ending-soon' // D3: a project a dev is tagged to enters its end_date warning window — re-tag ahead
  | 'project-ended-retag' // D2a: a dev's spend spilled to unallocated because the project ended — re-tag the spilled portion
  | 'github-coverage-gap' // a GitHub org transitioned into a non-connected coverage state, or an enterprise lost its census capability (github-coverage-sweep worker); admin-routed — Workstream D, design §6
  | 'over-emission-escalated' // a teammate's over-emission flag was escalated, by them or by the stray-quarantine sweep (notifications/over-emission.ts); admin-routed to the teammate's current region
  | 'personal-subscription-prompt' // settled Claude usage has no provider corroboration; prompt the teammate to declare only when personally funded (ADR-0011 D4)
  | 'project-request' // a teammate asked for a new project; admin-routed to the Business Unit's region (docs/design/project-requests/00-spec.md §3)
  | 'project-request-decided' // the requester's project request was approved or rejected; per-dev (recipientTeammateIdHint)
  | 'quota-request' // a project member asked for more budget (spec §5); routed to the project's current PMs, else the project region's admins. relatedEntity = the project; body.quota_request_id names the request
  | 'quota-request-decided' // the requester's budget request was approved or rejected; per-dev (recipientTeammateIdHint = the requester)
  | 'ops-alert' // A5 inbox parity for an externally-notified ops condition (ops-alert worker); ONE item per condition key (related_entity_kind carries the key), reminders update it in place (docs/design/ops-alerting.md A5, ar-M17); admin-routed

export interface DispatchInput {
  category: InboxCategory
  severity?: 'info' | 'attention' | 'urgent'
  subject: string
  body: Record<string, unknown>
  /**
   * Entity context — required for routing decisions in some categories
   * (e.g. over-budget routes via project → manager).
   */
  relatedEntityKind?: string
  relatedEntityId?: string
  /**
   * Optional explicit recipient hint. When set, bypasses the routing rule
   * (e.g. dispatcher caller already knows the dev for a velocity-warning).
   */
  recipientTeammateIdHint?: string
  /**
   * Time anchor for time-windowed routing (over-budget's current-month
   * contributor set). Workers inject their run `now` so routing agrees
   * with the worker's own window; defaults to wall-clock. Before this
   * existed the dispatcher silently used real `new Date()` while the
   * worker honoured an injected clock — the contributor set could miss
   * the very spend that triggered the alert.
   */
  now?: Date
  /**
   * Region the alert pertains to, used to scope admin-routed categories so a
   * region's own admins only get that region's alerts. Optional: when omitted
   * the dispatcher DERIVES it from relatedEntityKind/relatedEntityId. When
   * neither yields a region, admin alerts route to the unbounded cross-region
   * roles only (never to a sibling region's admins, never dropped).
   */
  regionId?: string
}

export interface DispatchResult {
  inboxItemId: string
  recipientTeammateId: string
}

export async function dispatchInbox(
  db: PostgresJsDatabase<typeof schema>,
  input: DispatchInput,
): Promise<DispatchResult[]> {
  const { recipientIds, routingScope } = await resolveRecipients(db, input)
  if (recipientIds.length === 0) {
    // Caller-facing: no-op rather than throw, so a missing manager (e.g.
    // unassigned project) doesn't crash the worker. But it must not be SILENT —
    // an admin-paging category (read-path-stale, attribution-gap, connector-health)
    // resolving to zero recipients means a deployment with no active
    // platform-admin just dropped an urgent page, and a per-dev
    // category dropped means its producer forgot recipientTeammateIdHint. Both
    // are the silent-no-op class; log so they are diagnosable.
    consola.warn(
      `[dispatch] "${input.category}" resolved to ZERO recipients — inbox item DROPPED (routing=${routingScope ?? 'n/a'}). ` +
        `Admin categories need an active platform-admin; per-dev categories need recipientTeammateIdHint.`,
    )
    return []
  }

  // Stamp the routing decision into the body of admin-routed items (the dispatch
  // path writes no audit row — inbox_item is the artifact). Lets a later
  // debugging session see WHY a recipient set was chosen ('region:<id>' vs the
  // 'fail-open' cross-region-only path) without re-deriving it.
  const body = routingScope ? { ...input.body, routing_scope: routingScope } : input.body

  // inbox_item.related_entity_id is a uuid column — never hand it a non-UUID
  // (a malformed caller value would otherwise abort the whole insert and crash
  // the worker tick). A non-UUID id is dropped to null; the kind is kept for
  // context.
  const relatedEntityId = isUuid(input.relatedEntityId) ? input.relatedEntityId : null

  const rows = await db
    .insert(schema.inboxItem)
    .values(
      recipientIds.map((recipientTeammateId) => ({
        recipientTeammateId,
        category: input.category,
        severity: input.severity ?? defaultSeverity(input.category),
        subject: input.subject,
        body,
        relatedEntityKind: input.relatedEntityKind,
        relatedEntityId,
      })),
    )
    // Category-specific partial unique indexes may suppress the same open
    // transition when two producers race after reading the same prior state.
    // Returning only inserted rows preserves the dispatcher's count contract.
    .onConflictDoNothing()
    .returning({ id: schema.inboxItem.id, recipientTeammateId: schema.inboxItem.recipientTeammateId })

  return rows.map((r) => ({ inboxItemId: r.id, recipientTeammateId: r.recipientTeammateId }))
}

function defaultSeverity(category: InboxCategory): 'info' | 'attention' | 'urgent' {
  switch (category) {
    case 'over-budget':
    case 'sync-conflict':
    case 'structural-conflict':
    case 'over-attribution':
    case 'reconciliation-gap':
    case 'project-ending-soon':
    case 'project-ended-retag':
    case 'over-emission-escalated':
    case 'project-request':
    case 'github-coverage-gap': // per-org gap default; the sweep overrides 'urgent' for a whole-enterprise capability loss
      return 'attention'
    // Silent-attribution failures page like a connector outage, not a nag:
    //  - 'read-path-stale': the whole read path stopped (the 5.5-day incident).
    //  - 'attribution-gap': ONE device is emitting and its spend is going
    //    nowhere — same consequence, scoped to an instance (the 19-day outage).
    case 'connector-health':
    case 'read-path-stale':
    case 'attribution-gap':
    case 'ops-alert': // mirrors a condition that ALSO paged the operator's phone (ops-alerting A5); the worker passes an explicit per-condition severity (critical→urgent, warning→attention) — this default only backstops it
      return 'urgent'
    case 'copilot-bill-unsettled':
    case 'copilot-bill-unclassified':
    case 'joiner-selection-cap': // a CAPACITY warning, not an outage — the joiner sheds least-recently-active first, so a cap hit does not prove any live device stopped attributing, and the one that does still pages urgently as 'attribution-gap'. Pitching it at 'urgent' would page on an often-benign condition (the false-positive machine the old went-silent heuristic was)
      return 'attention'
    case 'quota-request':
      return 'attention'
    case 'quota-request-decided':
    case 'velocity-warning':
    case 'untagged-backlog':
    default:
      return 'info'
  }
}

interface ResolvedRecipients {
  recipientIds: string[]
  /**
   * For admin-routed categories only: the routing decision, stamped into the
   * inbox_item body for traceability. `region:<id>` when scoped to a derived
   * region; `fail-open` when the region was underivable (cross-region roles
   * only). Undefined for non-admin categories (no scoping decision is made).
   */
  routingScope?: string
}

async function resolveRecipients(
  db: PostgresJsDatabase<typeof schema>,
  input: DispatchInput,
): Promise<ResolvedRecipients> {
  if (input.recipientTeammateIdHint) {
    return { recipientIds: [input.recipientTeammateIdHint] }
  }

  switch (input.category) {
    case 'over-budget':
      return { recipientIds: await resolveOverBudgetRecipients(db, input.relatedEntityId, input.now) }
    case 'sync-conflict':
    case 'structural-conflict':
    case 'connector-health':
    case 'copilot-bill-unsettled':
    case 'copilot-bill-unclassified':
    case 'over-emission-escalated':
    case 'project-request': {
      // Admin-routed, region-scoped when derivable (the org's region, passed as input.regionId);
      // otherwise the cross-region finance/ops roles only. A missing-license-SKU month — or an
      // unclassified/conservation-break month (D3) — is a finance data-correctness concern
      // → platform-admin (+ the region's admin).
      const region = await deriveAlertRegion(db, input)
      return {
        recipientIds: await resolveAdmins(db, region),
        routingScope: region ? `region:${region}` : 'fail-open',
      }
    }
    case 'read-path-stale':
    case 'joiner-selection-cap': {
      // The azure-monitor-read gatherer is a GLOBAL, region-agnostic ingestion
      // path — a stall/outage starves EVERY region's attribution, not one
      // region's, and a per-run scan cap is a property of the deployment, not of
      // any region. So these alerts always route to the cross-region ops roles
      // (platform-admin) only, never a single region's admins.
      // No region is derived (there is none to derive).
      return {
        recipientIds: await resolveAdmins(db, null),
        routingScope: 'platform',
      }
    }
    case 'ops-alert':
      // The operations-recipient policy (ops-alerting A5, ar-M18): platform-admin
      // AND platform-admin — an estate without an active platform-admin must not
      // receive nothing. Deployment-level conditions (a dead read path, a failing
      // fleet, a broken private-link route) have no region to derive, so this is
      // always the cross-region set, matching read-path-stale.
      return { recipientIds: await resolveAdmins(db, null), routingScope: 'platform' }
    case 'attribution-gap':
      // Scoped to ONE instance, but the cause is always platform-side (the join
      // path), never something that instance's regional admin can fix — and
      // deriving a region from the instance would split a fleet-wide defect
      // across regional inboxes, hiding the pattern. Route to cross-region ops,
      // matching read-path-stale.
      return { recipientIds: await resolveAdmins(db, null), routingScope: 'platform' }
    case 'github-coverage-gap':
      // A GitHub enterprise/org config gap — enterprises are credential-custody
      // units that can span multiple regions' orgs (region homing is a PER-ORG,
      // downstream concern, not a property of the enterprise itself), so there is
      // no single region to derive. Routes to cross-region ops, matching
      // read-path-stale/attribution-gap — the same "no region to derive" shape.
      return { recipientIds: await resolveAdmins(db, null), routingScope: 'platform' }
    case 'quota-request': {
      // The project's current PMs decide budget requests. A project with no
      // current PM falls back to its region's admins (spec §5, A10); the request
      // stays on the project page's Manage section either way.
      const pms = await resolveProjectManagers(db, input.relatedEntityId, input.now)
      if (pms.length > 0) return { recipientIds: pms }
      const region = await deriveAlertRegion(db, input)
      return {
        recipientIds: await resolveAdmins(db, region),
        routingScope: region ? `region:${region}` : 'fail-open',
      }
    }
    case 'velocity-warning':
    case 'untagged-backlog':
    case 'over-attribution':
    case 'reconciliation-gap':
    case 'project-ending-soon':
    case 'project-ended-retag':
    case 'project-request-decided':
    case 'quota-request-decided':
      // Per-developer notifications — the caller resolves the recipient and
      // passes recipientTeammateIdHint (handled above); no rule-based routing.
      return { recipientIds: [] }
    default:
      return { recipientIds: [] }
  }
}

/** Active teammates holding a currently-effective PM assignment on the project. */
async function resolveProjectManagers(
  db: PostgresJsDatabase<typeof schema>,
  projectId: string | undefined,
  nowAnchor?: Date,
): Promise<string[]> {
  if (!isUuid(projectId)) return []
  const at = (nowAnchor ?? new Date()).toISOString()
  const rows = await db.execute<{ id: string }>(sql`
    SELECT DISTINCT t.id::text AS id
    FROM project_assignment pa
    JOIN teammate t ON t.id = pa.teammate_id
    WHERE pa.project_id = ${projectId}::uuid
      AND pa.role = 'manager'
      AND pa.effective @> ${at}::timestamptz
      AND t.is_active = TRUE
  `)
  return [...rows].map((r) => r.id)
}

async function resolveOverBudgetRecipients(
  db: PostgresJsDatabase<typeof schema>,
  projectId: string | undefined,
  nowAnchor?: Date,
): Promise<string[]> {
  if (!projectId) return []
  /*
   * Over-budget alerts route to two audiences with different jobs:
   *
   * 1. BUDGET-RESPONSIBLE parties (mig 0048): the project's currently-
   *    effective PMs and the lead cost centre's active owners. They can
   *    ACT — the PM passes the allocation editor's relationship gate,
   *    the owner watches the P&L — so the alert's deep links are
   *    honourable for them. A $0-contribution PM still gets the alert:
   *    the budget is their job regardless of their own spend.
   * 2. ACTUAL contributors — teammates who emitted at least one
   *    attribution_record on this project in the current month. For
   *    them it's awareness ("you're spending against an exhausted
   *    budget"); the inbox read path withholds editor links they could
   *    not honour. Sending the alert to a $0 CoU peer instead would be
   *    misleading: their bucket card shows $0 healthy while their inbox
   *    screams over-budget.
   *
   * Fallback: if BOTH sets are empty (newly-created allocation, no
   * PM/owner designated yet), route to the project's CoU teammates so
   * SOMEONE sees the alert — the original pilot rule kept as a net.
   */
  const now = nowAnchor ?? new Date()
  const monthStartIso = monthStartIsoFor(now)

  /*
   * These three branches decide WHO IS RESPONSIBLE. None of them filters on
   * activity, deliberately: activity is applied once, below, after the branches
   * have been combined. Filtering here instead makes an all-inactive branch
   * indistinguishable from an unmatched one and hands the alert to the whole
   * Business Unit via the fallback.
   *
   * `cou_owner.revoked_at` IS right here — it ends a GRANT, which is a question
   * about responsibility. `teammate.revoked_at` would not be: that column is a
   * session anchor, not a deactivation flag (#428).
   * See docs/security-sprint/epic-mdash-remediation.md (W2.4).
   */
  const responsibleRows = await db.execute<{ teammate_id: string }>(sql`
    SELECT pa.teammate_id::text AS teammate_id
    FROM project_assignment pa
    WHERE pa.project_id = ${projectId}::uuid
      AND pa.role = 'manager'
      AND pa.effective @> now()
    UNION
    SELECT co.teammate_id::text AS teammate_id
    FROM cou_owner co
    JOIN project p ON p.cost_owning_unit_id = co.org_unit_id
    WHERE p.id = ${projectId}::uuid
      AND co.revoked_at IS NULL
  `)
  const contributorRows = await db.execute<{ teammate_id: string }>(sql`
    SELECT DISTINCT ar.teammate_id::text AS teammate_id
    -- v_complete_usage, not raw attribution_record: Copilot per-user spend lands
    -- in unaccounted_usage, so the raw table misses Copilot contributors entirely.
    -- budget-alert now TRIGGERS on Copilot-complete spend, so the AUDIENCE must be
    -- complete too — otherwise the Copilot dev who blew the budget is the one
    -- person not told about it.
    FROM v_complete_usage ar
    WHERE ar.project_id = ${projectId}::uuid
      AND ar.ts_event >= ${monthStartIso}::timestamptz
  `)
  /*
   * MATCHED and ACTIVE are separate signals, and conflating them changes who is
   * notified. Filtering inactive people out inside the SQL made an
   * inactive-only contributor set indistinguishable from "no contributors ever
   * existed", so the fallback below fired and told unrelated CoU teammates a
   * project's spend. Match first, then filter: a branch that matched returns its
   * ACTIVE members even when that list is empty.
   */
  const matched = [
    ...new Set([
      ...[...responsibleRows].map((r) => r.teammate_id),
      ...[...contributorRows].map((r) => r.teammate_id),
    ]),
  ]
  if (matched.length > 0) {
    const activeRows = await db.execute<{ id: string }>(sql`
      SELECT id::text AS id FROM teammate
      WHERE id = ANY(${sql.param(matched)}::uuid[]) AND is_active = TRUE
    `)
    return [...activeRows].map((r) => r.id)
  }

  // Fallback to CoU teammates only when there are no responsible
  // parties or contributors at all. Pilot rule preserved.
  const [proj] = await db
    .select({ costOwningUnitId: schema.project.costOwningUnitId })
    .from(schema.project)
    .where(eq(schema.project.id, projectId))
    .limit(1)
  if (!proj) return []
  // Same active-only rule as the branches above (W2.4).
  const rows = await db
    .select({ id: schema.teammate.id })
    .from(schema.teammate)
    .where(and(eq(schema.teammate.orgUnitId, proj.costOwningUnitId), eq(schema.teammate.isActive, true)))
  return rows.map((r) => r.id)
}

async function scalarRegion(
  db: PostgresJsDatabase<typeof schema>,
  query: ReturnType<typeof sql>,
): Promise<string | null> {
  const rows = await db.execute<{ region_id: string | null }>(query)
  return [...rows][0]?.region_id ?? null
}

/**
 * Resolve the region an admin-routed alert pertains to, for region-scoping:
 *   explicit input.regionId  →  the related entity's region  →  null.
 *
 * `relatedEntityKind` for connector alerts is the raw `sync_conflict.target_table`
 * (snake_case), so we key on table names. Returns null on a missing/deleted
 * entity, an unmapped kind, or a non-UUID id — the caller treats null as "route
 * to the unbounded cross-region roles only" (never a sibling region's admins,
 * never dropped). The SELECT also validates the entity exists (a stale conflict
 * pointing at a deleted project → null → fail open), since target_pk carries no
 * FK.
 *
 * KNOWN LIMITATION: a producer with recipient-agnostic idempotency (e.g.
 * connector-health dedups on body->>'sync_conflict_id') freezes the recipient
 * set at first dispatch. So if the region is transiently underivable on the
 * first tick (a conflict that references a not-yet-created project) the region's
 * own admin is not back-filled once the entity appears. The alert is never lost
 * — the cross-region roles always receive it — only the region-admin's copy is
 * missed in that narrow window. Recipient/region-aware dedup is deferred.
 */
async function deriveAlertRegion(
  db: PostgresJsDatabase<typeof schema>,
  input: DispatchInput,
): Promise<string | null> {
  if (isUuid(input.regionId)) return input.regionId
  const id = input.relatedEntityId
  if (!isUuid(id) || !input.relatedEntityKind) return null
  switch (input.relatedEntityKind) {
    case 'project':
      return scalarRegion(db, sql`SELECT region_id::text AS region_id FROM project WHERE id = ${id}::uuid`)
    case 'org_unit':
      return scalarRegion(db, sql`SELECT region_id::text AS region_id FROM org_unit WHERE id = ${id}::uuid`)
    case 'teammate':
      return scalarRegion(db, sql`SELECT region_id::text AS region_id FROM teammate WHERE id = ${id}::uuid`)
    case 'region':
      // Self, but validated so a stale/bogus region id fails open like the rest.
      return scalarRegion(db, sql`SELECT id::text AS region_id FROM region WHERE id = ${id}::uuid`)
    default:
      return null
  }
}

/**
 * Recipients for the admin-routed ops categories (sync-conflict /
 * structural-conflict / connector-health).
 *
 * The cross-region roles — `platform-admin` (ops super-admin) and
 * `platform-admin` — ALWAYS receive these (they answer for every region); a
 * region's own `admin`s are ADDED on top when the alert's region is known.
 * `regionId === null` (underivable) routes to the cross-region roles ONLY: an
 * unscoped ops alert must not leak one region's data (the conflicting project's
 * name etc.) into a sibling region admin's inbox, since the inbox read path is
 * recipient-scoped with no RLS backstop. The cross-region roles are present
 * unconditionally, so a region with no admin still has a recipient — the set is
 * never empty for want of scoping. Inactive teammates are excluded.
 *
 * Scoping key is `teammate.region_id` (home region) — the same key
 * `requireRegionScope` (server/auth/rbac.ts) gates an admin's ACCESS on, so an
 * admin is never alerted about a region they could not open. Multi-region admin
 * coverage (an admin administering a region other than their home) is not
 * expressible in the current model and is deliberately out of scope.
 */
async function resolveAdmins(
  db: PostgresJsDatabase<typeof schema>,
  regionId: string | null,
): Promise<string[]> {
  const rows = await db.execute<{ id: string }>(sql`
    SELECT id::text AS id
    FROM teammate
    WHERE is_active = true
      AND (
        role = 'platform-admin'
        -- region-scoped: when regionId is null, region_id = NULL::uuid is
        -- UNKNOWN (falsy), so no region admin matches -- i.e. cross-region roles
        -- only. No explicit null-guard needed.
        OR (role = 'admin' AND region_id = ${regionId}::uuid)
      )
  `)
  return [...rows].map((r) => r.id)
}
