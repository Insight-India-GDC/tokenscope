// @vitest-environment node
/*
 * tools/publish/validation/empty-resource-group.sh empties a validation
 * resource group. After a VNet deployment failed partway it twice left the
 * VNet, the registry, three private endpoints and their NICs behind, and
 * discarded every delete error, so the log never said why (#507).
 *
 * Runs the real script with `az` and `sleep` stubbed on PATH. The stub keeps
 * the group's resources in a state file and refuses a delete the way Azure
 * does: a VNet while a NIC or private endpoint is left, a NIC while its
 * endpoint is left, the registry while its endpoint is left, and a private
 * endpoint while the VNet is in the Failed state (until it is re-PUT). With
 * STUB_OLD_API set it also refuses any delete not naming that API version, the
 * way westus3 refused the CLI's newest one (NoRegisteredProviderFound).
 * tools/publish is internal-only, so the public snapshot skips this suite.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { PUBLIC_SNAPSHOT } from '../helpers/public-snapshot'

const exec = promisify(execFile)
const SCRIPT = resolve(__dirname, '../../../tools/publish/validation/empty-resource-group.sh')
const RG = '/subscriptions/9a1e0000-0000-4000-8000-000000000001/resourceGroups/rg-v/providers'

const VNET = `${RG}/Microsoft.Network/virtualNetworks/vnet-v`
const ACR = `${RG}/Microsoft.ContainerRegistry/registries/crv`
const pe = (n: string) => `${RG}/Microsoft.Network/privateEndpoints/pe-${n}-v`
const nic = (n: string) => `${RG}/Microsoft.Network/networkInterfaces/pe-${n}-v.nic.9a1e0000-0000-4000-8000-00000000000${n.length}`
const POSTGRES = `${RG}/Microsoft.DBforPostgreSQL/flexibleServers/pg-v`

const AZ_STUB = `#!/usr/bin/env bash
S="$STUB_STATE"
exec 9>"$S.lock"; flock 9
case "$1 $2" in
  "group show") echo tokenscope-scheduled-validation; exit 0 ;;
  "deployment group") exit 0 ;;
esac
id=""; prev=""
for a in "$@"; do [ "$prev" = --ids ] && id="$a"; prev="$a"; done
has() { grep -q -- "$1" "$S"; }
# A region that does not serve the CLI's newest API version for the type
# (westus3, 30 Oct): a delete or re-PUT is refused unless it names exactly
# STUB_OLD_API, in Azure's two-copy error form (ERROR line, then Code/Message).
# STUB_NO_LIST: the same error without the list of versions.
case "$1 $2" in
  "resource update"|"resource delete")
    if [ -n "\${STUB_OLD_API:-}" ] && ! printf '%s' "$*" | grep -qE -- "--api-version $STUB_OLD_API( |$)"; then
      msg="No registered resource provider found for location 'westus3' and API version '2026-07-01' for type 'privateEndpoints'."
      [ -n "\${STUB_NO_LIST:-}" ] || msg="$msg The supported api-versions are '2025-01-01, 2026-06-01-preview, $STUB_OLD_API, 2024-05-01'. The supported locations are 'westus3'."
      echo "ERROR: (NoRegisteredProviderFound) $msg" >&2; echo "Code: NoRegisteredProviderFound" >&2; echo "Message: $msg" >&2
      exit 1
    fi ;;
esac
# STUB_LIST_FAILS_FROM=<n>: the n-th and later lists fail, as when the Azure
# sign-in expired mid-teardown (31 Oct).
[ "$1 $2" = "resource list" ] && echo x >> "$S.lists"
if [ "$1 $2" = "resource list" ] && [ -n "\${STUB_LIST_FAILS_FROM:-}" ]; then
  if [ "$(wc -l < "$S.lists")" -ge "$STUB_LIST_FAILS_FROM" ]; then
    echo "ERROR: AADSTS700024: Client assertion is not within its valid time range." >&2; exit 1
  fi
fi
case "$1 $2" in
  "resource list")
    [ -z "\${STUB_LIST_WARN:-}" ] || echo "WARNING: a deprecation notice from az" >&2
    if printf '%s' "$*" | grep -q provisioningState; then cat "$S"; else cut -f1 "$S"; fi
    exit 0 ;;
  "resource update")
    awk -F'\\t' -v id="$id" 'BEGIN{OFS="\\t"} $1==id{$2="Succeeded"} {print}' "$S" > "$S.n" && mv "$S.n" "$S"
    exit 0 ;;
  "resource delete")
    if [ -n "\${STUB_STUCK:-}" ] && [ "$id" = "$STUB_STUCK" ] &&
       { [ -z "\${STUB_STUCK_UNTIL:-}" ] || [ "$(wc -l < "$S.lists" 2>/dev/null || echo 0)" -lt "$STUB_STUCK_UNTIL" ]; }; then
      echo "ERROR: (SimulatedStuck) $id will not go." >&2; echo "Code: SimulatedStuck" >&2; exit 1
    fi
    # How az resource delete reports a failed delete: a generic line, the
    # reason only with --verbose.
    if [ -n "\${STUB_GENERIC:-}" ] && [ "$id" = "$STUB_GENERIC" ]; then
      echo "ERROR: Some resources failed to be deleted (run with \\\`--verbose\\\` for more information):" >&2
      case "$*" in *--verbose*) echo "INFO: (CannotDeleteResource) Cannot delete $id: operation in progress." >&2 ;; esac
      exit 1
    fi
    name="\${id##*/}"
    case "$id" in
      */virtualNetworks/*)
        if has /networkInterfaces/ || has /privateEndpoints/; then
          echo "ERROR: (InUseSubnetCannotBeDeleted) Subnet is in use." >&2; exit 1; fi ;;
      */registries/*)
        if has /privateEndpoints/pe-acr; then
          echo "ERROR: (RegistryHasPrivateEndpoint) simulated." >&2; exit 1; fi ;;
      */networkInterfaces/*)
        if has "/privateEndpoints/\${name%%.nic.*}"; then
          echo "ERROR: (InUseNetworkInterfaceCannotBeDeleted) in use by a private endpoint." >&2; exit 1; fi ;;
      */privateEndpoints/*)
        if grep -q "/virtualNetworks/[^/]*\tFailed" "$S"; then
          echo "ERROR: (ReferencedResourceNotProvisioned) the virtual network is in the Failed state." >&2; exit 1; fi ;;
    esac
    grep -v -F -- "$id" "$S" | { [ "\${id#*/privateEndpoints/}" != "$id" ] && grep -v -F -- "/networkInterfaces/$name.nic." || cat; } > "$S.n"
    mv "$S.n" "$S"
    echo "$id" >> "$S.log"
    exit 0 ;;
