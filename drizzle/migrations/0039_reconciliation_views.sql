-- 0039: reconciliation engine — effective-spend + finance-reportable views.
--
-- See docs/design/reconciliation-engine.md §3.3 / §7.5.
--
-- v_effective_spend       = immutable OTel truth (attribution_record) UNION applied
--                           reconciliation deltas. The SINGLE money surface.
-- v_finance_reportable_spend = v_effective_spend minus indicative (the cross-charge
--                           gate: only billed/estimated may feed Pathway).
--
-- spend_class is DERIVED here from attribution_record.cost_basis (rate-card /
-- estimated -> estimated [reconcilable]; telemetry-only -> indicative). cost_basis
-- itself is UNTOUCHED — spend_class is the money-vs-signal axis "alongside" it
-- (§3.1). reconciliation_record carries its own spend_class column.
--
-- security_invoker = true (PG15+): the views run with the QUERYING role's RLS on
-- the underlying tables, so swapping a rollup from `attribution_record` to the view
-- preserves row-level security (it does not become a definer-privilege bypass).
--
-- Both views expose the emitter region_id (NOT NULL on the attribution side) so
-- finance-scope's region clamp keeps working after the rewire (R3 M-2).

CREATE OR REPLACE VIEW v_effective_spend
WITH (security_invoker = true) AS
-- OTel-attributed truth (one row per attribution event).
SELECT
  ar.id                AS source_id,
  'attribution'::text  AS source,
  ar.teammate_id,
  ar.region_id,
  ar.org_unit_id,
  ar.cost_owning_unit_id,
  ar.project_id,
  ar.tool,
  ar.model,
  NULL::text           AS category,
  ar.ts_event          AS occurred_at,
  ar.cost_usd,
  CASE
    WHEN ar.cost_basis = 'telemetry-only' THEN 'indicative'
    ELSE 'estimated'
  END                  AS spend_class
FROM attribution_record ar
UNION ALL
-- Applied reconciliation deltas (signed). proposed/rejected/superseded excluded,
-- so supersession (a new applied row) never double-counts the prior one.
SELECT
  rr.id                AS source_id,
  'reconciliation'::text AS source,
  rr.teammate_id,
  rr.region_id,
  rr.org_unit_id,
  rr.cost_owning_unit_id,
  rr.project_id,
  NULL::text           AS tool,
  NULL::text           AS model,
  rr.category,
  (rr.period_date::timestamp AT TIME ZONE 'UTC') AS occurred_at, -- spend period (UTC), not processing time
  rr.delta_usd         AS cost_usd,
  rr.spend_class
FROM reconciliation_record rr
WHERE rr.status = 'applied';

CREATE OR REPLACE VIEW v_finance_reportable_spend
WITH (security_invoker = true) AS
SELECT * FROM v_effective_spend WHERE spend_class <> 'indicative';
