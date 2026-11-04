#!/usr/bin/env bash
# Production container entrypoint.
#
# Migrate-on-boot pattern: idempotent (drizzle/migrate.ts tracks applied
# migrations in _drizzle_migrations). Safe on every replica restart.
set -euo pipefail

# Pre-flight: probe every provisioned private-endpoint dependency and log each
# one's reachability BEFORE migrations, so a network gap surfaces as a named
# per-service line (e.g. `postgres: UNREACHABLE …:5432 [timeout]`) instead of a
# cryptic migration abort. Aborts boot only on a CRITICAL service (Postgres);
# an un-wired but unused PE (Redis/KV) warns but does not block.
echo "[entrypoint] preflight: probing dependency reachability..."
node node_modules/.bin/tsx scripts/preflight-run.ts || {
  echo "[entrypoint] preflight failed: a critical dependency is unreachable; aborting boot"
  exit 1
}

if [ -n "${DATABASE_URL:-}" ]; then
  echo "[entrypoint] applying migrations..."
  node node_modules/.bin/tsx drizzle/migrate.ts || {
    echo "[entrypoint] migration failed; aborting boot"
    exit 1
  }
  # Create pg_stat_statements if this role may. BEST EFFORT and NEVER fatal:
  # the extension is a diagnostic, and no failure to create it is a reason to
  # refuse traffic. Deliberately NOT a migration — a migration runs inside the
  # transaction whose failure aborts boot above, and runs only once, so a
  # transient failure would become permanent. This retries every boot.
  echo "[entrypoint] ensuring pg_stat_statements extension (best effort)..."
  node node_modules/.bin/tsx drizzle/ensure-stat-statements.ts || \
    echo "[entrypoint] pg_stat_statements step exited non-zero (ignored by design)"

  # Provision the NON-OWNER app role that makes the RLS policies execute.
  # DORMANT BY DEFAULT: a no-op unless
  # TOKENSCOPE_PROVISION_APP_ROLE=true, so shipping it changes nothing until
  # someone opts in. Runs on the OWNER's DATABASE_URL (same login as migrate.ts
  # — its ALTER DEFAULT PRIVILEGES only covers objects created by the role that
  # runs it). Idempotent and safe on every replica restart.
  #
  # IT CREATES A ROLE. IT DOES NOT TOUCH RLS POSTURE. The cutover DISABLE sweep
  # is the NEXT step and its own script. Creating a role and cutting an estate over to RLS enforcement are two
  # decisions with two opt-ins.
  #
  # ONE THING IT DOES EVEN WHEN DORMANT: if TOKENSCOPE_APP_DATABASE_URL is set,
  # it probes that credential. useAppRoleAtRuntime=true with
  # provisionAppRole=false is a combination Bicep permits; without the probe it
  # would boot silently into a permanent 503.
  #
  # THE PASSWORD IS SET ONCE, WHEN THE ROLE IS CREATED. A boot that finds the
  # role already there does NOT touch its password — not to "re-sync" it, not
  # because the Key Vault secret looks different. The app may be serving on that
  # credential right now, and this container cannot tell whether the secret it
  # was handed is newer or older than the one the role holds.
  #
  #   TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true IS THE ONLY PATH THAT CHANGES AN
  #   EXISTING ROLE'S PASSWORD (Bicep: param rotateAppDbPassword).
  #
  # It is off by default and is meant to be on for ONE deliberate boot, after
  # re-applying the infrastructure with writeAppDbPassword=true. Left on, every restart is
  # a rotation again — which is the behaviour this step was cut down to remove,
  # because a restart that rotates takes the credential out from under whichever
  # replica is already serving.
  #
  # EXIT CODES ARE THE CONTRACT, not the mere fact of failure:
  #   1 = the step did not finish. Non-fatal: the next boot retries. A failed run
  #       cannot have taken the runtime's credential away — an existing role's
  #       password is untouched unless rotation was explicitly requested, and a
  #       rotation is one statement inside the one transaction, so either side of
  #       the commit leaves a credential some deployment holds.
  #       A database this container could not REACH lands here too, and so does a
  #       server error that is not about identity (53300 too many connections,
  #       say): neither is evidence about the credential, and if the fault
  #       persists the revision fails its readiness probe and Container Apps
  #       keeps the previous revision anyway.
  #   3 = TOKENSCOPE_APP_DATABASE_URL names a credential that is genuinely
  #       broken: unparseable, rejected by the server's AUTHENTICATION (SQLSTATE
  #       class 28), pointed at a database that does not exist (3D000), or
  #       authenticating as somebody else. FATAL — booting would serve 500s from
  #       a deploy that reported healthy.
  #   * = ANY OTHER non-zero code is a code this contract does not define — a
  #       SIGKILL from the OOM killer or a boot timeout exits 128+N. Treated as
  #       unsafe whenever provisioning was requested, because the step may have
  #       committed and died before it could report. (It carries its own deadline
  #       so an overrun classifies itself first; reaching here means something
  #       outside its control killed it.)
  echo "[entrypoint] provisioning app DB role (opt-in)..."
  provision_rc=0
  node node_modules/.bin/tsx drizzle/provision-app-role.ts || provision_rc=$?
  case "$provision_rc" in
    0)
      ;;
    1)
      echo "[entrypoint] app-role provisioning did not finish (non-fatal); see the lines above — the next boot retries"
      ;;
    3)
      echo "[entrypoint] app-role provisioning failed while TOKENSCOPE_APP_DATABASE_URL names a credential that is broken; aborting boot rather than serving 500s from a healthy-looking deploy"
      exit 1
      ;;
    *)
      if [ "${TOKENSCOPE_PROVISION_APP_ROLE:-}" = "true" ]; then
        echo "[entrypoint] app-role provisioning exited with UNDEFINED code ${provision_rc} (128+N conventionally means a signal, typically an OOM kill or a boot timeout, though a script can also return such a value outright) while provisioning was REQUESTED; it may have committed and died before it could verify, so aborting boot"
        exit 1
      fi
      echo "[entrypoint] app-role provisioning exited with unexpected code ${provision_rc}, but provisioning was not requested (non-fatal)"
      ;;
  esac
  # THE CUTOVER SWEEP — a distinct, deliberate, once-per-environment operation,
  # which is why it is its own script with its own opt-in and not a side effect
  # of the step above.
  #
  # FORCE binds the OWNER; a NON-OWNER is bound by ENABLE alone, so the instant
  # the runtime connects as the app role EVERY RLS-enabled table starts
  # filtering — including the ones read before any identity exists, which stops
  # the emit fleet. This DISABLEs row-level security on every RLS-enabled table
  # that is not already FORCEd, then stamps seed_state so it does not re-run.
  #
  # IT NEVER DISABLES A FORCEd TABLE. That is how a rollout phase says
  # "deliberately enabled, hands off", and a boot script reverting one is the
  # defect this split exists to end. A BOOTSTRAP table (read before any identity
  # exists) that is FORCEd is a genuine conflict, and the step refuses (code 4)
  # rather than picking a winner silently.
  #
  # DORMANT BY DEFAULT and safe to leave on: a no-op unless
  # TOKENSCOPE_RLS_CUTOVER_SWEEP=true (Bicep: param runRlsCutoverSweep), and once
  # the ledger is stamped it reports the sweep it WOULD have run and changes
  # nothing. Re-sweeping means bumping RLS_CUTOVER_SWEEP_VERSION, deliberately.
  #
  # EXIT CODES:
  #   1 = the step did not finish and NOTHING WAS COMMITTED. Non-fatal, and the
  #       next boot genuinely does retry. The transaction may have started and
  #       may have run DDL; none of it survives, because every write is in one
  #       transaction and the ledger stamp is inside it.
  #   5 = the ledger MAY be stamped, so the next boot may not retry. Two states
  #       share the code because they share a recovery: the transaction
  #       COMMITTED and verification then failed, or it was IN FLIGHT when the
  #       deadline fired (a deadline can land while Postgres is completing the
  #       COMMIT, and the client is told nothing). Non-fatal. Recovery is to
  #       read the posture and bump the version, never a restart. This code
  #       exists because code 1's "the next boot retries" is FALSE for both,
  #       and a confidently wrong recovery instruction is worse than none.
  #   4 = REFUSED on a §5-vs-§7 conflict. Nothing changed, nothing stamped.
  #       Non-fatal on purpose: refusing is already the safe action, and a boot
  #       loop would strand an environment nobody here can reach (there is no
  #       DBA and no database access) over a question only a human can answer.
  #   * = undefined, i.e. a signal death, and treated as unsafe when the sweep
  #       was requested — a SIGKILL can land after the transaction committed and
  #       before anything reported it.
  echo "[entrypoint] running RLS cutover sweep (opt-in)..."
  sweep_rc=0
  node node_modules/.bin/tsx drizzle/cutover-rls-sweep.ts || sweep_rc=$?
  case "$sweep_rc" in
    0)
      ;;
    1)
      echo "[entrypoint] RLS cutover sweep did not finish and nothing was committed (non-fatal); see the lines above — the next boot retries"
      ;;
    5)
      echo "[entrypoint] RLS cutover sweep: THE LEDGER MAY BE STAMPED (non-fatal) — it either COMMITTED and then failed verification, or was still in flight when its deadline fired. The lines above say which. Do NOT assume the next boot retries: if it committed, every later boot reports and changes nothing. Read the posture, then bump RLS_CUTOVER_SWEEP_VERSION and ship it"
      ;;
    4)
      echo "[entrypoint] RLS cutover sweep REFUSED: a bootstrap table is ENABLEd and FORCEd, which design §5 and §7 disagree about. Nothing was changed and nothing was stamped. Boot continues, but the cutover CANNOT proceed until a human resolves it (see the lines above)"
      ;;
    *)
      if [ "${TOKENSCOPE_RLS_CUTOVER_SWEEP:-}" = "true" ]; then
        echo "[entrypoint] RLS cutover sweep exited with UNDEFINED code ${sweep_rc} (128+N conventionally means a signal, typically an OOM kill or a boot timeout, though a script can also return such a value outright) while the sweep was REQUESTED; it may have committed and died before it could verify, so aborting boot"
        exit 1
      fi
      echo "[entrypoint] RLS cutover sweep exited with unexpected code ${sweep_rc}, but the sweep was not requested (non-fatal)"
      ;;
  esac
  # Bootstrap the real regions on a FRESH database only (SEED_REGIONS_IF_EMPTY
  # makes it a no-op when any region exists), so first Entra sign-in can
  # JIT-provision instead of failing on "no region rows". Idempotent + safe on
  # every replica restart. Non-fatal: a hiccup here must not take the app down,
  # and the next boot retries.
  echo "[entrypoint] ensuring bootstrap regions..."
  SEED_REGIONS_IF_EMPTY=true node node_modules/.bin/tsx drizzle/seed-regions.ts || \
    echo "[entrypoint] region bootstrap failed (non-fatal); first sign-in may loop until regions exist"
  # Bootstrap the canonical org structure (each region's BU/practice tree). VERSIONED:
  # SEED_ORG_STRUCTURE_IF_OUTDATED applies it only while seed_state.version is behind the
  # seed's SEED_ORG_STRUCTURE_VERSION (a fresh DB, or a deliberate version bump rolling a
  # structural change to every env on its next deploy), then no-ops — never overriding manual
  # UI edits. Same migrate-on-boot discipline as the region bootstrap above; non-fatal so a
  # hiccup can't take the app down.
  echo "[entrypoint] ensuring org structure (versioned)..."
  SEED_ORG_STRUCTURE_IF_OUTDATED=true node node_modules/.bin/tsx drizzle/seed-org-structure.ts || \
    echo "[entrypoint] org-structure seed failed (non-fatal); structure can be seeded later"
