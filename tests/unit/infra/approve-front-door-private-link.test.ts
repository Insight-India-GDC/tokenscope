// @vitest-environment node
/*
 * infra/scripts/approve-front-door-private-link.sh approves Front Door
 * Premium's Private Link request on the Container Apps environment. Anyone who
 * knows the environment's resource id can file a private endpoint request with
 * any description, from a resource group they name eafd-*, and the message is
 * derivable from public outputs. Front Door files ONE request per origin, so the
 * script approves a Pending request carrying this deployment's message from a
 * Front Door managed endpoint only when it is the only one, it was not already
 * Pending when the script started, and none is Approved with the message (old or
 * new); otherwise it approves nothing, lists them with the hand-approval command,
 * and stops. Its re-approval pass never resurrects a Rejected connection, and
 * still counts one approved under the old message.
 *
 * Runs the real script with `az`, `curl` and `sleep` stubbed on PATH. The stub
 * answers the connection listing from a fixture (the first listing, taken when
 * the script starts, from a separate one) and records every PUT.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const exec = promisify(execFile)
const ROOT = resolve(__dirname, '../../..')
const SCRIPT = join(ROOT, 'infra/scripts/approve-front-door-private-link.sh')

const MESSAGE = 'TokenScope Front Door fd-ts-sandbox-aue k3j2h4g5f6d7s'
const GUESSABLE = 'TokenScope Front Door fd-ts-sandbox-aue'
const ENV_ID = '/subscriptions/9a1e0000-0000-4000-8000-000000000001/resourceGroups/rg-ts/providers/Microsoft.App/managedEnvironments/cae-ts'
const PROFILE_ID = '/subscriptions/9a1e0000-0000-4000-8000-000000000001/resourceGroups/rg-ts/providers/Microsoft.Cdn/profiles/fd-ts-sandbox-aue'
const AFD_PE = '/subscriptions/9a1e0000-0000-4000-8000-0000000000ff/resourceGroups/eafd-Prod-australiaeast/providers/Microsoft.Network/privateEndpoints/9a1e0000-0000-4000-8000-0000000000e1'
const LOOKALIKE_PE = '/subscriptions/9a1e0000-0000-4000-8000-0000000000aa/resourceGroups/eafd-Prod-australiaeast/providers/Microsoft.Network/privateEndpoints/pe-y'
const FOREIGN_PE ='/subscriptions/9a1e0000-0000-4000-8000-0000000000aa/resourceGroups/rg-other/providers/Microsoft.Network/privateEndpoints/pe-x'

// name, status, private endpoint id, description — the shape the script queries.
const tsv = (rows: string[][]) => (rows.length ? `${rows.map((r) => r.join('\t')).join('\n')}\n` : '')
const FIXTURES: Record<string, string[][]> = {
  // A first apply: Front Door's request, plus ones the script must ignore.
  'first.tsv': [
    ['pec-afd-pending', 'Pending', AFD_PE, MESSAGE],
    ['pec-foreign-pending', 'Pending', FOREIGN_PE, MESSAGE],
    ['pec-guessable-pending', 'Pending', AFD_PE, GUESSABLE],
    ['pec-rejected', 'Rejected', AFD_PE, MESSAGE],
  ],
  // A re-apply: Front Door's connection is already approved.
  'reapply.tsv': [
    ['pec-afd-approved', 'Approved', AFD_PE, MESSAGE],
    ['pec-rejected', 'Rejected', AFD_PE, MESSAGE],
  ],
  // An outsider's look-alike request beside Front Door's.
  'two-pending.tsv': [
    ['pec-afd-pending', 'Pending', AFD_PE, MESSAGE],
    ['pec-lookalike-pending', 'Pending', LOOKALIKE_PE, MESSAGE],
  ],
  // A look-alike filed before the apply started, alone when the script polls.
  'prefiled.tsv': [['pec-lookalike-pending', 'Pending', LOOKALIKE_PE, MESSAGE]],
  // An upgraded deployment (old message on Front Door's connection) and a
  // look-alike on the new message.
  'legacy-lookalike.tsv': [
    ['pec-old-approved', 'Approved', AFD_PE, GUESSABLE],
    ['pec-lookalike-pending', 'Pending', LOOKALIKE_PE, MESSAGE],
  ],
  // A look-alike filed after Front Door's was approved.
  'late-lookalike.tsv': [
    ['pec-afd-approved', 'Approved', AFD_PE, MESSAGE],
    ['pec-lookalike-pending', 'Pending', LOOKALIKE_PE, MESSAGE],
  ],
  // A deployment approved before the message changed: its only connection
  // carries the old message.
  'upgrade.tsv': [['pec-old-approved', 'Approved', AFD_PE, GUESSABLE]],
  'empty.tsv': [],
}

const AZ_STUB = `#!/usr/bin/env bash
args="$*"
# STUB_FAIL=env|list: that startup read fails its first three times.
fail() {
  case "$args" in *"$1"*) ;; *) return 1 ;; esac
  [ "$(wc -l < "$STUB_PUTS.fails" 2>/dev/null || echo 0)" -lt 3 ] || return 1
  echo x >> "$STUB_PUTS.fails"
}
case "$STUB_FAIL" in
  env) fail managedEnvironments && { echo "az: transient error" >&2; exit 1; } ;;
  list) [ ! -e "$STUB_PUTS.started" ] && fail privateEndpointConnections?api && { echo "az: transient error" >&2; exit 1; } ;;
esac
case "$args" in
  *"deployment group show"*provisioningState*) echo "\${STUB_STATE:-Succeeded}" ;;
  *"deployment group show"*properties.error*) echo '{ "code": "DeploymentFailed" }' ;;
  # STUB_STATE=Failed: main failed in its front-door module, at one route.
  *"deployment operation group list"*"-n main "*) echo "WARNING: this command is in preview" >&2; printf 'Microsoft.Resources/deployments\tfront-door\tnull\n' ;;
  # STUB_FD_ROWS overrides the front-door module's failed operations.
  *"deployment operation group list"*"-n front-door "*)
    if [ -n "\${STUB_FD_FILE:-}" ]; then cat "$STUB_FD_FILE"
    elif [ -n "\${STUB_FD_ROWS:-}" ]; then printf '%b' "$STUB_FD_ROWS"
    else printf 'Microsoft.Cdn/profiles/afdEndpoints/routes\tfd-ts/ep-ts/route-ts\t{"error":{"code":"BadRequest","message":"The origin group is not ready."}}\n'; fi ;;
  *"deployment group show"*parameters.enableFrontDoor*) echo true ;;
  *"deployment group show"*parameters.frontDoorSku*) echo Premium ;;
  *"deployment group show"*parameters.enablePrivateNetworking*) echo true ;;
  *"deployment group show"*frontDoorEndpointFqdn*) echo ep-ts.azurefd.net ;;
  *"resource list"*Microsoft.Cdn/profiles*) echo "${PROFILE_ID}" ;;
  *"resource list"*managedEnvironments*) echo "${ENV_ID}" ;;
  *"--method get"*origins/origin-tokenscope*) echo "${MESSAGE}" ;;
  *"--method get"*privateEndpointConnections*)
    if [ ! -e "$STUB_PUTS.started" ]; then : > "$STUB_PUTS.started"; cat "$STUB_INITIAL"
    else cat "$STUB_CONNECTIONS"; fi ;;
  *"--method put"*privateEndpointConnections/*)
    url="\${args#*privateEndpointConnections/}"
    echo "\${url%%\\?*}" >> "$STUB_PUTS" ;;
  *) echo "unexpected az call: $args" >&2; exit 1 ;;
esac
`

let dir = ''

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ts-afd-approve-'))
  await writeFile(join(dir, 'az'), AZ_STUB)
  // STUB_HTTP: what the Front Door endpoint answers (200 unless set).
  await writeFile(join(dir, 'curl'), '#!/usr/bin/env bash\nprintf "${STUB_HTTP:-200}"\n')
  await writeFile(join(dir, 'sleep'), '#!/usr/bin/env bash\nexit 0\n')
  for (const f of ['az', 'curl', 'sleep']) await chmod(join(dir, f), 0o755)
  for (const [name, rows] of Object.entries(FIXTURES)) await writeFile(join(dir, name), tsv(rows))
})

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true })
})

async function run(
  connections: string,
  initial = 'empty.tsv',
  fail = '',
  extra: Record<string, string> = {},
): Promise<{ code: number; out: string; puts: string[] }> {
  const puts = join(dir, `puts-${Date.now()}.log`)
  await writeFile(puts, '')
  let code = 0
  let out: string
  try {
    const r = await exec('bash', [SCRIPT, 'rg-ts'], {
      env: {
        PATH: `${dir}:${process.env.PATH ?? ''}`,
        HOME: process.env.HOME ?? '',
        STUB_CONNECTIONS: join(dir, connections),
        STUB_INITIAL: join(dir, initial),
        STUB_PUTS: puts,
        STUB_FAIL: fail,
        ...extra,
      },
      timeout: 30_000,
    })
    out = `${r.stdout}${r.stderr}`
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    code = typeof e.code === 'number' ? e.code : 1
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
  const log = (await readFile(puts, 'utf8')).split('\n').filter(Boolean)
  return { code, out, puts: log }
}

describe('approve-front-door-private-link.sh', () => {
  it('approves the Pending request carrying the deployment message', async () => {
    const r = await run('first.tsv')
    expect(r.code, r.out).toBe(0)
    expect(r.puts).toEqual(['pec-afd-pending'])
  })

  it('does not approve a Pending request from a foreign private endpoint, even with the right message', async () => {
    const r = await run('first.tsv')
    expect(r.puts).not.toContain('pec-foreign-pending')
    expect(r.out).toContain('Not approving pec-foreign-pending')
  })

  it('approves nothing and stops when two requests from eafd-* groups carry the message', async () => {
    const r = await run('two-pending.tsv')
    expect(r.code).toBe(1)
    expect(r.puts).toEqual([])
    expect(r.out).toContain('pec-afd-pending')
    expect(r.out).toContain('pec-lookalike-pending')
  })

  it('approves nothing and stops when a request arrives after one is already approved, listing both', async () => {
    const r = await run('late-lookalike.tsv')
    expect(r.code).toBe(1)
    expect(r.puts).toEqual([])
    expect(r.out).toContain('pec-lookalike-pending')
    expect(r.out).toMatch(/Already approved:\n {2}pec-afd-approved/)
  })

  it('never approves a request that was already Pending when the script started, even alone', async () => {
    const r = await run('prefiled.tsv', 'prefiled.tsv')
    expect(r.code).toBe(1)
    expect(r.puts).toEqual([])
    expect(r.out).toContain('pec-lookalike-pending')
  })

  it.each(['env', 'list'])('approves nothing when the startup read of the %s keeps failing', async (fail) => {
    const r = await run('prefiled.tsv', 'prefiled.tsv', fail)
    expect(r.code).toBe(1)
    expect(r.puts).toEqual([])
    expect(r.out).toContain('Could not read the environment')
  })

  it('counts a connection approved under the old message as already approved', async () => {
    const r = await run('legacy-lookalike.tsv')
    expect(r.code).toBe(1)
    expect(r.puts).toEqual([])
    expect(r.out).toMatch(/Already approved:\n {2}pec-old-approved/)
  })

  it('prints a hand-approval command that keeps the message the script recognises', async () => {
    const r = await run('two-pending.tsv')
    expect(r.out).toContain(`privateEndpointConnections/pec-afd-pending?api-version=`)
    expect(r.out).toContain(`"description":"${MESSAGE}"`)
  })

  it('an upgraded deployment whose connection was approved under the old message still succeeds', async () => {
    const r = await run('upgrade.tsv')
    expect(r.code, r.out).toBe(0)
    expect(r.puts).toContain('pec-old-approved')
  })

  it('does not approve a request carrying only the old, guessable message', async () => {
    const r = await run('first.tsv')
    expect(r.puts).not.toContain('pec-guessable-pending')
  })

  it('re-approves a connection that is already Approved, and never one an operator Rejected', async () => {
    const r = await run('reapply.tsv')
    expect(r.code, r.out).toBe(0)
    expect(r.puts).toContain('pec-afd-approved')
    expect(r.puts).not.toContain('pec-rejected')
  })

  it('prints the failed resource and Azure\'s message when the deployment fails', async () => {
    const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_STATE: 'Failed' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Deployment main Failed:')
    expect(r.out).toContain("Failed operations (resource type, name, Azure's message):")
    expect(r.out).toContain('Microsoft.Cdn/profiles/afdEndpoints/routes\tfd-ts/ep-ts/route-ts')
    expect(r.out).toContain('The origin group is not ready.')
    // az's warning on a successful read is not listed as a failed operation.
    expect(r.out).not.toContain('WARNING: this command is in preview')
    // BadRequest names the request: not a platform error, so no retry.
    expect(r.out).not.toContain('the same apply can be run again')
  })

  const ORIGIN = 'Microsoft.Cdn/profiles/originGroups/origins\\tfd-ts/og-ts/origin-ts\\t'
  const row = (code: string) => `${ORIGIN}{"status":"Failed","error":{"code":"${code}","message":"x"}}\\n`

  it('exits 4 when every failed operation carries only Azure platform errors', async () => {
    const r = await run('reapply.tsv', 'empty.tsv', '', {
      STUB_STATE: 'Failed',
      STUB_FD_ROWS: row('InternalError') + row('AnotherOperationInProgress'),
    })
    expect(r.code).toBe(4)
    expect(r.out).toContain('Only Azure platform errors (AnotherOperationInProgress, InternalError): the same apply can be run again.')
  })

  it('does not retry when any failed operation names the template or its input', async () => {
    const r = await run('reapply.tsv', 'empty.tsv', '', {
      STUB_STATE: 'Failed',
      STUB_FD_ROWS: row('InternalError') + row('InvalidParameter'),
    })
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('the same apply can be run again')
  })

  it('does not retry a platform error wrapping one that names the input', async () => {
    const nested = `${ORIGIN}{"error":{"code":"InternalError","details":[{"code":"LinkedInvalidPropertyId","message":"x"}]}}\\n`
    const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_STATE: 'Failed', STUB_FD_ROWS: nested })
    expect(r.code).toBe(1)
  })

  it('exits 4 when the deployment succeeded but Front Door still answers 404 after 30 minutes', async () => {
    const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_HTTP: '404' })
    expect(r.code).toBe(4)
    expect(r.out).toContain('Front Door endpoint: HTTP 404; waiting for it to start routing...')
    expect(r.out).toContain('Front Door is not serving the app yet. Running the same apply again re-approves the connection')
  })

  it('does not retry a platform error carrying an input error in an escaped message', async () => {
    const f = join(dir, 'escaped.tsv')
    await writeFile(f, 'Microsoft.Cdn/profiles/originGroups/origins\tfd-ts/og-ts/origin-ts\t'
      + '{"error":{"code":"InternalServerError","message":"{\\"error\\":{\\"code\\":\\"InvalidRequestContent\\"}}"}}\n')
    const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_STATE: 'Failed', STUB_FD_FILE: f })
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('the same apply can be run again')
  })

  it('on exit 4, records the request Front Door filed, and the retry may approve exactly that one', async () => {
    const carryFile = join(dir, `carry-${Date.now()}.txt`)
    const first = await run('first.tsv', 'empty.tsv', '', {
      STUB_STATE: 'Failed', STUB_FD_ROWS: row('InternalError'), APPROVE_CARRY: carryFile,
    })
    expect(first.code).toBe(4)
    expect((await readFile(carryFile, 'utf8')).trim()).toBe('pec-afd-pending')
    // The retry: the same request is now Pending from the start.
    const retry = await run('first.tsv', 'first.tsv', '', { APPROVE_CARRY: carryFile })
    expect(retry.code, retry.out).toBe(0)
    expect(retry.out).toContain('Retry: pec-afd-pending was filed by Front Door during the previous attempt')
    expect(retry.puts).toEqual(['pec-afd-pending'])
  })

  it('does not retry when a nested code cannot be read (null, or escaped whitespace before it)', async () => {
    for (const msg of [
      '{"error":{"code":"InternalError","details":[{"code":null}]}}',
      '{"error":{"code":"InternalError","message":"{\\"error\\":{\\"code\\":\\n\\"InvalidParameter\\"}}"}}',
    ]) {
      const f = join(dir, `nested-${Date.now()}.tsv`)
      await writeFile(f, `Microsoft.Cdn/profiles/originGroups/origins\tfd-ts/og-ts/origin-ts\t${msg}\n`)
      const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_STATE: 'Failed', STUB_FD_FILE: f })
      expect(r.code, msg).toBe(1)
    }
  })

  it('keeps the carried request when the retry also exits 4', async () => {
    const carryFile = join(dir, `carry-keep-${Date.now()}.txt`)
    await writeFile(carryFile, 'pec-afd-pending\n')
    // The retry fails on Azure's side again; whatever it approved, the next
    // attempt still knows which request was Front Door's.
    const r = await run('first.tsv', 'first.tsv', '', {
      STUB_STATE: 'Failed', STUB_FD_ROWS: row('InternalError'), APPROVE_CARRY: carryFile,
    })
    expect(r.code).toBe(4)
    expect((await readFile(carryFile, 'utf8')).trim()).toBe('pec-afd-pending')
  })

  it('a carried name never makes a different pending-before request approvable', async () => {
    const carryFile = join(dir, `carry-other-${Date.now()}.txt`)
    await writeFile(carryFile, 'pec-something-else\n')
    const r = await run('first.tsv', 'first.tsv', '', { APPROVE_CARRY: carryFile })
    expect(r.puts).toEqual([])
  })

  it('does not retry a failure with no error code', async () => {
    const r = await run('reapply.tsv', 'empty.tsv', '', { STUB_STATE: 'Failed', STUB_FD_ROWS: `${ORIGIN}null\\n` })
    expect(r.code).toBe(1)
  })
})
