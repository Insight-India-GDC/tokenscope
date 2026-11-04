-- 0162 — the current-org lens: reports group a person's usage by where they sit NOW.
--
-- docs/design/current-org-lens/00-design.md §3.1 / §3.3. Owner ruling 2026-10-23:
-- every report groups and scopes a person's usage by teammate.region_id /
-- teammate.org_unit_id at read time, and their Business Unit is the nearest live
-- cost-owning ancestor of that unit (v_org_unit_cost_owner). The placement stamped
-- on each row at ingest stays as that row's recorded placement; these views do not
-- read it for anyone who has a teammate row.
--
-- Three views, one per source a report groups or scopes by placement. Each
-- projects its source's columns unchanged except the three placement columns:
--
--   region_id           := t.region_id
--   org_unit_id         := t.org_unit_id
--   cost_owning_unit_id := the PERSON's current Business Unit, but ONLY on rows
--                          whose cost_owning_unit_id is the person's:
--     usage_provenance 'otel-emitted'   (arm 1)  — attribution_record's column is
--                                                  the PROJECT's Business Unit
--                                                  (Migrate's axis): unchanged.
--     usage_provenance 'api-reconciled' (arms 2a/2b) — NULL by construction:
--                                                  unchanged.
--     usage_provenance 'provider-usage' (arms 3a/3b) — the person's stamped unit:
--                                                  replaced by the current one.
--   On provider_usage_fact the column is always the person's (0118), so it is
--   replaced on every row with a teammate.
--
-- A row with no teammate keeps its stamped columns (LEFT JOIN + CASE on t.id).
-- §A sources carry a NOT NULL teammate_id, so on those two views this is defence;
-- provider_usage_fact carries unresolved actors (NULL teammate) on purpose and
-- they keep their NULL homing. A teammate whose unit has no live cost-owning
-- ancestor gets a NULL Business Unit, never a parent's (v_org_unit_cost_owner is
-- total and returns NULL there).
--
-- LEFT JOINs on unique keys (teammate.id; v_org_unit_cost_owner is DISTINCT ON
-- org_unit_id) so a reader that never touches the placement columns pays nothing:
-- the planner removes an unreferenced LEFT JOIN to a provably unique relation.
--
-- security_invoker = true, as every v_* view: the caller's RLS on the base tables
-- applies, not the view owner's.

CREATE VIEW v_usage_rollup_current WITH (security_invoker = true) AS
SELECT u.id,
       u.day,
       u.teammate_id,
       CASE WHEN t.id IS NULL THEN u.region_id ELSE t.region_id END AS region_id,
       CASE WHEN t.id IS NULL THEN u.org_unit_id ELSE t.org_unit_id END AS org_unit_id,
       CASE WHEN t.id IS NOT NULL AND u.usage_provenance = 'provider-usage'
            THEN c.cost_owning_unit_id
            ELSE u.cost_owning_unit_id
       END AS cost_owning_unit_id,
       u.project_id,
       u.tool,
       u.model,
       u.usage_provenance,
       u.model_gap_reason,
       u.activity,
       u.cost_usd,
       u.tokens,
       u.record_count,
       u.refresh_at,
       u.identity_state
  FROM usage_rollup_daily u
  LEFT JOIN teammate t ON t.id = u.teammate_id
  LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id;

COMMENT ON VIEW v_usage_rollup_current IS
  'usage_rollup_daily with region_id / org_unit_id from the teammate''s CURRENT placement and, on provider-usage rows only, the person''s current Business Unit (v_org_unit_cost_owner); otel-emitted rows keep the project''s Business Unit, api-reconciled rows keep NULL. Every report that groups or scopes by placement reads this (docs/design/current-org-lens/00-design.md).';

-- Two branches split on usage_provenance rather than one CASE, for the planner:
-- usage_provenance is a literal in every arm of v_complete_usage, so each branch's
-- filter prunes the other branch's arms, and a Business Unit clamp on the first
-- branch is a predicate on v_complete_usage's own column, pushed into arms 1/2
-- (attribution_record_cou_t). As one CASE over the join it filtered after every
-- arm had been computed for the window: 3-4x slower on the Business Unit cards.
CREATE VIEW v_complete_usage_current WITH (security_invoker = true) AS
SELECT u.teammate_id,
       CASE WHEN t.id IS NULL THEN u.region_id ELSE t.region_id END AS region_id,
       CASE WHEN t.id IS NULL THEN u.org_unit_id ELSE t.org_unit_id END AS org_unit_id,
       u.cost_owning_unit_id,
       u.project_id,
       u.tool,
       u.ts_event,
       u.cost_usd,
       u.tokens,
       u.model,
       u.token_type,
       u.identity_state,
       u.usage_provenance,
       u.activity,
       u.model_gap_reason
  FROM v_complete_usage u
  LEFT JOIN teammate t ON t.id = u.teammate_id
 WHERE u.usage_provenance <> 'provider-usage'
UNION ALL
SELECT u.teammate_id,
       CASE WHEN t.id IS NULL THEN u.region_id ELSE t.region_id END,
       CASE WHEN t.id IS NULL THEN u.org_unit_id ELSE t.org_unit_id END,
       CASE WHEN t.id IS NULL THEN u.cost_owning_unit_id ELSE c.cost_owning_unit_id END,
       u.project_id,
       u.tool,
       u.ts_event,
       u.cost_usd,
       u.tokens,
       u.model,
       u.token_type,
       u.identity_state,
       u.usage_provenance,
       u.activity,
       u.model_gap_reason
  FROM v_complete_usage u
  LEFT JOIN teammate t ON t.id = u.teammate_id
  LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
 WHERE u.usage_provenance = 'provider-usage';

COMMENT ON VIEW v_complete_usage_current IS
  'v_complete_usage with the same current-placement projection as v_usage_rollup_current. Raw-grain reports that group or scope by placement read this; Me pages and the rollup builder stay on v_complete_usage.';

CREATE VIEW v_provider_usage_fact_current WITH (security_invoker = true) AS
SELECT f.id,
       f.raw_batch_id,
       f.source,
       f.provider,
       f.provider_org_id,
       f.provider_enterprise_id,
       f.teammate_id,
       f.actor_ref,
       f.date,
       f.tool,
       f.model,
       f.cost_type,
       CASE WHEN t.id IS NULL THEN f.region_id ELSE t.region_id END AS region_id,
       CASE WHEN t.id IS NULL THEN f.org_unit_id ELSE t.org_unit_id END AS org_unit_id,
       CASE WHEN t.id IS NULL THEN f.cost_owning_unit_id ELSE c.cost_owning_unit_id END AS cost_owning_unit_id,
       f.dimension_source,
       f.cost_usd,
       f.currency,
       f.input_tokens,
       f.output_tokens,
       f.cache_read_tokens,
       f.cache_creation_tokens,
       f.requests,
       f.pulled_at,
       f.data_refreshed_at,
       f.web_search_requests,
       f.context_window
  FROM provider_usage_fact f
  LEFT JOIN teammate t ON t.id = f.teammate_id
  LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id;

COMMENT ON VIEW v_provider_usage_fact_current IS
  'provider_usage_fact with region_id / org_unit_id / cost_owning_unit_id from the teammate''s CURRENT placement. A row with no teammate (an unresolved actor) keeps its stamped, NULL, homing. The billed drivers axis and the tier-exposure card read this.';