esac
echo "unexpected az $*" >&2; exit 2
`

let dir: string
let state: string

async function run(rows: string[][], env: Record<string, string> = {}) {
  await writeFile(state, rows.map((r) => r.join('\t')).join('\n') + '\n')
  try {
    const r = await exec('bash', [SCRIPT, 'rg-v'], {
      timeout: 60_000,
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, STUB_STATE: state, TMPDIR: dir, ...env },
    })
    return { code: 0, out: `${r.stdout}${r.stderr}` }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: typeof e.code === 'number' ? e.code : 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

// What the two failed VNet runs left, plus a database that goes in tier 2.
const AFTER_FAILED_VNET = [
  [VNET, 'Failed'],
  [ACR, 'Succeeded'],
  [pe('acr'), 'Succeeded'], [nic('acr'), 'Succeeded'],
  [pe('kv'), 'Succeeded'], [nic('kv'), 'Succeeded'],
  [pe('redis'), 'Failed'], [nic('redis'), 'Succeeded'],
  [POSTGRES, 'Failed'],
]

describe.skipIf(PUBLIC_SNAPSHOT)('empty-resource-group.sh', () => {
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'empty-rg-'))
    state = join(dir, 'state.tsv')
    await writeFile(join(dir, 'az'), AZ_STUB)
    await writeFile(join(dir, 'sleep'), '#!/bin/sh\nexit 0\n')
    await chmod(join(dir, 'az'), 0o755)
    await chmod(join(dir, 'sleep'), 0o755)
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('empties the group a failed VNet deployment left behind', async () => {
    const r = await run(AFTER_FAILED_VNET)
    expect(r.out).toContain('rg-v is empty')
    expect(r.code).toBe(0)
    expect(await readFile(state, 'utf8')).toBe('')
    // The Failed VNet is re-applied; the endpoints go before the VNet and
    // before the registry.
    expect(r.out).toContain('re-applied failed Microsoft.Network/virtualNetworks/vnet-v')
    const order = (await readFile(`${state}.log`, 'utf8')).trim().split('\n')
    expect(order.indexOf(VNET)).toBeGreaterThan(order.indexOf(pe('acr')))
    expect(order.indexOf(VNET)).toBeGreaterThan(order.indexOf(pe('kv')))
    expect(order.indexOf(ACR)).toBeGreaterThan(order.indexOf(pe('acr')))
  })

  it('names what is not yet deleted on each pass, with its error', async () => {
    const r = await run(AFTER_FAILED_VNET)
    expect(r.out).toMatch(/not yet: Microsoft\.Network\/privateEndpoints\/pe-kv-v: ERROR: \(ReferencedResourceNotProvisioned\)/)
  })

  it('prints each failed removal\'s full error on the last pass, and fails', async () => {
    const r = await run([[ACR, 'Succeeded'], [POSTGRES, 'Succeeded']], { STUB_STUCK: ACR })
    expect(r.code).toBe(1)
    expect(r.out).toContain('Pass 10: 1 resources')
    expect(r.out).toContain('Errors on the last pass:')
    expect(r.out).toContain('::group::Microsoft.ContainerRegistry/registries/crv')
    expect(r.out).toContain('Code: SimulatedStuck')
    expect(r.out).toContain('::error::Could not delete Microsoft.ContainerRegistry/registries/crv: ERROR: (SimulatedStuck)')
    expect(r.out).toContain('Still in rg-v after 10 passes')
    expect(r.out.split('Errors on the last pass:')).toHaveLength(2)
  })

  it('retries a delete with the newest API version the region lists', async () => {
    // The newest listed version is a preview; the retry takes the newest stable one.
    const r = await run(AFTER_FAILED_VNET, { STUB_OLD_API: '2026-05-01' })
    expect(r.out).toContain('rg-v is empty')
    expect(r.code).toBe(0)
    expect(r.out).toContain('re-applied failed Microsoft.Network/virtualNetworks/vnet-v')
    expect(r.out).not.toContain('NoRegisteredProviderFound')
  })

  it('reports the original error when Azure lists no versions to retry with', async () => {
    const r = await run([[pe('kv'), 'Succeeded']], { STUB_OLD_API: '2026-05-01', STUB_NO_LIST: '1' })
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::Could not delete Microsoft.Network/privateEndpoints/pe-kv-v: ERROR: (NoRegisteredProviderFound)')
  })

  it('still reports a delete no listed API version can do', async () => {
    const r = await run([[pe('kv'), 'Succeeded']], { STUB_OLD_API: '2026-05-01', STUB_STUCK: pe('kv') })
    expect(r.code).toBe(1)
    expect(r.out).toContain('::error::Could not delete Microsoft.Network/privateEndpoints/pe-kv-v: ERROR: (SimulatedStuck)')
  })

  it('never says empty when it cannot list the group, and fails', async () => {
    // The first list (pass 1) answers; the second (pass 2) fails.
    const r = await run([[ACR, 'Succeeded']], { STUB_STUCK: ACR, STUB_LIST_FAILS_FROM: '2' })
    expect(r.code).toBe(1)
    expect(r.out).not.toContain('rg-v is empty')
    expect(r.out).toContain('::error::Cannot list the resources in rg-v, so cannot tell whether it is empty: ERROR: AADSTS700024')
  })

  it('treats a warning on a successful list as nothing, not a resource', async () => {
    const r = await run([[ACR, 'Succeeded']], { STUB_LIST_WARN: '1' })
    expect(r.out).toContain('rg-v is empty')
    expect(r.code).toBe(0)
  })

  it('with a budget, hands an expired sign-in to the next round (exit 75)', async () => {
    const r = await run([[ACR, 'Succeeded']], { STUB_STUCK: ACR, STUB_LIST_FAILS_FROM: '2', EMPTY_RG_BUDGET_MIN: '60' })
    expect(r.code).toBe(75)
    expect(r.out).toContain('The Azure sign-in expired: ERROR: AADSTS700024')
    expect(r.out).not.toContain('rg-v is empty')
  })

  it('names the reason a delete failed, not az\'s generic line', async () => {
    const r = await run([[pe('kv'), 'Succeeded']], { STUB_GENERIC: pe('kv') })
    expect(r.code).toBe(1)
    expect(r.out).toMatch(/not yet: Microsoft\.Network\/privateEndpoints\/pe-kv-v: INFO: \(CannotDeleteResource\)/)
    expect(r.out).toContain('::error::Could not delete Microsoft.Network/privateEndpoints/pe-kv-v: INFO: (CannotDeleteResource)')
  })

  it('with a time budget, stops after it with what is left and exits 75', async () => {
    const r = await run([[ACR, 'Succeeded'], [POSTGRES, 'Succeeded']], { STUB_STUCK: ACR, EMPTY_RG_BUDGET_MIN: '0' })
    expect(r.code).toBe(75)
    expect(r.out).toContain('Pass 1: 2 resources')
    expect(r.out).not.toContain('Pass 2')
    expect(r.out).toContain('Stopping after 0 minutes, before the Azure sign-in expires, with 1 left:')
    expect(r.out).toContain('  Microsoft.ContainerRegistry/registries/crv')
    expect(r.out).toContain('::error::Could not delete Microsoft.ContainerRegistry/registries/crv: ERROR: (SimulatedStuck)')
    expect(r.out).not.toContain('rg-v is empty')
  })

  it('with a time budget, passes on past 10 until the group is empty', async () => {
    // pe-kv cannot go until the 12th list: more than the 10-pass limit.
    const r = await run([[pe('kv'), 'Succeeded']], { STUB_STUCK_UNTIL: '12', STUB_STUCK: pe('kv'), EMPTY_RG_BUDGET_MIN: '60' })
    expect(r.out).toContain('Pass 11: 1 resources')
    expect(r.out).toContain('rg-v is empty')
    expect(r.code).toBe(0)
  })

  it('refuses a group without the validation tag', async () => {
    await writeFile(join(dir, 'az'), '#!/bin/sh\n[ "$1 $2" = "group show" ] && echo production\nexit 0\n')
    const r = await run([[ACR, 'Succeeded']])
    expect(r.code).toBe(1)
    expect(r.out).toContain('refusing to empty it')
  })
})
