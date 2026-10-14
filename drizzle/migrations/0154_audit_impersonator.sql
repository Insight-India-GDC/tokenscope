-- 0154 — record the REAL admin behind a persona-override action on audit_event.
--
-- Persona override (sandbox / local only; server/utils/auth.ts) rewrites the
-- request session to the PERSONA's identity, so every audit row written under
-- it named the persona as actor and nothing named the admin who actually acted.
-- The impersonation start/end rows carried the admin in their payload, but every
-- consequential action in between read as the persona's own.
--
-- impersonator_oid is the impersonating admin's Entra OID (the identifier the
-- override cookie carries — Session.impersonatorOid). It is NOT written by
-- callers: withRequestRls sets the transaction-local GUC app.impersonator_oid
-- from the session (server/db/rls.ts::applyRlsContext), and the one audit
-- writer, recordAuditEvent (server/db/audit.ts), copies it onto the row. NULL =
-- no override was active (every production row: the override layer is
-- structurally off outside {local, sandbox}).
--
-- No grant / RLS change: the app role's grants on audit_event are table-level
-- (drizzle/provision-app-role.ts) and its policy
-- (0002, 0098) is row-scoped, so both already cover a new column. The
-- append-only trigger (0001) is unaffected. No backfill: who impersonated in the
-- past is not recoverable from the rows themselves.
ALTER TABLE audit_event
  ADD COLUMN impersonator_oid text NULL;

ALTER TABLE audit_event
  ADD CONSTRAINT audit_event_impersonator_oid_len
    CHECK (impersonator_oid IS NULL OR length(impersonator_oid) BETWEEN 1 AND 128);

COMMENT ON COLUMN audit_event.impersonator_oid IS
  'Entra OID of the admin acting through persona override when this row was written (actor_* then names the persona). Stamped by recordAuditEvent from the transaction-local GUC app.impersonator_oid set by withRequestRls. NULL = no override active.';
