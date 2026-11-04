-- 0166: session_instance_report — "Claude session S runs on instance I" (#494).
--
-- Why: a tagged repo's .claude/settings.local.json carries the WHOLE
-- OTEL_RESOURCE_ATTRIBUTES (the project tag and tokenscope.instance_id share
-- that one key, and a repo value replaces the install's), so when Claude Code
-- CLI and Claude Desktop open one repo, both emit with whichever install wrote
-- the file last. The SessionStart hook of each install now reports its own
-- instance for the session, signed with that install's own emit credential
-- (POST /api/v1/instances/{instanceId}/claude-sessions). The read-joiner books
-- the session's rows to the reported instance when it belongs to the same
-- teammate as the instance the record names (docs/design/session-instance-report.md).
--
-- No teammate_id: it is derived through instance_attestation. No retention job:
-- a row is a session uuid and an instance id, no personal data, and the joiner
-- needs it for as long as it may re-read the session (a deep rescan reads the
-- whole telemetry window), the same horizon attribution_record keeps
-- claude_session_id for.

CREATE TABLE session_instance_report (
  claude_session_id TEXT NOT NULL CHECK (claude_session_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  instance_id       UUID NOT NULL REFERENCES instance_attestation(instance_id),
  reported_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (claude_session_id, instance_id)
);

-- The route's per-instance rate limit counts recent reports.
CREATE INDEX session_instance_report_instance_t ON session_instance_report (instance_id, reported_at);

-- RLS (inert under the owner connection, ADR 0013; the route and the joiner are
-- the live paths). The machine lane writes as the instance's owner
-- (app.user_teammate_id via withMachineRls); the joiner reads as global-finops.
ALTER TABLE session_instance_report ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON session_instance_report FROM PUBLIC;

CREATE POLICY session_instance_report_owner ON session_instance_report
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM instance_attestation ia
      WHERE ia.instance_id = session_instance_report.instance_id
        AND ia.teammate_id::text = current_setting('app.user_teammate_id', true)
    )
  );

CREATE POLICY session_instance_report_admin ON session_instance_report
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

COMMENT ON TABLE session_instance_report IS
  'Which install a Claude session runs on, as that install reported it at SessionStart with its own emit credential. The read-joiner books the session''s rows to it when it is the same teammate''s (#494).';

-- ── attribution_record: the instance the record NAMED, when it was re-pointed ──
--
-- NULL for every row written as named (all rows before this migration). Set to
-- the record's own tokenscope.instance_id when the joiner booked the row to a
-- reported instance instead, so the ledger keeps what the telemetry said.
ALTER TABLE attribution_record ADD COLUMN emitted_instance_id UUID REFERENCES instance_attestation(instance_id);

COMMENT ON COLUMN attribution_record.emitted_instance_id IS
  'The tokenscope.instance_id the telemetry record carried, when the joiner booked it to another instance of the same teammate from a session_instance_report (#494). NULL = booked as named.';

-- The dedup key is the EMITTED instance, not the booked one. A record is read
-- again and again (the 5-minute overlap, deep rescans), and whether its session
-- has a report can change between reads (a resumed session reports late). Keyed
-- on the booked instance, a re-read after the report would insert the same
-- event a second time under the other instance. COALESCE keeps every existing
-- row's key exactly as it was.
DROP INDEX attribution_record_session_event_unique;
CREATE UNIQUE INDEX attribution_record_session_event_unique ON attribution_record
  (COALESCE(emitted_instance_id, instance_id), COALESCE(claude_session_id, ''::text), ts_event, token_type, model, COALESCE(source_run_id, ''::text));
-- The joiner's per-instance watermark groups on the same expression, so it is
-- served by this index's leading column.
