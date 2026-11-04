-- 0164: Project Managers (PMO list) and project requests
-- (docs/design/project-requests/00-spec.md §1, §3, A4, A12).
--
-- project_manager_grant: who may create projects without approval. Org-wide;
-- soft-revoked, so history survives and a re-grant is a new row.
-- project_request: a teammate asks for a project; an admin of the Business
-- Unit's region approves (creating it) or rejects. Decisions are conditional
-- updates on status = 'pending' (the 409 race guard lives in the handlers).

CREATE TABLE project_manager_grant (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  teammate_id UUID NOT NULL REFERENCES teammate(id),
  granted_by  UUID REFERENCES teammate(id),
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at  TIMESTAMPTZ,
  revoked_by  UUID REFERENCES teammate(id),
  note        TEXT CHECK (note IS NULL OR char_length(note) <= 500),
  CONSTRAINT project_manager_grant_revoke_shape CHECK (
    (revoked_at IS NULL AND revoked_by IS NULL)
    OR (revoked_at IS NOT NULL AND revoked_by IS NOT NULL))
);

CREATE UNIQUE INDEX project_manager_grant_live_unique
  ON project_manager_grant (teammate_id) WHERE revoked_at IS NULL;

CREATE TABLE project_request (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  requester_teammate_id   UUID NOT NULL REFERENCES teammate(id),
  status                  TEXT NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  -- 'connector' is reserved for machine connectors; no v1 code writes it.
  source                  TEXT NOT NULL DEFAULT 'person' CHECK (source IN ('person', 'connector')),
  suggested_code          TEXT,
  display_name            TEXT NOT NULL,
  type                    TEXT NOT NULL CHECK (type IN ('billable', 'pursuit', 'internal')),
  region_id               UUID NOT NULL REFERENCES region(id),
  cost_owning_unit_id     UUID NOT NULL REFERENCES org_unit(id),
  wbs_code                TEXT,
  end_date                TIMESTAMPTZ,
  proposed_pm_teammate_id UUID NOT NULL REFERENCES teammate(id),
  budget_usd              NUMERIC(14, 2) NOT NULL CHECK (budget_usd > 0),
  budget_from             TIMESTAMPTZ NOT NULL,
  budget_to               TIMESTAMPTZ NOT NULL,
  justification           TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by              UUID REFERENCES teammate(id),
  decided_at              TIMESTAMPTZ,
  decision_note           TEXT,
  -- SET NULL so request history survives a project delete (A12).
  created_project_id      UUID REFERENCES project(id) ON DELETE SET NULL,
  CONSTRAINT project_request_budget_period CHECK (budget_from < budget_to),
  CONSTRAINT project_request_decision_shape CHECK ((status = 'pending') = (decided_at IS NULL)),
  CONSTRAINT project_request_reject_note CHECK (status <> 'rejected' OR decision_note IS NOT NULL),
  CONSTRAINT project_request_created_project_shape CHECK (created_project_id IS NULL OR status = 'approved')
);

CREATE INDEX project_request_status_region_idx ON project_request (status, region_id);
CREATE INDEX project_request_requester_idx ON project_request (requester_teammate_id, created_at DESC);

ALTER TABLE project_manager_grant ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON project_manager_grant FROM PUBLIC;
REVOKE ALL ON project_request FROM PUBLIC;

-- A teammate reads their own grant (canCreateProjects); platform-admin manages
-- the list (A3). The worker lane runs as global-finops.
CREATE POLICY project_manager_grant_self ON project_manager_grant
  FOR SELECT
  USING (teammate_id::text = current_setting('app.user_teammate_id', true));

CREATE POLICY project_manager_grant_admin ON project_manager_grant
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));

CREATE POLICY project_request_self ON project_request
  FOR ALL
  USING (requester_teammate_id::text = current_setting('app.user_teammate_id', true));

CREATE POLICY project_request_admin ON project_request
  FOR ALL
  USING (
    current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
    OR (current_setting('app.user_role', true) = 'admin'
        AND region_id::text = current_setting('app.user_region_id', true))
  );

-- A4: 0 = a PMO holder may create in any region (default), 1 = only in the
-- region they are currently placed in. Platform row only; the PUT refuses a
-- region override for this key.
INSERT INTO governance_setting (key, scope_type, scope_id, value_numeric) VALUES
  ('projects.pm_own_region_only', 'platform', NULL, 0);

COMMENT ON TABLE project_manager_grant IS
  'PMO list: teammates who may create projects without approval (org-wide). Soft-revoked; at most one live row per teammate. Platform-admin manages it.';
COMMENT ON TABLE project_request IS
  'A teammate''s request for a new project, decided by an admin of the Business Unit''s region. created_project_id is SET NULL on project delete.';
