-- 0169 — reconciliation_record.cost_owning_unit_id holds the Business Unit (#450).
--
-- The reconciliation engine stamped a teammate-scoped row's cost_owning_unit_id
-- with the teammate's raw org unit, often a team node. Every other writer
-- (actual_spend, provider_usage_fact: server/reconciliation/dimension-snapshot.ts)
-- stamps the nearest live cost-owning ancestor. The engine now does too
-- (v_org_unit_cost_owner); this corrects the rows written before it.
--
-- Each row is resolved from its OWN recorded org_unit_id (left unchanged), but
-- against TODAY's tree: the unit's Business Unit as the cost-owning flags, paths
-- and retirements stand now, not as they stood on the usage date. A team whose
-- Business Unit has since been retired gets NULL, never a guess. Rows of every
-- provider and status move (the engine stamps Anthropic teammate rows the same
-- way). Org-scoped rows (teammate_id NULL) carry the provider_org's own
-- cost-owning unit and are left alone.
--
-- During a rolling deploy the old revision's engine can still write the raw unit
-- onto a proposed row after this runs; the next re-pull of that day corrects it.
--
-- No reported number moves: reports group a person's usage by their CURRENT
-- Business Unit (v_usage_rollup_current, mig 0162) and the Copilot overage split
-- re-resolves through v_org_unit_cost_owner. What changes is the admin
-- Reconciliation records ledger, which displayed the team node, and the stored
-- copy in usage_rollup_daily, which follows through the refresh queue below.

CREATE TEMP TABLE mig0169_moved AS
SELECT rr.id, rr.teammate_id, rr.provider, c.cost_owning_unit_id
FROM reconciliation_record rr
LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = rr.org_unit_id
WHERE rr.teammate_id IS NOT NULL
  AND rr.cost_owning_unit_id IS DISTINCT FROM c.cost_owning_unit_id;

UPDATE reconciliation_record rr
SET cost_owning_unit_id = m.cost_owning_unit_id
FROM mig0169_moved m
WHERE rr.id = m.id;

-- usage_rollup_daily keys cells on cost_owning_unit_id; recompute the full
-- history of every teammate whose GitHub rows moved (the 0136 retro-mutation
-- queue). Only GitHub rows reach v_complete_usage (v_teammate_usage_daily's
-- Copilot arm). The worker drains 50 teammates per run, so a large estate
-- takes some hours; until then those teammates' own reads use the live view.
INSERT INTO usage_rollup_refresh (teammate_id, requested_at)
SELECT DISTINCT teammate_id, statement_timestamp() FROM mig0169_moved WHERE provider = 'github'
ON CONFLICT (teammate_id) DO UPDATE SET requested_at = GREATEST(usage_rollup_refresh.requested_at + interval '1 microsecond', statement_timestamp());

DO $$
DECLARE
  moved integer;
BEGIN
  SELECT COUNT(*) INTO moved FROM mig0169_moved;
  RAISE NOTICE 'mig 0169: % reconciliation record(s) now carry their Business Unit', moved;
END $$;

DROP TABLE mig0169_moved;
