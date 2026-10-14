-- 0155 — bound the admin-authored names that reach every member's agent (#1394).
--
-- project.display_name and activity_type.label were unbounded TEXT, and they
-- are returned in MCP tool results that each member's Claude Code agent reads
-- (getMyProjects, getActivityTypes in server/utils/me-queries.ts). A name
-- carrying newlines or escape sequences can render as something other than a
-- name in that context. project.client_facing_name never leaves the app; it is
-- bounded the same way for UI safety.
--
-- The bounds mirror the write validators exactly (shared/schemas/display-text.ts):
-- project names 1..200 characters, activity labels 1..64, and no control
-- character: C0 (0x00-0x1F), DEL (0x7F) or C1 (0x80-0x9F, which includes the
-- one-character CSI escape 0x9B). Change one, change both. Both layers
-- count code points, so a value the API accepts always lands.
--
-- NOT VALID, deliberately, and not followed by VALIDATE: every new INSERT and
-- UPDATE is checked from this migration on, but existing rows are not scanned.
-- Legacy Dev and production rows cannot be inspected from here, and a VALIDATE
-- that met one bad row would fail the deploy. Validate in a later migration once
-- a query has shown no row violates. Until then the MCP read paths pass these
-- values through cleanDisplayText, so a legacy row is bounded on the way out.
-- client_facing_name is nullable and a NULL
-- passes a CHECK, which is the intended "not set".

ALTER TABLE project
  ADD CONSTRAINT project_display_name_bounded CHECK (
    char_length(display_name) BETWEEN 1 AND 200
    AND display_name !~ '[\x00-\x1F\x7F-\x9F]'
  ) NOT VALID;

ALTER TABLE project
  ADD CONSTRAINT project_client_facing_name_bounded CHECK (
    char_length(client_facing_name) BETWEEN 1 AND 200
    AND client_facing_name !~ '[\x00-\x1F\x7F-\x9F]'
  ) NOT VALID;

ALTER TABLE activity_type
  ADD CONSTRAINT activity_type_label_bounded CHECK (
    char_length(label) BETWEEN 1 AND 64
    AND label !~ '[\x00-\x1F\x7F-\x9F]'
  ) NOT VALID;
