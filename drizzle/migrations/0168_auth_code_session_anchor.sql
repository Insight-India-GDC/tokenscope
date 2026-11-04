-- 0168 — an auth code remembers the session that approved it (#431), and
-- teammate.revoked_at says what it means (#428).
--
-- #431. A role change, region move or revoke-sessions bumps teammate.revoked_at
-- to its transaction's NOW() and revokes the teammate's interactive tokens, so
-- every session minted before it must sign in again. A consent approved WHILE
-- that transaction was open slipped through: /authorize read the old revoked_at,
-- the code's created_at landed after the bump's NOW(), so the exchange's
-- "revoked_at < created_at" check passed and the token outlived the session
-- that approved it. The code now carries the approving cookie session's mint
-- time and the exchange judges that (the earlier of the two). The exchange also
-- locks the teammate row first (server/auth/oauth.ts consumeAuthCode), so it
-- waits for an open move and then reads its committed revoked_at.
--
-- NULL for codes minted before this deploy (they live five minutes); the
-- exchange falls back to created_at for those, which is today's rule.
ALTER TABLE oauth_auth_code
  ADD COLUMN session_issued_at timestamptz NULL;

COMMENT ON COLUMN oauth_auth_code.session_issued_at IS
  'Mint time of the cookie session that approved the consent. The exchange refuses the code if teammate.revoked_at is later than this or created_at (#431). NULL only for codes minted before mig 0168.';

-- #428. revoked_at was once overloaded: offboarding, emit and forced re-login
-- all bumped it. Each meaning now has its own column: emit_revoked_at (mig
-- 0152) ends device emission, is_active = false retires an account. What is
-- left is one question, and the comment says so for the next reader.
COMMENT ON COLUMN teammate.revoked_at IS
  'Session anchor: every cookie session, auth code and interactive (read/tag, unbound emit) credential minted before it is refused; anything minted after is valid. Bumped by a role change, a region move, revoke-sessions and shadow retirement. Not offboarding (is_active) and not device emission (emit_revoked_at, #414); never gate eligibility on it (#428).';
