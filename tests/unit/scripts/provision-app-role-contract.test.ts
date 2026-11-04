// @vitest-environment node
/*
 * THREE CLASSES THAT NO OTHER GATE IN THIS REPO CAN SEE, all of which shipped on
 * this branch once already.
 *
 * 1. POST-COMMIT CODE THAT SITS OUTSIDE THE POST-COMMIT GUARD.
 *    `reportProvisioning(report)` used to run between `sql.begin()` returning and
 *    the `try` that reports the run as committed. A throw there — formatting a
 *    report about a database that had already been changed — came out claiming
 *    "the transaction was rolled back". There is no runtime way to make a
 *    `console.warn` throw in a child process, so the ordering is asserted against
 *    the SOURCE. That is a weaker instrument than a behavioural test and it is
 *    the right one here: the defect is positional, and position is exactly what a
 *    source assertion can see.
 *
 * 2. PROSE THAT DESCRIBES BEHAVIOUR THE CODE NO LONGER HAS.
 *    Three Bicep files tell the operator what `provisionAppRole` does, and they
 *    have been wrong twice: once when they said the sweep was bootstrap-only, and
 *    again when they said the flag "re-syncs the role if the password is ever
 *    rotated" — which was true when every boot rotated and became false the day
 *    that stopped. Nothing recompiles a comment (CLAUDE.md rule 17).
 *
 * 3. A STARTUP BUDGET THAT NO LONGER FITS THE PROBE.
 *    The step runs inside the container's Startup probe window. Nothing type-
 *    checks a timeout against a Bicep probe, so the two drift silently and the
 *    symptom is a SIGKILL — an exit code the entrypoint contract does not define.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const ROOT = resolve(__dirname, '../../..')

/**
 * Read the files that SHIP, not the files we hoped for.
 *
 * The public snapshot drops internal paths (tools/publish/internal-only-paths.txt),
 * so a guard that reads one unconditionally throws ENOENT there — red CI on the
 * public mirror over a file that was never going to exist. That is exactly how
 * `infra/parameters/dev.bicepparam` and `docs/design/rls-enforcement.md` broke
 * the public suite.
 *
 * Tolerant of absence, STRICT about coverage: `min` is the number that must be
 * present, so this can never quietly degrade into checking nothing. Internally
 * every path is there and the guard is at full strength.
 */
function readPresent(paths: readonly string[], min: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const p of paths) {
    const abs = resolve(ROOT, p)
    // Internally every file is read, so a missing one fails; the public
    // snapshot reads what it ships.
    if (!PUBLIC_SNAPSHOT || existsSync(abs)) out[p] = readFileSync(abs, 'utf8')
  }
  expect(
    Object.keys(out).length,
    `only ${Object.keys(out).length} of ${paths.length} guarded files were found; this guard is degrading`,
  ).toBeGreaterThanOrEqual(min)
  return out
}
const script = readFileSync(resolve(ROOT, 'drizzle/provision-app-role.ts'), 'utf8')