else
  echo "[entrypoint] DATABASE_URL unset; skipping migrations"
fi

# THE BINDING GATE. Last thing before the server, because it is the only step
# whose question is about the state the SERVER is about to bind to rather than
# about work a boot step just did.
#
# Dormant unless TOKENSCOPE_APP_DATABASE_URL is set — i.e. unless someone has
# deliberately asked the runtime pools to connect as the non-owner role. Every
# other deploy pays nothing: no connection, no query.
#
# FATAL on purpose, and it is the cheap direction. The three cutover flags have
# a load-bearing order that was previously enforced by a comment in the Bicep
# param block; `useAppRoleAtRuntime` set on its own boots the app as a non-owner
# against tables that still filter it, the bearer lookup returns zero rows for
# every device, and the deploy stays green while the emit fleet stops. Refusing
# fails the revision instead, so the PREVIOUS revision keeps serving and the
# reason is named. This is also what lets the sweep's exit 4 stay non-fatal:
# refusing to sweep is safe while the owner still connects, and this gate is
# armed exactly when it stops being safe.
if [ -n "${TOKENSCOPE_APP_DATABASE_URL:-}" ]; then
  echo "[entrypoint] checking it is safe to bind the runtime to the app role..."
  node node_modules/.bin/tsx drizzle/assert-runtime-rls-safe.ts || {
    echo "[entrypoint] REFUSING TO START: the runtime is configured to connect as the app role, but the schema is not ready for it (see the lines above). The previous revision keeps serving; booting this one would stop the emit fleet behind a healthy-looking deploy"
    exit 1
  }
  # The server reads only the app-role URL once it is set (drizzle/connect.ts
  # runtimeDatabaseUrl), so the owner's credential leaves its environment. This
  # stops an env dump disclosing it; it does not stop code running as the app's
  # identity from reading the same Key Vault secret.
  unset DATABASE_URL
fi

echo "[entrypoint] starting Nitro server on :${NITRO_PORT:-3000}..."
exec node .output/server/index.mjs
