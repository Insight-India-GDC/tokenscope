-- 0161: Org setup storage (docs/design/org-setup/00-spec.md).
--
-- org_setup_setting: one row, the top of the organisation and how often the
-- directory is re-read. org_setup_dismissal: decisions an Admin set aside until a
-- later check cycle. placement_principal_check: whether each active unit owner and
-- region leader was found in the directory, written by the placement-check worker
-- once per cycle.

CREATE TABLE org_setup_setting (
  id           BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (id),
  top_oid      TEXT,
  top_name     TEXT,
  top_email    TEXT,
  read_cadence TEXT NOT NULL DEFAULT 'month' CHECK (read_cadence IN ('month', 'week')),
  updated_by   UUID REFERENCES teammate(id) ON DELETE SET NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO org_setup_setting (id) VALUES (TRUE);

CREATE TABLE org_setup_dismissal (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind         TEXT NOT NULL,
  subject_key  TEXT NOT NULL,
  cycle_id     UUID NOT NULL REFERENCES placement_check_cycle(id) ON DELETE CASCADE,
  dismissed_by UUID REFERENCES teammate(id) ON DELETE SET NULL,
  dismissed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (kind, subject_key, cycle_id)
);

CREATE TABLE placement_principal_check (
  oid        TEXT PRIMARY KEY,
  cycle_id   UUID NOT NULL REFERENCES placement_check_cycle(id) ON DELETE CASCADE,
  checked_at TIMESTAMPTZ NOT NULL,
  found      BOOLEAN NOT NULL
);

-- Platform-admin only; the worker lane runs as global-finops (see 0140, 0160).
ALTER TABLE org_setup_setting ENABLE ROW LEVEL SECURITY;
ALTER TABLE org_setup_dismissal ENABLE ROW LEVEL SECURITY;
ALTER TABLE placement_principal_check ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON org_setup_setting FROM PUBLIC;
REVOKE ALL ON org_setup_dismissal FROM PUBLIC;
REVOKE ALL ON placement_principal_check FROM PUBLIC;

CREATE POLICY org_setup_setting_admin ON org_setup_setting
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

CREATE POLICY org_setup_dismissal_admin ON org_setup_dismissal
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

CREATE POLICY placement_principal_check_admin ON placement_principal_check
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

COMMENT ON TABLE org_setup_setting IS
  'Org setup: the top of the organisation and the directory re-read cadence. One row. Platform-admin only.';
COMMENT ON TABLE org_setup_dismissal IS
  'Org setup decisions an Admin set aside until a later placement-check cycle. Platform-admin only.';
COMMENT ON TABLE placement_principal_check IS
  'Whether each active unit owner and region leader was found in the directory, per placement-check cycle. Platform-admin only.';
