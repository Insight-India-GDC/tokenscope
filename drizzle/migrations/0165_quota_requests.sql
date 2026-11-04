-- 0165: quota_request — a project member asks the project's PM for more budget
-- (docs/design/project-requests/00-spec.md §5, amendments A6/A7, A9, A12).
--
-- User-facing copy calls this a "budget request" (A15). The table keeps the
-- spec's name.
--
-- One row per request. A decision is a conditional UPDATE on status='pending'
-- in the same transaction as the allocation writes, so a second decision (or a
-- withdraw racing an approve) finds no pending row and is refused.
--
-- Deletion (A12): the request belongs to its project and goes with it
-- (ON DELETE CASCADE). `allocation_id` names the top-up row approving created;
-- project delete removes allocations first, so it is SET NULL rather than
-- blocking.

CREATE TABLE quota_request (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id            UUID NOT NULL REFERENCES project(id) ON DELETE CASCADE,
  requester_teammate_id UUID NOT NULL REFERENCES teammate(id),
  amount_usd            NUMERIC(14, 2) NOT NULL CHECK (amount_usd > 0),
  reason                TEXT NOT NULL CHECK (char_length(reason) BETWEEN 1 AND 1000),
  status                TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
  approved_amount_usd   NUMERIC(14, 2) CHECK (approved_amount_usd IS NULL OR approved_amount_usd > 0),
  decided_by            UUID REFERENCES teammate(id),
  decided_at            TIMESTAMPTZ,
  decision_note         TEXT CHECK (decision_note IS NULL OR char_length(decision_note) <= 1000),
  allocation_id         UUID REFERENCES allocation(id) ON DELETE SET NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- A pending row carries no decision; a decided row carries who and when. An
  -- approval carries its amount; a rejection carries its note.
  CONSTRAINT quota_request_decision_shape CHECK (
    (status = 'pending'
      AND decided_by IS NULL AND decided_at IS NULL AND approved_amount_usd IS NULL)
    OR (status = 'approved'
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND approved_amount_usd IS NOT NULL)
    OR (status = 'rejected'
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND approved_amount_usd IS NULL
      AND decision_note IS NOT NULL)
    OR (status = 'withdrawn'
      AND decided_by IS NOT NULL AND decided_at IS NOT NULL AND approved_amount_usd IS NULL)
  )
);

-- A9: one pending request per (project, requester).
CREATE UNIQUE INDEX quota_request_one_pending
  ON quota_request (project_id, requester_teammate_id) WHERE status = 'pending';

CREATE INDEX quota_request_project_status_idx ON quota_request (project_id, status);
CREATE INDEX quota_request_requester_idx ON quota_request (requester_teammate_id, created_at DESC);

-- RLS (inert under the owner connection, ADR 0013; the route gates are the live
-- path). Shaped like report_access_grant (0129): cross-region roles see all, a
-- region admin sees its region's projects, the requester sees their own, and a
-- current PM of the project sees the project's requests.
ALTER TABLE quota_request ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON quota_request FROM PUBLIC;

CREATE POLICY quota_request_admin ON quota_request
  FOR ALL
  USING (
    current_setting('app.user_role', true) IN ('global-finops', 'platform-admin')
    OR (
      current_setting('app.user_role', true) = 'admin'
      AND EXISTS (
        SELECT 1 FROM project p
        WHERE p.id = quota_request.project_id
          AND p.region_id = NULLIF(current_setting('app.user_region_id', true), '')::uuid
      )
    )
  );

CREATE POLICY quota_request_requester ON quota_request
  FOR ALL
  USING (requester_teammate_id::text = current_setting('app.user_teammate_id', true));

CREATE POLICY quota_request_project_manager ON quota_request
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM project_assignment pa
      WHERE pa.project_id = quota_request.project_id
        AND pa.teammate_id::text = current_setting('app.user_teammate_id', true)
        AND pa.role = 'manager'
        AND pa.effective @> now()
    )
  );

COMMENT ON TABLE quota_request IS
  'A project member''s request for more budget on that project ("budget request" in the UI). Decided by the project''s PM or an admin; approving adds a top-up to the project pool.';
