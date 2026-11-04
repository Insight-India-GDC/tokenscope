/**
 * The Copilot lane resolves ONE credential store (audit round 2, follow-up to the
 * "durable Copilot credential store is anchored on the passwd home" fix).
 *
 * `~/.tokenscope/config.json` holds `oauth_refresh_token`. Anchoring it on the PASSWD
 * home closed a trust hole — `os.homedir()` consults `$HOME`, so a leaked or model-set
 * `HOME` chose where a live credential was written — but it was applied to the WRITER
 * (copilot-redeem.mjs) and one reader (device-id.mjs) only. The forwarder, the
 * emit-on-install enrol door, the lifecycle hook's log, status and landed-check were
 * left on `os.homedir()`, so on any host where `$HOME` differs from the passwd home
 * redeem wrote one path and the forwarder opened another — Copilot emission stopping
 * SILENTLY, which is the exact incident recorded in real-home.mjs's header.
 *
 * These tests pin the whole lane on one resolution: a `TOKENSCOPE_STATE_DIR` pin
 * first, else `~/.tokenscope` under the passwd home.
 *
 * WHY THE ASSERTIONS ARE ON THE RESOLVED PATH rather than on a real write: the
 * no-override path resolves the developer's OWN ~/.tokenscope, and a unit test must
 * never read or write a live deployment. Every resolver here is a pure path
 * computation, so pinning the value pins the behaviour.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Windows (#430): skipped on win32 because this file temp-dir cleanup fails with EPERM on Windows.
const POSIX_ONLY = process.platform === 'win32'

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { realHome } = await import('../../../plugin/scripts/real-home.mjs')

const ENV_KEYS = ['HOME', 'USERPROFILE', 'TOKENSCOPE_STATE_DIR'] as const

/**
 * Resolve the store from EVERY site in the lane, under a given environment. The
 * forwarder and copilot-redeem resolve theirs at MODULE LOAD, so the env has to be
 * in place before the import and the module registry reset between cases.
 */
async function resolveAll(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  try {
    for (const k of ENV_KEYS) {
      const v = env[k]
      // Never assign undefined — process.env stringifies it to the literal "undefined".
      if (v === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = v
    }
    vi.resetModules()
    /* eslint-disable @typescript-eslint/ban-ts-comment */
    // @ts-ignore — mjs import resolved by Vitest
    const forwarder = await import('../../../plugin/scripts/copilot-forwarder.mjs')
    // @ts-ignore — mjs import resolved by Vitest
    const redeem = await import('../../../plugin/scripts/copilot-redeem.mjs')
    // @ts-ignore — mjs import resolved by Vitest
    const enroll = await import('../../../copilot-plugin/scripts/enroll.mjs')
    // @ts-ignore — mjs import resolved by Vitest
    const landed = await import('../../../copilot-plugin/scripts/landed-check.mjs')
    /* eslint-enable @typescript-eslint/ban-ts-comment */
    return {
      // The forwarder — READS the credential and hands the resolved dir to
      // otel-headers-helper.sh as TOKENSCOPE_STATE_DIR.
      forwarder: forwarder.TOKENSCOPE_DIR as string,
      forwarderConfig: forwarder.CONFIG_PATH as string,
      // copilot-redeem — the WRITER the split was measured against.
      redeem: redeem.TOKENSCOPE_DIR as string,
      // enroll — the SECOND writer of the same config.json (emit-on-install).
      enroll: enroll.stateDir() as string,
      // landed-check — the state reader; status.mjs imports this same resolver.
      landed: landed.stateDir() as string,
    }
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) Reflect.deleteProperty(process.env, k)
      else process.env[k] = saved[k] as string
    }
    vi.resetModules()
  }
}

const tmpDirs: string[] = []
function tmp(prefix: string) {
  const d = mkdtempSync(join(tmpdir(), prefix))
  tmpDirs.push(d)
  return d
}
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop() as string, { recursive: true, force: true })
})

