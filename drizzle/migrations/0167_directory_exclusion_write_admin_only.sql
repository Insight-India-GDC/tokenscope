-- 0167: directory_exclusion_pattern writes are Admin (platform-admin) only at the
-- database too (#493, REMAINING A30, security sprint UF-23).
--
-- Why: the patterns are company-wide config (the table has no region_id), and the
-- three routes already refuse anyone but platform-admin to change them
-- (directory-exclusions index.post.ts / [id].delete.ts). The 0083 write policy
-- still admitted a bare 'admin' (a Region admin), so the database allowed what
-- the app refuses. Product call (po-tokenscope, 2026-10-31): Admin only.
--
-- 'global-finops' stays: in app.user_role it is the SCOPE VALUE platform-admin
-- runs as (server/db/rls.ts rlsRoleFor) and the worker lane's role, not the
-- retired teammate role (see 0140). Reads stay open to every authenticated
-- session, as in 0083 (the people-picker filter reads the table).

DROP POLICY IF EXISTS directory_exclusion_pattern_write ON directory_exclusion_pattern;

CREATE POLICY directory_exclusion_pattern_write ON directory_exclusion_pattern
  FOR ALL
  USING (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'))
  WITH CHECK (current_setting('app.user_role', true) IN ('global-finops', 'platform-admin'));
