// @vitest-environment node
/*
 * The Copilot legacy forwarder on a host with no git in a trusted location.
 *
 * The provenance guard refuses a span file that is tracked by git (a committed
 * file would be forwarded as this developer's usage). Without a trusted git the
 * question cannot be answered, and the guard must refuse rather than read.
 */
import { describe, it, expect, vi, afterAll } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

vi.mock('../../../plugin/scripts/trusted-git.mjs', () => ({
  trustedGitPath: () => null,
  resetTrustedGitPathCache: () => {},
}))

const suiteDir = mkdtempSync(join(tmpdir(), 'ts-fwd-nogit-'))
process.env.TOKENSCOPE_FWD_OFFSET_FILE = join(suiteDir, 'forwarder-offset')

// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — mjs import resolved by Vitest
const { isGitTracked, readNewSpans, _resetStateForTest } = await import('../../../plugin/scripts/copilot-forwarder.mjs')

afterAll(() => rmSync(suiteDir, { recursive: true, force: true }))

describe('no trusted git: the tracked-file check fails closed', () => {
  it('treats the span file as tracked', () => {
    expect(isGitTracked(join(suiteDir, 'copilot-otel.ndjson'))).toBe(true)
  })

  it('reads nothing from a span file it cannot vouch for', () => {
    _resetStateForTest()
    const spanFile = join(suiteDir, 'copilot-otel.ndjson')
    // A chat span the forwarder would otherwise forward (copilot-forwarder.test.ts's shape).
    writeFileSync(
      spanFile,
      JSON.stringify({
        type: 'span',
        name: 'chat claude-sonnet-4.6',
        spanId: 'planted',
        startTime: [1780825134, 0],
        endTime: [1780825137, 0],
        attributes: {
          'gen_ai.operation.name': 'chat',
          'gen_ai.request.model': 'claude-sonnet-4.6',
          'gen_ai.conversation.id': 'test-conv',
          'gen_ai.usage.input_tokens': 100,
          'gen_ai.usage.output_tokens': 5,
          'github.copilot.nano_aiu': 1000000000,
        },
        resource: { attributes: {} },
      }) + '\n',
    )
    expect(readNewSpans(spanFile)).toEqual([])
  })
})