describe('everything after the COMMIT is inside the post-commit guard', () => {
  it('opens the guard immediately after the commit, with nothing executable in between', () => {
    const commitAt = script.indexOf('const report = await commitProvisioning(')
    expect(commitAt, 'the commit call moved or was renamed — re-read main() before touching this test').toBeGreaterThan(
      -1,
    )
    const commitLineEnd = script.indexOf('\n', commitAt)
    const tryAt = script.indexOf('try {', commitLineEnd)
    expect(tryAt, 'no try after the commit at all').toBeGreaterThan(commitLineEnd)

    // Comments may sit between them; statements may not. This is the assertion
    // that goes red when a post-commit call is hoisted above the guard, which is
    // exactly how `reportProvisioning` escaped it.
    const between = script
      .slice(commitLineEnd, tryAt)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/[^\n]*/g, '')
      .trim()
    expect(
      between,
      'a statement between the COMMIT and the guard is reported as "nothing was committed", which boots',
    ).toBe('')
  })

  it('records the commit, reports and verifies inside that try', () => {
    const commitAt = script.indexOf('const report = await commitProvisioning(')
    const tryAt = script.indexOf('try {', script.indexOf('\n', commitAt))
    const catchAt = script.indexOf('} catch (err) {', tryAt)
    expect(catchAt).toBeGreaterThan(tryAt)

    const guarded = script.slice(tryAt, catchAt)
    /*
     * `progress.committed` is what the exit path reads to decide whether it may
     * say "nothing was committed". Set it anywhere else — later than the first
     * post-commit statement, say — and every failure in between reports a false
     * statement about a database that HAS been changed.
     */
    expect(guarded.indexOf('progress.committed = true'), 'the commit must be recorded first').toBeGreaterThan(-1)
    expect(guarded.indexOf('progress.committed = true')).toBeLessThan(guarded.indexOf('reportProvisioning(report)'))
    expect(guarded).toContain('reportProvisioning(report)')
    expect(guarded).toContain('verify(sql, url, password, report)')
  })

  /*
   * entrypoint.sh and tests/unit/scripts/entrypoint-provision-exit-code.test.ts
   * both hard-code these numbers — the shell cannot import a TypeScript
   * constant. Changing one without the other is silent.
   */
  it('pins the exit code the shell reads, and no longer defines the rotation-era one', () => {
    expect(script).toContain('const EXIT_UNSAFE_TO_BOOT = 3')
    /*
     * Exit 2 was "the run COMMITTED and could not verify the result", and it
     * existed because EVERY boot rotated, so any commit might have moved the
     * password out from under a live replica.
     *
     * THE PREVIOUS VERSION OF THIS COMMENT SAID "no boot rotates now".
     * That is FALSE and it is asserted
     * against below: `TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true` still rotates, in
     * the same transaction. What actually retired exit 2 is that "did this run
     * verify?" was never the right question — whether BOOT IS SAFE is answered
     * by probing the runtime's own credential, which is exit 3, and it is
     * answered identically whether this run rotated, created or did nothing.
     */
    expect(script, 'exit 2 went out with rotate-on-every-boot').not.toContain('EXIT_COMMITTED_UNVERIFIED')
    expect(script).not.toContain('CommittedButUnverified')
  })

  /*
   * THE FALSE ABSOLUTE, GATED. "No boot rotates" was written in three files and
   * was wrong in all three the moment TOKENSCOPE_ROTATE_APP_DB_PASSWORD existed.
   * It is the exact class CLAUDE.md rule 17 is about — a sentence that was true
   * when written and false by the time it shipped — and nothing recompiles a
   * comment, so it gets a machine.
   */
  it('no file in this contract claims that a boot never rotates', () => {
    /*
     * THE DESIGN DOC is in this list because it is where the claim actually
     * shipped: this guard was written for exactly that false absolute and then
     * scoped to the code files only, so §9 went on saying "boot does not
     * rotate" for three more rounds and a claims audit found it rather than the
     * machine built to. A guard that does not cover the document the operator
     * reads is guarding the wrong surface.
     *
     * `docs/design/` and `infra/parameters/` are dropped from the public
     * snapshot, hence readPresent: full strength internally, no ENOENT there.
     */
    const files = {
      'drizzle/provision-app-role.ts': script,
      ...readPresent(
        [
          'scripts/rls-roles.ts',
          'entrypoint.sh',
          'tests/unit/scripts/entrypoint-provision-exit-code.test.ts',
          'tests/unit/scripts/provision-app-role-contract.test.ts',
          'docs/design/rls-enforcement.md',
          'infra/main.bicep',
        ],
        5,
      ),
    }
    // The three spellings that actually shipped, plus the shape they share.
    const falseAbsolute = /\bno boot (rotates|does that)|\bnothing rotates\b|boot no longer rotates/i
    for (const [name, src] of Object.entries(files)) {
      const offenders = src
        .split('\n')
        .map((line, i) => [i + 1, line] as const)
        // QUOTING the false sentence in order to retire it is not asserting it,
        // so a fully-quoted span is stripped before the line is judged. Keep
        // such a citation on ONE line or this cannot see the quotes.
        .filter(([, line]) => falseAbsolute.test(line.replace(/"[^"]*"/g, '""')))
        // …and the pattern's own definition necessarily contains the pattern.
        .filter(([, line]) => !line.includes('const falseAbsolute'))
      expect(
        offenders.map(([n, l]) => `${name}:${n} ${l.trim()}`),
        `${name} states an absolute the code does not honour — TOKENSCOPE_ROTATE_APP_DB_PASSWORD=true rotates an existing role's password at boot`,
      ).toEqual([])
    }
  })

  /*
   * ── PROVISIONING DOES NOT TOUCH RLS POSTURE, STRUCTURALLY ──────────────────
   *
   * The sweep lived here and its trigger was wrong THREE adversarial rounds
   * running — every boot, then only on the boot that created the role, then on a
   * version ledger that could authorise reverting a rollout phase. The fix was
   * not a fourth predicate; it was moving the sweep out, because "when should
   * PROVISIONING sweep?" has no right answer.
   *
   * So the property to hold is not "the predicate is correct" — it is THAT THERE
   * IS NO PREDICATE HERE AT ALL. A grep is the right instrument: it goes red the
   * moment somebody adds one back, which is exactly the recurrence.
   */
  it('contains no statement that can change RLS posture', () => {
    const rlsDdl = /ALTER TABLE[^\n]*ROW LEVEL SECURITY|DISABLE ROW LEVEL SECURITY|FORCE ROW LEVEL SECURITY/gi
    const hits = script
      .split('\n')
      .map((line, i) => [i + 1, line] as const)
      // Prose may (and should) explain what the sweep does; only code counts.
      .filter(([, line]) => !/^\s*(\*|\/\*|\/\/)/.test(line))
      .filter(([, line]) => rlsDdl.test(line))
    expect(
      hits.map(([n, l]) => `${n}: ${l.trim()}`),
      'provisioning creates a role; the cutover sweep is drizzle/cutover-rls-sweep.ts and its own opt-in',
    ).toEqual([])
  })

  it('keeps no sweep ledger of its own, so no ledger here can authorise reverting a phase', () => {
    expect(script, 'the sweep ledger belongs to drizzle/cutover-rls-sweep.ts').not.toContain('seed_state')
    expect(script).not.toContain('RLS_CUTOVER_SWEEP_VERSION')
    expect(script).not.toContain('RLS_CUTOVER_SWEEP_SEED_NAME')
  })

  /*
   * …AND ITS POSTURE READ-BACK IS A REPORT, NOT AN ASSERTION. Making it fatal
   * would turn design §7 phase 2 — which deliberately re-ENABLEs org_unit,
   * teammate and instance_attestation — into an un-bootable image that nobody on
   * this project has the database access to repair.
   */
  it('reports the RLS posture instead of failing verification on it', () => {
    const verifyBody = script.slice(
      script.indexOf('async function verify('),
      script.indexOf('const RECOVERY_TAKE_RUNTIME_OFF_THE_ROLE'),
    )
    expect(verifyBody, 'the read-back is still there — this is a report, not a removal').toContain('RLS posture NOTE')
    const postureAt = verifyBody.indexOf('const bootstrapStillEnabled')
    const afterPosture = verifyBody.slice(postureAt, verifyBody.indexOf('const configured = process.env'))
    expect(
      afterPosture,
      'a throw between the posture read and the credential probe is an assertion about state this step does not own',
    ).not.toContain('throw new Error')
  })

  /*
   * THE PASSWORD RULE, asserted structurally rather than by reading the prose.
   * There must be exactly TWO statements in this file that set a password, and
   * both must be reachable only from the create path or the explicit flag.
   */
  it('has exactly two password statements, and the rotation one is behind the explicit flag', () => {
    const passwordStatements = [...script.matchAll(/ALTER ROLE %I PASSWORD %L/g)]
    expect(passwordStatements, 'one for CREATE, one for the deliberate rotation — no third path').toHaveLength(2)
    expect(script).toContain("process.env.TOKENSCOPE_ROTATE_APP_DB_PASSWORD === 'true'")
    // The rotation statement is inside `if (rotate)`, not beside it.
    const rotateBranch = script.slice(script.indexOf('if (rotate) {'), script.indexOf('if (cap.setRoleTo) await tx.unsafe'))
    expect(rotateBranch).toContain('ALTER ROLE %I PASSWORD %L')
  })

  /*
   * ── THE DEADLINE MUST REACH THE CLASSIFIER ────────────────────────────────
   *
   * It used to `process.exit(1)` from inside the timer callback, which skipped
   * the `finally` AND the exit path at the bottom of the file — so a deadline
   * could never produce exit 3 however broken the runtime's credential was, on
   * the run that had least idea what it had left behind. Its own comment claimed
   * "the run classifies itself first".
   *
   * The behavioural proof is in the integration suite (the timer really fires
   * mid-run there). This is the positional half: no `process.exit` may live
   * inside the timer again.
   */
  it('the deadline rejects into the ordinary exit path rather than exiting from the timer', () => {
    const budgetBlock = script.slice(script.indexOf('const budget = new Promise'), script.indexOf('await Promise.race'))
    expect(budgetBlock, 'the deadline is a race the run loses, not an exit').toContain('reject(')
    expect(budgetBlock, 'exiting from the timer skips the credential classifier and the finally').not.toContain(
      'process.exit',
    )
    expect(script).toContain('await Promise.race([provisionRun(url, password, rotate), budget])')
  })

  /*
   * …AND IT MUST BE ABLE TO SAY "I DO NOT KNOW". A deadline can fire while
   * Postgres is completing the COMMIT: `sql.begin()` has not returned, so the
   * old code printed "Nothing was committed" about a database that may well have
   * been changed — on the exit code that tells the entrypoint to boot anyway.
   */
  it('has a third progress state for a transaction that was in flight', () => {
    expect(script).toContain('progress.txStarted = true')
    const progressBody = script.slice(script.indexOf('function progressLine('), script.indexOf('function abortReason('))
    expect(progressBody).toContain('progress.committed')
    expect(progressBody).toContain('progress.txStarted')
    expect(progressBody, 'the honest answer for the commit window').toContain('OUTCOME IS UNKNOWN')
    // The order matters: committed must be checked before txStarted, or a
    // completed run reports itself as unknown.
    expect(progressBody.indexOf('progress.committed')).toBeLessThan(progressBody.indexOf('progress.txStarted'))
  })

  /*
   * …AND "IN FLIGHT" MUST MEAN "OUTCOME NOT OBSERVED", not merely "a transaction
   * was issued. When `sql.begin` REJECTS, postgres.js has already rolled back —
   * reporting that as unknown would be a worse answer than the true one, and it
   * would leak into the atomicity path, which is the most-read failure message
   * this script has.
   */
  it('clears the in-flight flag as soon as the transaction settles, either way', () => {
    const body = script.slice(
      script.indexOf('async function commitProvisioning('),
      script.indexOf('function reportProvisioning('),
    )
    expect(body, 'set before the begin').toContain('progress.txStarted = true')
    expect(body, 'and cleared on rejection, because a rejection means ROLLBACK').toMatch(
      /catch \(err\) \{\s*progress\.txStarted = false/,
    )
    // …and cleared on success too, after `committed` is set, so there is no
    // instant where both are false and the run reports "nothing was committed".
    const guard = script.slice(script.indexOf('progress.committed = true'))
    expect(guard.indexOf('progress.txStarted = false')).toBeGreaterThan(-1)
    expect(guard.indexOf('progress.txStarted = false')).toBeLessThan(guard.indexOf('reportProvisioning(report)'))
  })

  /*
   * ── THE ABORT DECISION IS WRITTEN ONCE ────────────────────────────────────
   * It is asked from the dormant path and from the failure path, and two copies
   * is how the recovery texts drifted apart the first time.
   */
  it('decides abort-or-boot in one place, shared by the dormant and failure paths', () => {
    expect(script).toContain('function abortReason(')
    const callSites = [...script.matchAll(/abortReason\(cred\)/g)]
    expect(callSites.length, 'the dormant path and the failure path both ask it').toBe(2)
    const exits = [...script.matchAll(/process\.exit\(EXIT_UNSAFE_TO_BOOT\)/g)]
    expect(exits.length, 'and each one exits through the same code').toBe(2)
  })

  /*
   * "The server answered" IS NOT AN AUTHENTICATION CLASSIFIER. `3D000` (the
   * database does not exist) and `53300` (too many connections for role) are
   * both server answers, and the recovery text used to tell an operator to
   * rotate a password that could fix neither.
   */
  it('classifies the runtime credential on the SQLSTATE that means auth failure', () => {
    expect(script).toContain("return typeof code === 'string' && code.startsWith('28')")
    expect(script).toContain("const MISSING_DATABASE = '3D000'")
    expect(script, 'the old single bucket is gone').not.toMatch(/state: 'refused'/)
    for (const state of ['auth-failed', 'no-database', 'server-error', 'unreachable']) {
      expect(script, `${state} is a distinguishable outcome`).toContain(`state: '${state}'`)
    }
  })
})

describe('the Bicep prose describes the step that actually runs', () => {
  // dev.bicepparam is dropped from the public snapshot (it carries the real
  // subscription/VNet identifiers), so it is read only when present.
  const files = readPresent(
    [
      'infra/modules/container-app.bicep',
      'infra/main.bicep',
      'infra/parameters/dev.bicepparam',
    ],
    2,
  )

  it.each(Object.entries(files))('%s does not claim the sweep is bootstrap-only', (_name, src) => {
    // The exact sentence all three carried, and the belief it creates.
    expect(src.toLowerCase()).not.toContain('row-level security on the bootstrap tables')
    expect(src.toLowerCase()).not.toContain('opens the bootstrap tables')
  })

  it.each(Object.entries(files))('%s does not tell the operator a boot re-syncs the password', (_name, src) => {
    /*
     * All three said `provisionAppRole` "re-syncs the role if the password is
     * ever rotated". That was TRUE while every boot rotated. It is now the
     * opposite of what the step does, and an operator who believes it will
     * rotate the Key Vault secret and wait for a restart that never applies it.
     */
    expect(src.toLowerCase()).not.toContain('re-syncs the role if the password')
    expect(src.toLowerCase()).not.toContain('re-sync the role')
  })

  it('container-app.bicep says the sweep runs once, where the operator reads the flag', () => {
    expect(files['infra/modules/container-app.bicep']).toContain('THE SWEEP RUNS ONCE')
  })

  /*
   * ── THE FLAG THE SWEEP ACTUALLY MOVED TO ──────────────────────────────────
   *
   * A parameter nothing reads is not a feature (CLAUDE.md rule 16), and a rename
   * is not done until you grep for the old route (rule 15). The sweep left
   * provisionAppRole and needs its own env var to reach the container, or
   * "the cutover is its own deliberate step" is a sentence in a comment.
   */
  it('runRlsCutoverSweep is wired all the way to the container env var', () => {
    expect(files['infra/main.bicep']).toContain('param runRlsCutoverSweep bool = false')
    expect(files['infra/main.bicep']).toMatch(/runRlsCutoverSweep:\s*runRlsCutoverSweep/)
    expect(files['infra/modules/container-app.bicep']).toContain('param runRlsCutoverSweep bool = false')
    expect(files['infra/modules/container-app.bicep']).toContain("name: 'TOKENSCOPE_RLS_CUTOVER_SWEEP'")
    // …and the script that reads it gates on exactly that spelling.
    expect(readFileSync(resolve(ROOT, 'drizzle/cutover-rls-sweep.ts'), 'utf8')).toContain(
      "process.env.TOKENSCOPE_RLS_CUTOVER_SWEEP !== 'true'",
    )
    // …and entrypoint.sh actually runs it, or the flag is decoration.
    expect(readFileSync(resolve(ROOT, 'entrypoint.sh'), 'utf8')).toContain('tsx drizzle/cutover-rls-sweep.ts')
  })

  /**
   * The `@description('…')` a Bicep parameter carries, which is what an operator
   * reads in the portal and in `az deployment ... what-if`.
   */
  function paramDescription(src: string, param: string): string {
    const at = src.indexOf(`param ${param} bool`)
    expect(at, `no \`param ${param} bool\` in this template`).toBeGreaterThan(-1)
    const start = src.lastIndexOf("@description('", at)
    expect(start, `${param} has no @description`).toBeGreaterThan(-1)
    return src.slice(start, at)
  }

  /*
   * THE PROSE MUST FOLLOW THE CODE. Both templates told the operator that
   * `provisionAppRole` runs the cutover sweep. It no longer does, and a comment
   * is the one artefact nothing recompiles (CLAUDE.md rule 17).
   */
  it.each(['infra/main.bicep', 'infra/modules/container-app.bicep'])(
    '%s does not tell the operator that provisionAppRole sweeps',
    (name) => {
      const desc = paramDescription(files[name as keyof typeof files], 'provisionAppRole')
      expect(desc, 'provisionAppRole creates a role; it does not touch RLS').not.toMatch(/run the .{0,40}sweep/i)
      expect(desc, 'and it says so where the operator reads it').toMatch(/does NOT change row-level security/i)
    },
  )

  it('all three name the rotation flag as the only path that moves an existing password', () => {
    for (const [name, src] of Object.entries(files)) {
      expect(src, `${name} must name the flag`).toContain('rotateAppDbPassword')
      expect(src.toUpperCase(), `${name} must say what DOES move the password`).toMatch(
        /ONLY PATH THAT CHANGES AN EXISTING|THE ONE FLAG THAT CHANGES/,
      )
    }
  })

  /*
   * …AND IT MAY NOT SAY IT AS AN ABSOLUTE. "a boot NEVER touches its password"
   * is false the moment rotateAppDbPassword is on, and it is operator-facing
   * copy: somebody reads it, sets the rotation flag, and does not believe the
   * restart that follows will move anything. This assertion used to REQUIRE that
   * sentence — the same false-absolute class as finding #8, written into the
   * gate that was supposed to catch it.
   */
  it.each(Object.entries(files))('%s qualifies every "never touches the password" claim', (_name, src) => {
    const unqualified = src
      .split('\n')
      .filter((line) => /never touches (its|the) password/i.test(line))
      .filter((line) => !/unless|except/i.test(line))
    expect(unqualified, 'rotateAppDbPassword is the exception and the sentence has to carry it').toEqual([])
  })

  /*
   * A PARAMETER NOTHING READS IS NOT A FEATURE (CLAUDE.md rule 16). The flag has
   * to reach the container as an env var, or "rotation is still possible" is a
   * sentence in a comment.
   */
  it('rotateAppDbPassword is wired all the way to the container env var', () => {
    expect(files['infra/main.bicep']).toContain('param rotateAppDbPassword bool = false')
    expect(files['infra/main.bicep']).toMatch(/rotateAppDbPassword:\s*rotateAppDbPassword && provisionAppRole/)
    expect(files['infra/modules/container-app.bicep']).toContain('param rotateAppDbPassword bool = false')
    expect(files['infra/modules/container-app.bicep']).toContain("name: 'TOKENSCOPE_ROTATE_APP_DB_PASSWORD'")
  })

  /*
   * THE RECOVERY TEXT IS DUPLICATED IN dev.bicepparam, and the copy went stale
   * first. It used to say: if the boot loops on "COMMITTED AND COULD NOT VERIFY",
   * turn provisionAppRole off, because "the role already holds the
   * app-db-password secret". Both halves are now false — that exit code is gone,
   * and a boot no longer commits a password onto an existing role.
   */
  it('dev.bicepparam no longer prints the exit-2 recovery, which described a state that cannot occur', (ctx) => {
    // Dropped from the public snapshot; nothing to assert about a file that
    // does not ship there. Skipped rather than silently passing, so the reason
    // is visible in the run.
    const src = files['infra/parameters/dev.bicepparam']
    if (!src) return ctx.skip()
    expect(src).not.toContain('COMMITTED AND COULD NOT VERIFY')
    expect(src.toLowerCase()).not.toContain('set provisionappRole\n'.toLowerCase())
    expect(src).not.toMatch(/set provisionAppRole\s*\n?\s*\/\/\s*back to false/)
    expect(src, 'and it points at the lever the script actually prints').toContain('useAppRoleAtRuntime')
  })

  it('main.bicep and dev.bicepparam still say the sweep is one-time', () => {
    expect(files['infra/main.bicep']).toContain('ONE-TIME')
    // Only when it ships — see above.
    if (files['infra/parameters/dev.bicepparam']) {
      expect(files['infra/parameters/dev.bicepparam']).toContain('ONE-TIME')
    }
  })
})

/*
 * ── THE STARTUP BUDGET, AND THE GUARANTEE IT DOES NOT PROVIDE ──────────────
 *
 * The step runs inside `entrypoint.sh`, before the Nitro server binds, so the
 * container's Startup probe is what kills it. Nothing else in the repo relates
 * a timeout in TypeScript to a probe in Bicep: change `failureThreshold` and the
 * budget silently becomes wrong, and the symptom is a SIGKILL (128+N), which is
 * an exit code the entrypoint contract explicitly does not define.
 *
 * THE PREVIOUS VERSION OF THIS BLOCK ASSERTED A GUARANTEE NOBODY HELD. It
 * reserved an arbitrary 40 seconds for "migrations, two seeds and the server
 * bind" and called the arithmetic a 125s container-start guarantee — while
 * `drizzle/migrate.ts` runs first with NO bound on the migrations at all
 * (verified below). Reserving a number for an unbounded step does not bound it;
 * it only makes the reservation look like arithmetic.
 *
 * So this block asserts two things that are actually true: the BOUNDED steps
 * cannot themselves consume the window, and the script does not claim more than
 * that.
 */
describe('the provisioning budget fits inside the container start probe', () => {
  const bicep = readFileSync(resolve(ROOT, 'infra/modules/container-app.bicep'), 'utf8')

  /** Read the Startup probe's three numbers straight out of the template. */
  function startupWindowSeconds(): number {
    const block = bicep.slice(bicep.indexOf("type: 'Startup'"), bicep.indexOf("type: 'Liveness'"))
    const num = (key: string): number => {
      const m = block.match(new RegExp(`${key}:\\s*(\\d+)`))
      expect(m, `the Startup probe has no ${key}`).toBeTruthy()
      return Number(m![1])
    }
    return num('initialDelaySeconds') + num('failureThreshold') * num('periodSeconds')
  }

  function constMs(name: string, src = script): number {
    // `Number(process.env.X) || 45_000` is still a literal default to read.
    const m = src.match(new RegExp(`const ${name} = (?:Number\\([^)]*\\) \\|\\| )?([\\d_]+)`))
    expect(m, `${name} is gone from the script`).toBeTruthy()
    return Number(m![1].replace(/_/g, ''))
  }
  function constSeconds(name: string, src = script): number {
    return constMs(name, src)
  }
  /**
   * A Postgres duration literal — `const X = '10s'`. Read rather than retyped
   * for the same reason as the numbers: a hand-copied 10 here is exactly the
   * drift this whole test exists to catch.
   */
  function constPgSeconds(name: string, src = script): number {
    const m = src.match(new RegExp(`const ${name} = '(\\d+)s'`))
    expect(m, `${name} is gone, or is no longer a plain '<n>s' literal`).toBeTruthy()
    return Number(m![1])
  }

  it('the BOUNDED boot steps cannot themselves consume the start window', () => {
    const window = startupWindowSeconds()

    // The worst case this step can consume: its own deadline, plus the exit-3
    // classifier's probe, which runs AFTER the deadline has been cleared. BOTH
    // of the classifier's terms count — connecting and querying are separately
    // unbounded, and an earlier version of this sum counted only the connect
    // while the header claimed the total.
    const budget = constMs('PROVISION_BUDGET_MS') / 1000
    const classifier = constSeconds('CONNECT_TIMEOUT_S') + constPgSeconds('PROBE_STATEMENT_TIMEOUT')

    // Read pre-flight's bound from pre-flight, not from a number retyped here —
    // a hand-copied 30 is its own drift bug.
    const preflightSrc = readFileSync(resolve(ROOT, 'scripts/preflight.ts'), 'utf8')
    const preflight =
      Number(preflightSrc.match(/const CRITICAL_TIMEOUT_MS = [^|]*\|\|\s*(\d+)/)![1]) / 1000

    // …and the sweep, which is the other bounded step and runs right after this one.
    const sweepSrc = readFileSync(resolve(ROOT, 'drizzle/cutover-rls-sweep.ts'), 'utf8')
    const sweep = constMs('SWEEP_BUDGET_MS', sweepSrc) / 1000

    // …and the binding gate, which is the LAST bounded step and the newest. It
    // was added without this sum being updated, which left ~5s of a 125s window
    // for process launch and Nitro binding — every bound behaving as designed
    // and a healthy estate still SIGKILLed.
    const gateSrc = readFileSync(resolve(ROOT, 'drizzle/assert-runtime-rls-safe.ts'), 'utf8')
    const gate = constMs('GATE_BUDGET_MS', gateSrc) / 1000

    /*
     * THE PRE-FLIGHT STEP IS NOT JUST `preflight.ts`. `scripts/preflight-run.ts`
     * also calls `reportRlsPostureAtBoot`, which opens its own client and runs
     * FIVE serial catalog queries.
     *
     * Counted from ITS OWN wall-clock budget and not from connect+statement,
     * because this term has been wrong twice: first omitted entirely, then
     * counted as one connect plus one statement when five statements each carry
     * their own timeout. The probe now has a single deadline precisely so this
     * number cannot drift with the query count.
     */
    const probeSrc = readFileSync(resolve(ROOT, 'scripts/preflight-rls.ts'), 'utf8')
    const postureProbe = constMs('POSTURE_PROBE_BUDGET_MS', probeSrc) / 1000

    /*
     * TEARDOWN COUNTS. The classifier's probe and the gate's clients close with
     * an explicit `end({ timeout: 5 })`, which runs AFTER their own deadline is
     * cleared and is therefore outside every budget above. The gate's TWO
     * clients close in a `Promise.all`, so they are ONE 5s term and not two —
     * an earlier version of this sum counted them serially, which inflated the
     * total in the opposite direction to the terms it was omitting. Being wrong
     * generously is still being wrong.
     */
    const teardown = 5 + 5 + 5

    const bounded = preflight + postureProbe + budget + classifier + sweep + gate + teardown
    expect(
      bounded,
      `pre-flight (${preflight}s + ${postureProbe}s posture probe) + provisioning (${budget}s + ${classifier}s classifier) + the sweep (${sweep}s) + the binding gate (${gate}s) + ${teardown}s of client teardown must fit inside the ${window}s window on their own`,
    ).toBeLessThan(window)

    /*
     * And with room to spare, because "fits" is not the property that matters:
     * Nitro still has to launch and bind AFTER every one of these. A sum that
     * merely fits is how an earlier version passed while leaving five seconds
     * for the thing the window exists to measure.
     */
    expect(
      window - bounded,
      `only ${window - bounded}s would remain for process launch and Nitro binding after the bounded steps`,
    ).toBeGreaterThanOrEqual(60)
  })

  /*
   * AND THE HONEST HALF. The steps in front of this one are not all bounded, and
   * a comment saying otherwise is the defect class this branch keeps producing.
   */
  it('migrate.ts really is unbounded, and the script says so instead of claiming a guarantee', () => {
    const migrate = readFileSync(resolve(ROOT, 'drizzle/migrate.ts'), 'utf8')
    // A sleep between lock-timeout retries is not a deadline; a race against a
    // timer or a statement_timeout would be.
    expect(migrate, 'if migrations ever get a bound, the header here has to be rewritten').not.toMatch(
      /statement_timeout|Promise\.race|BUDGET/,
    )
    expect(
      script,
      'the header must name the unbounded step rather than reserving a number for it',
    ).toMatch(/UNBOUNDED\*\*, deliberately/)
    /*
     * DERIVED FROM BICEP, not typed here. This assertion used to pin the string
     * "125s", so when the probe was widened the header kept quoting a window
     * the infrastructure no longer had — and the test that exists to catch
     * exactly that drift was pinning the stale value itself.
     */
    expect(script, 'and it must not claim the deadline bounds container start').toContain(
      `THIS DEADLINE DOES NOT ESTABLISH A ${startupWindowSeconds()}s CONTAINER-START GUARANTEE`,
    )
    /*
     * EVERY BOOT-SCRIPT HEADER, not just this one. The first version of this
     * guard checked `provision-app-role.ts` alone — and the very round it
     * shipped, the SWEEP's header was still quoting a 125s window and a
     * four-term sum. A drift guard scoped to one of the files that can drift
     * is the same defect it is meant to catch.
     */
    const headers = {
      'drizzle/provision-app-role.ts': script,
      'drizzle/cutover-rls-sweep.ts': readFileSync(resolve(ROOT, 'drizzle/cutover-rls-sweep.ts'), 'utf8'),
      'drizzle/assert-runtime-rls-safe.ts': readFileSync(
        resolve(ROOT, 'drizzle/assert-runtime-rls-safe.ts'),
        'utf8',
      ),
      'entrypoint.sh': readFileSync(resolve(ROOT, 'entrypoint.sh'), 'utf8'),
    }
    const staleWindow = new RegExp(`\\b(?!${startupWindowSeconds()})\\d{3}s (?:window|start window)`)
    for (const [name, src] of Object.entries(headers)) {
      expect(
        src.split('\n').filter((l) => staleWindow.test(l)),
        `${name} quotes a startup window other than the ${startupWindowSeconds()}s Bicep configures`,
      ).toEqual([])
      /*
       * And no hand-written total at all. Every one of these that has existed
       * has been wrong within two rounds — omitted the gate, omitted teardown,
       * mis-parallelised the closes, under-counted a five-query probe.
       */
      expect(
        src.split('\n').filter((l) => /^\s*\*?\s*(?:·\s*)?[a-z-][\w-]*\s+\d+(\s*\+\s*[^=]+)?=\s*\d+\s*<\s*\d+/i.test(l)),
        `${name} writes out the startup arithmetic by hand; derive it in this test instead`,
      ).toEqual([])
    }
  })

  it('bounds every wait inside the deadline, so the common failures classify before it', () => {
    const budget = constMs('PROVISION_BUDGET_MS') / 1000
    const connect = constSeconds('CONNECT_TIMEOUT_S')
    const lockWait = Number(script.match(/const LOCK_WAIT = '(\d+)s'/)![1])

    // Database unreachable → one connect timeout. A peer holds the lock → a
    // connect plus the lock wait. Both must land well inside the deadline, or
    // the operator gets a budget message for an ordinary, well-understood fault.
    expect(connect, 'unreachable database').toBeLessThan(budget)
    expect(connect + lockWait, 'a peer mid-provision').toBeLessThan(budget)
  })

  it('sets a statement_timeout on the pool, so the pre-mutation reads are bounded too', () => {
    // Without it the two catalog reads before the transaction are the only
    // unbounded waits left, and they are the ones a lock storm would stall.
    expect(script).toContain('connection: { statement_timeout: POOL_STATEMENT_TIMEOUT }')
  })

  /*
   * …AND THE TWO BOUNDS RACE. The pool's `statement_timeout` also applies to the
   * connection waiting on the advisory lock, and the SHORTER one wins (measured
   * on PG 16.13: statement 4s beats lock 15s, cancelling at 4.0s with 57014).
   * With a 10s pool bound and a 15s lock wait the run gives up after 10s and
   * then reports "did not release it within 15s" — a false sentence, of the
   * exact class this branch keeps producing, and invisible to every other gate.
   */
  it('lifts the lock connection above the pool bound, so lock_timeout is what fires', () => {
    const lockWait = Number(script.match(/const LOCK_WAIT = '(\d+)s'/)![1])
    const lockStmt = Number(script.match(/const LOCK_WAIT_STATEMENT_TIMEOUT = '(\d+)s'/)![1])
    const poolStmt = Number(script.match(/const POOL_STATEMENT_TIMEOUT = '(\d+)s'/)![1])
    expect(poolStmt, 'the pool bound is the one that would pre-empt the wait').toBeLessThan(lockWait)
    expect(lockStmt, 'so the lock connection has to be raised above the wait it is doing').toBeGreaterThan(lockWait)
    expect(script, 'and it has to actually be applied to that connection').toContain(
      "SET statement_timeout = '${LOCK_WAIT_STATEMENT_TIMEOUT}'",
    )
  })
})
