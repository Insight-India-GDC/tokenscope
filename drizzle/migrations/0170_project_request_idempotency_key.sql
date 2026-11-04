-- 0170: project_request.idempotency_key — a resent request is not filed twice (#477).
--
-- The request form generates one key per form fill and sends it with every
-- retry of the same content. When a submit's outcome is unknown (the server
-- committed, the answer was lost), the retry carries the same key and
-- POST /api/v1/me/project-requests returns the request already filed instead
-- of filing a second one. The key is optional on the wire, so rows filed
-- without one keep NULL, and NULLs never collide.
--
-- Unique per requester, not globally: one person's key cannot block or reveal
-- another's request. The route takes the requester's advisory lock before it
-- looks the key up, so this index is the backstop, not the race guard.
-- RLS is unchanged: project_request_self / project_request_admin (0164) cover
-- the new column like every other.

ALTER TABLE project_request ADD COLUMN idempotency_key UUID;

CREATE UNIQUE INDEX project_request_requester_idempotency_key_unique
  ON project_request (requester_teammate_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

COMMENT ON COLUMN project_request.idempotency_key IS
  'Client-generated key, one per form fill; a resend with the same key returns the request already filed. Unique per requester; NULL when the client sent none.';
