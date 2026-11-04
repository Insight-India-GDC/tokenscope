-- 0160: placement check storage (docs/design/placement-check/00-spec.md P4).
--
-- placement_check_cycle: one row per "Start check". placement_evidence: what the
-- directory said about each teammate when the check last gathered them, one row
-- per teammate, overwritten each cycle. Verdicts are computed at read time from
-- the evidence and the current config, so none is stored.
--
-- chain is an ordered JSON array of {oid, name, email}, the teammate themself
-- first, then their manager upward. attributes is a JSON object of the directory
-- attributes placement rules match on.

CREATE TABLE placement_check_cycle (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_by UUID REFERENCES teammate(id) ON DELETE SET NULL
);

CREATE TABLE placement_evidence (
  teammate_id UUID PRIMARY KEY REFERENCES teammate(id) ON DELETE CASCADE,
  gathered_at TIMESTAMPTZ NOT NULL,
  cycle_id    UUID NOT NULL REFERENCES placement_check_cycle(id) ON DELETE CASCADE,
  lookup      TEXT NOT NULL CHECK (lookup IN ('oid', 'email')),
  attributes  JSONB NOT NULL CHECK (jsonb_typeof(attributes) = 'object'),
  chain       JSONB NOT NULL CHECK (jsonb_typeof(chain) = 'array'),
  walk_end    TEXT NOT NULL CHECK (walk_end IN ('top-of-chart', 'hop-cap', 'cycle', 'graph-error', 'not-in-directory'))
);

CREATE INDEX placement_evidence_cycle_idx ON placement_evidence (cycle_id, walk_end);

-- Platform-admin only; the worker lane runs as global-finops (see 0140).
ALTER TABLE placement_check_cycle ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_evidence ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON placement_check_cycle FROM PUBLIC;
REVOKE ALL ON placement_evidence FROM PUBLIC;

CREATE POLICY placement_check_cycle_admin ON placement_check_cycle
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

CREATE POLICY placement_evidence_admin ON placement_evidence
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

COMMENT ON TABLE placement_check_cycle IS
  'Placement check runs (spec P4): one row per Start check. Platform-admin only.';
COMMENT ON TABLE placement_evidence IS
  'Placement check evidence per teammate (spec P4): directory attributes, manager chain (self first) and how the walk ended. No verdicts. Platform-admin only.';
