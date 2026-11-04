// @vitest-environment node
/*
 * entrypoint.sh READS THE PROVISIONING EXIT CODE, and the codes mean different
 * things.
 *
 * `drizzle/provision-app-role.ts` runs its whole change in one transaction, so:
 *   1 = the step did not finish. Boot carries on and the next boot retries. A
 *       failed run cannot have broken the runtime's credential: the step sets a
 *       password only when it CREATEs the role, or when rotation was explicitly
 *       requested. A database it could not REACH lands here too — no credential
 *       change fixes DNS or a server that is down.
 *   3 = `TOKENSCOPE_APP_DATABASE_URL` names a credential that is genuinely
 *       broken: unparseable, refused by the server, or authenticating as someone
 *       else. Booting would serve 500s while the deploy read healthy.
 *   * = ANY OTHER non-zero code is undefined by that contract. A SIGKILL — the
 *       OOM killer, a boot timeout — exits 128+N, and it can land after the
 *       transaction committed and before anything reported it. The old shell
 *       took the `-ne 0` branch, logged "rolled back… non-fatal", and booted on a
 *       credential it had never verified.
 *
 * EXIT 2 IS GONE, and its absence is asserted below rather than merely omitted.
 * It meant "the run COMMITTED and could not verify", and it existed because
 * EVERY boot rotated, so any commit might have moved the password out from under
 * a live replica. Rotation is now opt-in and off by default — a boot with
 * `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` still rotates, so "no boot rotates"
 * would be false — but that was never the right question anyway: whether BOOT IS
 * SAFE is answered by probing the runtime's own credential, which is exit 3, and
 * it is answered identically whether the run rotated, created or did nothing.
 * So a 2 from an image is a code this shell does not define, and it lands in the
 * `*` branch, which is the conservative answer for a state nobody can describe.
 *
 * THE CUTOVER SWEEP IS A SECOND STEP with a fourth code of its own (4 = refused
 * on a §5-vs-§7 conflict), asserted in its own describe below.
 *
 * Nothing else in the suite can see this: the provisioning tests assert the exit
 * codes the SCRIPT produces, and the shell that acts on them is not TypeScript.
 * So this runs the real `entrypoint.sh` with a stub `node` on PATH that returns
 * a chosen code — or genuinely dies by signal — for the step under test and 0
 * for every other step, and reads what the shell did with it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, writeFile, rm, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const ROOT = resolve(__dirname, '../../..')

/*
 * Every step entrypoint.sh runs is `node …`. The stub answers for all of them:
 * the provisioning step returns STUB_PROVISION_RC — or SIGKILLs ITSELF when
 * STUB_PROVISION_SIGNAL=1, which is the only honest way to produce the 137 an
 * OOM kill produces, since `exit 137` and a real signal death are not the same
 * event to the shell that reaps them — the final `exec node
 * .output/server/index.mjs` prints a marker so "did boot continue?" is
 * observable, and everything else succeeds.
 */
const STUB = `#!/usr/bin/env bash
case "$*" in
  *provision-app-role.ts*)
    if [ "\${STUB_PROVISION_SIGNAL:-}" = "1" ]; then
      kill -KILL $$
      sleep 30
    fi
    exit "\${STUB_PROVISION_RC:-0}" ;;
  *cutover-rls-sweep.ts*)
    if [ "\${STUB_SWEEP_SIGNAL:-}" = "1" ]; then
      kill -KILL $$
      sleep 30
    fi
    exit "\${STUB_SWEEP_RC:-0}" ;;
  *assert-runtime-rls-safe.ts*)
    echo "STUB-GATE-RAN"
    exit "\${STUB_GATE_RC:-0}" ;;
  *index.mjs*)             echo "STUB-SERVER-STARTED owner-url=\${DATABASE_URL:-unset}"; exit 0 ;;
  *)                       exit 0 ;;
esac
`

let stubDir = ''

beforeAll(async () => {
  stubDir = await mkdtemp(join(tmpdir(), 'ts-entrypoint-'))
  const bin = join(stubDir, 'node')
  await writeFile(bin, STUB)
  await chmod(bin, 0o755)
})

afterAll(async () => {
  if (stubDir) await rm(stubDir, { recursive: true, force: true })
})