describe.skipIf(POSIX_ONLY)('the Copilot credential store resolves identically at every site', () => {
  it('with no pin: the forwarder opens exactly the file copilot-redeem writes', async () => {
    // The regression this whole change exists to prevent. Before the fix the
    // forwarder was on os.homedir() and redeem on realHome(), so these two differed
    // on every host with a moved $HOME.
    const moved = tmp('ts-moved-home-')
    const r = await resolveAll({ HOME: moved, USERPROFILE: moved })

    expect(r.forwarder).toBe(r.redeem)
    expect(r.forwarderConfig).toBe(join(r.redeem, 'config.copilot-cli.json'))
  })

  it('with no pin: enroll and landed-check agree with the forwarder too', async () => {
    const moved = tmp('ts-moved-home-')
    const r = await resolveAll({ HOME: moved, USERPROFILE: moved })

    expect(new Set([r.forwarder, r.redeem, r.enroll, r.landed]).size).toBe(1)
  })

  it('a moved $HOME moves NONE of them — the anchor is the passwd home', async () => {
    const moved = tmp('ts-moved-home-')
    const r = await resolveAll({ HOME: moved, USERPROFILE: moved })

    const expected = join(realHome(), '.tokenscope')
    for (const [site, dir] of Object.entries(r)) {
      if (site === 'forwarderConfig') continue
      expect(dir, `${site} followed a moved $HOME`).toBe(expected)
      expect(dir.startsWith(moved), `${site} landed under the moved $HOME`).toBe(false)
    }
  })

  it('an explicit TOKENSCOPE_STATE_DIR pin steers the whole emit path', async () => {
    // The pin is a PROCESS-level deployment choice / test sandbox — a different
    // variable from HOME with a different threat model, and one the rest of the lane
    // (otel-headers-helper.sh, status.mjs, landed-check.mjs) already honoured. A
    // forwarder that ignored it sent the helper to a dir it did not itself read.
    //
    // copilot-redeem.mjs is deliberately absent from this assertion: it has no
    // TOKENSCOPE_STATE_DIR override and always writes the passwd-home store. That is
    // its own (unowned) file; the forwarder names BOTH paths on stderr when a pin
    // leaves it looking at an empty dir while the default store holds a credential.
    const pin = tmp('ts-pinned-state-')
    const moved = tmp('ts-moved-home-')
    const r = await resolveAll({ HOME: moved, USERPROFILE: moved, TOKENSCOPE_STATE_DIR: pin })

    expect(r.forwarder).toBe(pin)
    expect(r.forwarderConfig).toBe(join(pin, 'config.copilot-cli.json'))
    expect(r.enroll).toBe(pin)
    expect(r.landed).toBe(pin)
  })

  it('a blank/whitespace pin is not a pin — it falls through to the passwd home', async () => {
    // `TOKENSCOPE_STATE_DIR=` in an env block is "unset", not "resolve to /.tokenscope".
    const r = await resolveAll({ TOKENSCOPE_STATE_DIR: '   ' })
    const expected = join(realHome(), '.tokenscope')

    expect(r.forwarder).toBe(expected)
    expect(r.enroll).toBe(expected)
    expect(r.landed).toBe(expected)
  })
})

describe.skipIf(POSIX_ONLY)('forwarder-lifecycle hook — the daemon log lands in the SAME state dir', () => {
  it("opens forwarder.log under the resolved state dir, not a $HOME-derived one", () => {
    // The hook opens ~/.tokenscope/forwarder.log before spawning the daemon. It used
    // to derive that dir from os.homedir() — a sixth, independent resolution — so a
    // leaked $HOME sent the ONE artefact that explains a silent forwarder into a
    // phantom directory. It now calls enroll.mjs's stateDir(), like everything else.
    const pin = tmp('ts-pinned-state-')
    const movedHome = tmp('ts-moved-home-')
    const projectDir = tmp('ts-lifecycle-proj-')
    const hookPath = join(process.cwd(), 'copilot-plugin/hooks/forwarder-lifecycle.mjs')

    const r = spawnSync(process.execPath, [hookPath, 'start'], {
      encoding: 'utf8',
      timeout: 10_000,
      env: {
        ...process.env,
        TOKENSCOPE_STATE_DIR: pin,
        // Moved too, so a regression to the os.homedir() form writes into this temp
        // dir rather than the developer's own home when this assertion goes red.
        HOME: movedHome,
        USERPROFILE: movedHome,
        // The pinned dir holds no config.json, so enrollIfNeeded() stops at its
        // "already enrolled?" / "no bundled secret?" gates — no network, no writes.
        // Pinned to '' explicitly so a dev shell that exports one cannot make this
        // test POST anywhere.
        TOKENSCOPE_ENROLLMENT_SECRET: '',
        COPILOT_PROJECT_DIR: projectDir,
      },
    })

    expect(r.status).toBe(0)
    expect(existsSync(join(pin, 'forwarder.log'))).toBe(true)
    expect(existsSync(join(movedHome, '.tokenscope', 'forwarder.log'))).toBe(false)
  })
})

describe.skipIf(POSIX_ONLY)('enroll.stateDir — the injected home still wins, only the default moved', () => {
  it('honours an explicitly passed home (the test-injection seam)', async () => {
    /* eslint-disable @typescript-eslint/ban-ts-comment */
    // @ts-ignore — mjs import resolved by Vitest
    const enroll = await import('../../../copilot-plugin/scripts/enroll.mjs')
    /* eslint-enable @typescript-eslint/ban-ts-comment */
    expect(enroll.stateDir({}, '/injected/home')).toBe(join('/injected/home', '.tokenscope'))
  })

  it('the env argument still outranks the injected home', async () => {
    /* eslint-disable @typescript-eslint/ban-ts-comment */
    // @ts-ignore — mjs import resolved by Vitest
    const enroll = await import('../../../copilot-plugin/scripts/enroll.mjs')
    /* eslint-enable @typescript-eslint/ban-ts-comment */
    expect(enroll.stateDir({ TOKENSCOPE_STATE_DIR: '/pinned' }, '/injected/home')).toBe('/pinned')
  })
})
