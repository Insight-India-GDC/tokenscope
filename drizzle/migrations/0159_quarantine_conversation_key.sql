-- 0159 — a quarantined conversation is excluded on its CONVERSATION KEY.
--
-- A conversation is COALESCE(claude_session_id, instance_id::text)
-- (server/db/conversation-key.ts); the over-emission resolve route writes
-- session_quarantine.conversation_id on that key. Both views matched it against
-- claude_session_id alone, so quarantining a conversation whose records carry no
-- session id excluded nothing while the flag read 'quarantined'. Each view is
-- its previous definition (v_complete_usage: 0135, v_finance_project_overlay:
-- 0146) verbatim except for that one predicate. The probe still reads
-- session_quarantine_teammate_conv_open_idx (0134): the key is computed from the
-- outer row.

CREATE OR REPLACE VIEW v_complete_usage
WITH (security_invoker = true) AS
  WITH
  -- Σ of the write-time children per parent (0123). The writer guarantees
  -- Σ children ≤ parent for cost AND tokens (the descending cap), so the
  -- remainders below are never negative — the GREATEST(0, …) caps are belt
  -- and braces per measure, not load-bearing arithmetic.
  uu_children AS (
    SELECT
      m.unaccounted_usage_id,
      SUM(m.cost_usd)::numeric(14, 6) AS child_usd,
      SUM(m.tokens)::bigint AS child_tokens
    FROM unaccounted_usage_model m
    GROUP BY m.unaccounted_usage_id
  ),
  -- The arm-3 per-model observed operand: provider_usage_fact COST rows,
  -- model NOT NULL, aggregated ACROSS sources for the (teammate, day, tool)
  -- key (mig 0121's index), carrying its per-key total as a window aggregate
  -- (0126 D1). Measure exclusivity (0118 measure_chk) makes the plain SUMs
  -- safe: SUM(cost_usd) sees only cost rows, the FILTERed token sum sees only
  -- token rows — a github MODEL row (requests-only) contributes neither and
  -- is dropped by the usd/tokens gate below; github money (model NULL, mig
  -- 0120) never enters at all. btrim mirrors the S1 writer (D9).
  arm3_fact_model_keyed AS NOT MATERIALIZED (
    SELECT
      fm.teammate_id, fm.day, fm.tool, fm.model, fm.usd, fm.tokens,
      SUM(fm.usd) OVER (PARTITION BY fm.teammate_id, fm.day, fm.tool)
        ::numeric(14, 6) AS key_usd
    FROM (
      SELECT
        f.teammate_id,
        f.date AS day,
        f.tool,
        btrim(f.model) AS model,
        COALESCE(SUM(f.cost_usd), 0)::numeric(14, 6) AS usd,
        COALESCE(
          SUM(COALESCE(f.input_tokens, 0) + COALESCE(f.output_tokens, 0))
            FILTER (WHERE f.cost_type IS NULL),
          0
        )::bigint AS tokens
      FROM provider_usage_fact f
      WHERE f.model IS NOT NULL
        AND f.teammate_id IS NOT NULL
        AND f.tool IN (
          'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
          'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
        )
      GROUP BY f.teammate_id, f.date, f.tool, btrim(f.model)
    ) fm
  ),
  -- The per-key fact totals the arm-3b overrun guard and remainder read —
  -- the SAME predicates, aggregated at key grain directly (see header).
  arm3_fact_key AS NOT MATERIALIZED (
    SELECT
      f.teammate_id,
      f.date AS day,
      f.tool,
      COALESCE(SUM(f.cost_usd), 0)::numeric(14, 6) AS fact_usd,
      COALESCE(
        SUM(COALESCE(f.input_tokens, 0) + COALESCE(f.output_tokens, 0))
          FILTER (WHERE f.cost_type IS NULL),
        0
      )::bigint AS fact_tokens
    FROM provider_usage_fact f
    WHERE f.model IS NOT NULL
      AND f.teammate_id IS NOT NULL
      AND f.tool IN (
        'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
        'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
      )
    GROUP BY f.teammate_id, f.date, f.tool
  )
  -- ── Arm 1 (otel-emitted) — 0113's definition verbatim + the new column ─────
  SELECT
    ar.teammate_id, ar.region_id, ar.org_unit_id, ar.cost_owning_unit_id, ar.project_id, ar.tool,
    ar.ts_event, ar.cost_usd, ar.tokens,
    ar.model,
    ar.token_type,
    ar.identity_state,
    'otel-emitted'::text AS usage_provenance,     -- 0101: see shared/usage/provenance.ts
    ar.activity,                                   -- 0113
    NULL::text AS model_gap_reason                 -- 0124: a named model has no gap
  FROM attribution_record ar
  WHERE NOT EXISTS (
    SELECT 1 FROM session_quarantine sq
     WHERE sq.teammate_id = ar.teammate_id
       AND sq.conversation_id = COALESCE(ar.claude_session_id, ar.instance_id::text)
       AND sq.resolved_at IS NULL
       AND sq.reason = 'api-uncorroborated'
  )
  AND ar.tool NOT IN (
    'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
    'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
  )
  UNION ALL
  -- ── Arm 2a (api-reconciled) — the write-time children (D4) ─────────────────
  -- Children inherit the parent's project_id, so a TAGGED fill day's models
  -- flow to its project. They carry the parent's day/activity/identity; only
  -- model, cost and tokens are their own.
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    m.cost_usd, m.tokens,
    m.model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance,
    uu.activity,
    NULL::text AS model_gap_reason
  FROM unaccounted_usage uu
  JOIN unaccounted_usage_model m ON m.unaccounted_usage_id = uu.id
  WHERE uu.cost_usd > 0
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- ── Arm 2b (api-reconciled) — the reason-typed remainder (D3 step 4) ───────
  -- ONE rule for the with-children shortfall, the no-children case (Σ = 0) and
  -- everything between: emit the remainder row when the COST remainder OR the
  -- TOKEN remainder is positive (0125), each measure GREATEST(0, …)-capped
  -- independently, typed by the parent's stamped reason, else
  -- 'unmodelled-provider-cost'. A cost-exact/token-short parent surfaces as a
  -- $0 row carrying the missing tokens — token conservation does not depend on
  -- the money also falling short.
  SELECT
    uu.teammate_id, uu.region_id, uu.org_unit_id, NULL::uuid AS cost_owning_unit_id, uu.project_id, uu.tool,
    (uu.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    GREATEST(0, uu.cost_usd - COALESCE(c.child_usd, 0))::numeric(14, 6) AS cost_usd,
    GREATEST(0, COALESCE(uu.tokens, 0) - COALESCE(c.child_tokens, 0))::bigint AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'api-reconciled'::text AS usage_provenance,
    uu.activity,
    COALESCE(uu.model_gap_reason, 'unmodelled-provider-cost') AS model_gap_reason
  FROM unaccounted_usage uu
  LEFT JOIN uu_children c ON c.unaccounted_usage_id = uu.id
  WHERE uu.cost_usd > 0
    AND uu.tool NOT IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
    AND (uu.cost_usd - COALESCE(c.child_usd, 0) > 0
         OR COALESCE(uu.tokens, 0) - COALESCE(c.child_tokens, 0) > 0)
  UNION ALL
  -- ── Arm 3a (provider-usage) — the observed per-model fan-out (D5) ──────────
  -- Guarded: a key whose facts overrun its authoritative vtd total emits NO
  -- fan-out (see arm 3b). Equality is NOT an overrun — a fully-modelled day
  -- fans out completely and emits no NULL row at all. 0126: the guard reads
  -- the window-carried key_usd (≡ the old fk.fact_usd) off the ONE joined
  -- relation.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    fm.usd AS cost_usd, fm.tokens,
    fm.model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance,
    NULL::text AS activity,                        -- 0113: untaggable ⇒ no activity axis
    NULL::text AS model_gap_reason
  FROM v_teammate_usage_daily vtd
  JOIN arm3_fact_model_keyed fm
    ON fm.teammate_id = vtd.teammate_id AND fm.day = vtd.day AND fm.tool = vtd.tool
  WHERE vtd.usage_usd > 0
    AND fm.key_usd <= vtd.usage_usd
    AND (fm.usd > 0 OR fm.tokens > 0)
    -- INGEST_ONLY_USAGE_TOOLS (shared/usage/surface.ts) — MUST match exactly
    -- (pinned by tests/unit/usage/surface.test.ts's migration-0101 block).
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
  UNION ALL
  -- ── Arm 3b (provider-usage) — the remainder / overrun row (D5, r1-H3) ──────
  -- Normal: emitted when the cost remainder OR the token remainder is positive
  -- (0125 — a cost-exact day whose facts carry fewer tokens than vtd still
  -- reconciles its tokens through a $0 remainder row). Copilot-agent money
  -- lands here WHOLE — github money rows carry no model, so its fan-out Σ is 0.
  -- Overrun: still decided on COST alone (no token-overrun state — calibration
  -- rule): the WHOLE day, unfanned, 'provider-revision-drift'.
  -- Σ per key = vtd.usage_usd in every case, and Σ tokens per key = vtd.tokens.
  SELECT
    vtd.teammate_id, vtd.region_id, vtd.org_unit_id, vtd.cost_owning_unit_id, NULL::uuid AS project_id, vtd.tool,
    (vtd.day::timestamp AT TIME ZONE 'UTC') AS ts_event,
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         THEN vtd.usage_usd
         ELSE GREATEST(0, vtd.usage_usd - COALESCE(fk.fact_usd, 0))::numeric(14, 6)
    END AS cost_usd,
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         THEN COALESCE(vtd.tokens, 0)::bigint
         ELSE GREATEST(0, COALESCE(vtd.tokens, 0) - COALESCE(fk.fact_tokens, 0))::bigint
    END AS tokens,
    NULL::text AS model,
    'unknown'::text AS token_type,
    'confirmed'::text AS identity_state,
    'provider-usage'::text AS usage_provenance,
    NULL::text AS activity,                        -- 0113: untaggable ⇒ no activity axis
    CASE WHEN COALESCE(fk.fact_usd, 0) > vtd.usage_usd THEN 'provider-revision-drift'
         WHEN vtd.tool = 'copilot-agent' THEN 'provider-day-grain'
         ELSE 'surface-remainder'
    END AS model_gap_reason
  FROM v_teammate_usage_daily vtd
  LEFT JOIN arm3_fact_key fk
    ON fk.teammate_id = vtd.teammate_id AND fk.day = vtd.day AND fk.tool = vtd.tool
  WHERE vtd.usage_usd > 0
    AND vtd.tool IN (
      'copilot-agent', 'claude-ai', 'claude-cowork', 'claude-office',
      'claude-chrome', 'claude-design', 'claude-slack', 'claude-other'
    )
    AND (COALESCE(fk.fact_usd, 0) > vtd.usage_usd
         OR vtd.usage_usd - COALESCE(fk.fact_usd, 0) > 0
         OR COALESCE(vtd.tokens, 0) - COALESCE(fk.fact_tokens, 0) > 0);

CREATE OR REPLACE VIEW v_finance_project_overlay WITH (security_invoker = true) AS
SELECT b.cost_owning_unit_id, b.region_id, b.teammate_id, b.period_date, b.tool, c.project_id,
       CASE WHEN c.total_weight_usd IS NULL THEN b.bill_usd
            ELSE b.bill_usd * c.weight_usd / c.total_weight_usd
       END AS charge_usd
  FROM v_finance_bill_chargeback b
  LEFT JOIN LATERAL (
    SELECT w.project_id, w.weight_usd, w.total_weight_usd
      FROM (
        SELECT x.project_id, SUM(x.weight_usd) AS weight_usd,
               SUM(SUM(x.weight_usd)) OVER () AS total_weight_usd
          FROM (
            -- The completeness gate is decided once for the whole cell and
            -- applied unchanged to every project row of it.
            SELECT o.project_id,
                   CASE WHEN bool_or(bool_or(o.unknown_row)) OVER ()
                        THEN SUM(o.cost_usd)
                        ELSE COALESCE(SUM(o.cost_usd) FILTER (WHERE o.billing_lane <> 'self-billed'), 0)
                   END AS weight_usd
              FROM (
                SELECT ar.project_id, ar.cost_usd, ar.billing_lane,
                       (ar.billing_lane IS NULL OR ar.billing_lane = 'unknown') AS unknown_row
                  FROM attribution_record ar
                 WHERE ar.teammate_id = b.teammate_id
                   AND ar.tool = b.tool
                   AND ar.ts_event >= (b.period_date::timestamp AT TIME ZONE 'UTC')
                   AND ar.ts_event <  ((b.period_date + 1)::timestamp AT TIME ZONE 'UTC')
                   AND ar.ts_event >= COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
                   AND NOT EXISTS (
                     SELECT 1 FROM session_quarantine sq
                      WHERE sq.teammate_id = ar.teammate_id
                        AND sq.conversation_id = COALESCE(ar.claude_session_id, ar.instance_id::text)
                        AND sq.resolved_at IS NULL
                        AND sq.reason = 'api-uncorroborated')
                UNION ALL
                SELECT srd.project_id, srd.total_cost_usd, 'unknown'::text, TRUE
                  FROM spend_rollup_daily srd
                 WHERE srd.teammate_id = b.teammate_id
                   AND srd.tool = b.tool
                   AND srd.period_start >= (b.period_date::timestamp AT TIME ZONE 'UTC')
                   AND srd.period_start <  ((b.period_date + 1)::timestamp AT TIME ZONE 'UTC')
                   AND srd.period_start < COALESCE((SELECT archived_through FROM ledger_archive_state WHERE id = 'singleton'), '-infinity'::timestamptz)
              ) o
             GROUP BY o.project_id
            UNION ALL
            SELECT u.project_id, u.cost_usd
              FROM unaccounted_usage u
             WHERE u.teammate_id = b.teammate_id AND u.day = b.period_date AND u.tool = b.tool
          ) x
         GROUP BY x.project_id
      ) w
     WHERE w.total_weight_usd > 0 AND w.weight_usd <> 0
  ) c ON TRUE;