async function runEntrypoint(extra: Record<string, string>): Promise<{ code: number; out: string }> {
  try {
    const { stdout, stderr } = await exec('bash', ['entrypoint.sh'], {
      cwd: ROOT,
      env: {
        PATH: `${stubDir}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        DATABASE_URL: 'postgresql://stub/stub',
        ...extra,
      },
      timeout: 30_000,
    })
    return { code: 0, out: `${stdout}${stderr}` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

describe('entrypoint.sh and the app-role provisioning exit code', () => {
  it('exit 0: boot continues, no complaint', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_RC: '0' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('STUB-SERVER-STARTED')
    expect(r.out).not.toContain('aborting boot')
  })

  it('exit 1 (the step did not finish): boot continues, and says so', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_RC: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('non-fatal')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  /*
   * The deploy shape this exists for: provisioning AND the runtime cutover both
   * on, and provisioning cannot proceed (no password, no route to CREATEROLE, a
   * refusal). The old code exited 1 and the entrypoint booted — on a role that
   * may not exist, behind a URL that names it.
   */
  it('exit 3 (the runtime credential is broken): boot ABORTS', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_RC: '3' })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('credential that is broken')
    expect(r.out).toContain('aborting boot')
    expect(r.out, 'the server must never start after a 3').not.toContain('STUB-SERVER-STARTED')
  })

  /*
   * EXIT 2 IS NO LONGER A CODE THIS CONTRACT DEFINES. It described "committed
   * and unverified", a state whose only danger was a rotated password, and no
   * boot rotates. A 2 arriving anyway — a stale image, say — must NOT be quietly
   * treated as the old "abort with an explanation": the shell has no explanation
   * to give, so it takes the undefined-code branch. Asserting it here is what
   * stops a future edit re-adding a `2)` case that describes behaviour the
   * script no longer has.
   */
  it('exit 2 is undefined now: with provisioning requested it aborts as an unknown code', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_RC: '2', TOKENSCOPE_PROVISION_APP_ROLE: 'true' })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('UNDEFINED code 2')
    expect(r.out, 'the shell must not still be claiming a verification story').not.toContain('COULD NOT VERIFY')
    expect(r.out).not.toContain('STUB-SERVER-STARTED')
  })

  /*
   * A SIGNAL-KILLED CHILD, not a chosen exit code. The process is killed with
   * SIGKILL exactly as the OOM killer or a boot-timeout would kill it, which is
   * the case that used to be misreported: 137 is neither 0, 1, 2 nor 3, the
   * shell took the `-ne 0` branch, printed "rolled back… non-fatal", and booted
   * — even though a kill can land after `sql.begin()` has committed and before
   * `verify()` has run, which is precisely the state exit 2 refuses.
   */
  it('a SIGKILLed child while provisioning was REQUESTED: boot ABORTS and says the code is undefined', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_SIGNAL: '1', TOKENSCOPE_PROVISION_APP_ROLE: 'true' })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out, 'the shell must name the code it could not interpret').toContain('UNDEFINED code 137')
    expect(r.out).toContain('aborting boot')
    expect(r.out, 'it must NOT claim the transaction rolled back').not.toContain('nothing committed (non-fatal)')
    expect(r.out, 'the server must never start after an undefined code').not.toContain('STUB-SERVER-STARTED')
  })

  /*
   * The other half: with no opt-in the script exits 0 whatever else is wrong, so
   * an odd code means the RUNNER broke (a missing tsx, say), not provisioning.
   * Aborting every boot on that would be a worse failure than the one it guards.
   */
  it('a SIGKILLed child while provisioning was NOT requested: boot continues', async () => {
    const r = await runEntrypoint({ STUB_PROVISION_SIGNAL: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('unexpected code 137')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })
})

/*
 * ── THE CUTOVER SWEEP IS A SECOND STEP, WITH A CODE PROVISIONING DOES NOT HAVE
 *
 * Exit 4 = "a bootstrap table is ENABLEd and FORCEd, design §5 and §7 disagree
 * about it, and this step will not pick a winner". It changed nothing and
 * stamped nothing, so refusing is already the safe action — and a boot loop
 * would strand an environment nobody here can reach over a question only a human
 * can answer. So it is LOUD and NON-FATAL, and both halves are asserted:
 * "non-fatal" is worthless if nothing says why the cutover has stopped.
 */
describe('entrypoint.sh and the RLS cutover sweep exit code', () => {
  it('runs the sweep as its own step, after provisioning', () => {
    const sh = readFileSync(resolve(ROOT, 'entrypoint.sh'), 'utf8')
    const provisionAt = sh.indexOf('tsx drizzle/provision-app-role.ts')
    const sweepAt = sh.indexOf('tsx drizzle/cutover-rls-sweep.ts')
    expect(provisionAt, 'provisioning still runs').toBeGreaterThan(-1)
    expect(sweepAt, 'the sweep is a step of its own, not a branch inside provisioning').toBeGreaterThan(provisionAt)
  })

  it('exit 0: boot continues', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_RC: '0' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  it('exit 1 (the sweep did not finish): boot continues, and says so', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_RC: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('RLS cutover sweep did not finish')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  /*
   * Exit 5 exists because exit 1's message is FALSE for this state. The ledger
   * is stamped inside the same transaction as the DDL, so once that commits,
   * every later boot reads the stamp, takes the report-only branch and exits 0
   * — it does not retry, ever. Telling an operator "the next boot retries"
   * there converts an unenforced table into a repeating log line nobody acts
   * on, which is worse than saying nothing.
   */
  it('exit 5 (the ledger may be stamped): boot continues, and does NOT claim a retry', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_RC: '5', TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('THE LEDGER MAY BE STAMPED')
    expect(r.out, 'the operator must be told not to expect the retry').toContain('Do NOT assume')
    expect(r.out, 'and what actually resolves it').toContain('RLS_CUTOVER_SWEEP_VERSION')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  it('the exit-5 branch does not make the retry claim that only exit 1 earns', () => {
    const sh = readFileSync(resolve(ROOT, 'entrypoint.sh'), 'utf8')
    const five = sh.slice(sh.indexOf('    5)'), sh.indexOf('    4)'))
    expect(five, 'and it must actively warn against the assumption').toMatch(
      /Do NOT assume the next boot retries/i,
    )
    /*
     * Strip the DENIAL before looking for the CLAIM. An earlier version of this
     * assertion just searched for the phrase, so it fired on the very sentence
     * that exists to refute it — a guard cannot tell a claim from its negation
     * by substring alone.
     */
    const withoutDenial = five.replace(/Do NOT assume the next boot retries/gi, '')
    expect(
      withoutDenial,
      'the committed-or-unknown branch must never assert that the next boot retries',
    ).not.toMatch(/the next boot retries/i)
  })

  it('exit 4 (a bootstrap table is FORCEd): boot continues, but the refusal is unmissable', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_RC: '4', TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('REFUSED')
    expect(r.out, 'it must say nothing was changed, or an operator assumes a partial sweep').toContain(
      'Nothing was changed and nothing was stamped',
    )
    expect(r.out, 'and that the cutover is blocked until a human answers it').toContain('CANNOT proceed')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  /*
   * ── THE BINDING GATE ────────────────────────────────────────────────────
   *
   * The three cutover flags have a load-bearing order that Bicep deliberately
   * does NOT couple (the steady state after a successful cutover is
   * runRlsCutoverSweep=false with useAppRoleAtRuntime=true, which a template
   * AND would make un-expressible). So the ordering is enforced here, at boot,
   * and these cases are what make it an enforced property rather than prose.
   */
  it('does not run the gate at all when the runtime is not bound to the app role', async () => {
    const r = await runEntrypoint({})
    expect(r.code, r.out).toBe(0)
    expect(r.out, 'an unrelated deploy must not pay for this step').not.toContain('STUB-GATE-RAN')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })

  it('runs the gate when TOKENSCOPE_APP_DATABASE_URL is set, before the server', async () => {
    const r = await runEntrypoint({ TOKENSCOPE_APP_DATABASE_URL: 'postgresql://stub/app' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('STUB-GATE-RAN')
    expect(
      r.out.indexOf('STUB-GATE-RAN'),
      'the gate is pointless after the server has already bound',
    ).toBeLessThan(r.out.indexOf('STUB-SERVER-STARTED'))
  })

  it('once bound to the app role, the server starts WITHOUT the owner DATABASE_URL in its environment', async () => {
    const r = await runEntrypoint({ TOKENSCOPE_APP_DATABASE_URL: 'postgresql://stub/app' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('STUB-SERVER-STARTED owner-url=unset')
  })

  it('not bound to the app role, the server keeps DATABASE_URL — it is the runtime credential', async () => {
    const r = await runEntrypoint({})
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('STUB-SERVER-STARTED owner-url=postgresql://stub/stub')
  })

  it('a REFUSING gate ABORTS the boot — the server must never start unsafely bound', async () => {
    const r = await runEntrypoint({ TOKENSCOPE_APP_DATABASE_URL: 'postgresql://stub/app', STUB_GATE_RC: '6' })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('REFUSING TO START')
    expect(
      r.out,
      'booting here stops the emit fleet behind a green deploy — the whole reason the gate is fatal',
    ).not.toContain('STUB-SERVER-STARTED')
  })

  it('a SIGKILLed sweep while it was REQUESTED: boot ABORTS on the undefined code', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_SIGNAL: '1', TOKENSCOPE_RLS_CUTOVER_SWEEP: 'true' })
    expect(r.code, r.out).not.toBe(0)
    expect(r.out).toContain('UNDEFINED code 137')
    expect(r.out).toContain('aborting boot')
    expect(r.out, 'the server must never start after an undefined code').not.toContain('STUB-SERVER-STARTED')
  })

  it('a SIGKILLed sweep while it was NOT requested: boot continues', async () => {
    const r = await runEntrypoint({ STUB_SWEEP_SIGNAL: '1' })
    expect(r.code, r.out).toBe(0)
    expect(r.out).toContain('unexpected code 137')
    expect(r.out).toContain('STUB-SERVER-STARTED')
  })
})
