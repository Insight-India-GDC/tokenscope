-- 0163 — the §B bill views take a person's region from where they sit, not from their
-- Business Unit's region.
--
-- v_org_unit_cost_owner resolves a unit's Business Unit within the unit's own region
-- (0147), so the two regions agree whenever a Business Unit exists. When none does, the
-- old projection was NULL, and a person placed in a region but under no cost-owning unit
-- dropped out of that region's finance figures. Reports follow where people sit now
-- (docs/design/current-org-lens/00-design.md); their region is the teammate's.
-- Same columns and types, so CREATE OR REPLACE keeps dependents valid.

CREATE OR REPLACE VIEW v_finance_bill_chargeback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool,
       c.cost_owning_unit_id,
       t.region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
WHERE NOT a.chargeback_exempt
  -- §A-exclusion predicate: the unified GitHub firewall (GITHUB_FIREWALL_EXCLUSIONS).
  AND a.tool NOT IN ('copilot', 'copilot-agent', 'copilot-license', 'copilot-usage', 'copilot-unclassified', 'copilot-cli')
GROUP BY a.teammate_id, a.date, a.tool, c.cost_owning_unit_id, t.region_id;

CREATE OR REPLACE VIEW v_finance_bill_showback WITH (security_invoker = true) AS
SELECT a.teammate_id, a.date AS period_date, a.tool,
       c.cost_owning_unit_id,
       t.region_id,
       SUM(a.cost_usd) AS bill_usd, SUM(a.input_tokens + a.output_tokens) AS bill_tokens
FROM actual_spend a JOIN teammate t ON t.id = a.teammate_id
LEFT JOIN v_org_unit_cost_owner c ON c.org_unit_id = t.org_unit_id
GROUP BY a.teammate_id, a.date, a.tool, c.cost_owning_unit_id, t.region_id;

COMMENT ON VIEW v_finance_bill_chargeback IS
  'Chargeable §B bill per (teammate, date, tool), homed to the teammate''s nearest live cost-owning ancestor via v_org_unit_cost_owner (the single implementation; do NOT re-inline it) and to the region the teammate sits in now (0163). NULL cost_owning_unit_id = unallocated and MUST stay in the total. Excludes chargeback_exempt rows and every Copilot lane (those bill pooled per cost-centre via v_finance_copilot_pool_chargeback). provider-billing-attribution-model.md §B.';
