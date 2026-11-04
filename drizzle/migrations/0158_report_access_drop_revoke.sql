-- 0158 — report_access_grant: drop the 'revoke-all' permission (the per-person
-- report deny added by 0130).
--
-- Owner ruling 2026-10-15: admins are trusted and spend is not sensitive, so
-- the "administer, no data access" deny goes. Org-wide admins keep their
-- whole-company report default; the positive grants ('operational',
-- 'finance') are unchanged.
--
-- The application no longer reads 'revoke-all', so any surviving row is inert;
-- it is deleted (history included) because the narrower CHECK cannot validate it.

DELETE FROM report_access_grant WHERE permission = 'revoke-all';

ALTER TABLE report_access_grant
  DROP CONSTRAINT report_access_grant_permission_check;

ALTER TABLE report_access_grant
  ADD CONSTRAINT report_access_grant_permission_check
  CHECK (permission IN ('operational', 'finance'));
