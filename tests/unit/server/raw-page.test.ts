// @vitest-environment node
/*
 * scrubSecrets — the credential-scrubbing contract behind every raw provider
 * error body the wire-shape diagnostic shows verbatim.
 *
 * The whole reason those bodies may be shown at all is this function's promise:
 * "the ones we hold cannot survive verbatim". It used to skip any secret shorter
 * than 8 characters, which made the promise conditional on an assumption about
 * configuration while stating it unconditionally. These tests pin the promise as
 * written.
 */
import { describe, it, expect } from 'vitest'
import { scrubSecrets, readRawPage, MAX_ERROR_BODY_CHARS } from '../../../server/utils/raw-page'

describe('scrubSecrets', () => {
  it('removes the XML-escaped form a blob error body echoes a signed link in', () => {
    const link = 'https://blob.example/r.csv?sv=2025-01-01&se=2026-10-16&sig=Zm9vYmFyc2ln'
    const body = `<Error><Code>AuthenticationFailed</Code><Url>${link.replace(/&/g, '&amp;')}</Url></Error>`
    const out = scrubSecrets(body, [link])
    expect(out).not.toContain('Zm9vYmFyc2ln')
    expect(out).toContain('<redacted-credential>')
  })

  it('removes a long credential wherever it appears', () => {
    const out = scrubSecrets('bad key sk-ant-0123456789 (sk-ant-0123456789)', ['sk-ant-0123456789'])
    expect(out).not.toContain('sk-ant-0123456789')
    expect(out).toBe('bad key <redacted-credential> (<redacted-credential>)')
  })

  it('removes a SHORT credential too — there is no length floor', () => {
    // 7 characters: under the old floor, and silently left in the body. A short
    // value is a misconfiguration, not a licence to publish it.
    const out = scrubSecrets('token=abc1234 rejected', ['abc1234'])
    expect(out).not.toContain('abc1234')
    expect(out).toContain('<redacted-credential>')
  })

  it.each([1, 2, 3, 4, 5, 6, 7])('removes a credential of length %i', (n) => {
    const secret = 'z'.repeat(n)
    expect(scrubSecrets(`prefix ${secret} suffix`, [secret])).not.toContain(secret)
  })

  it('skips empty / null / undefined without shredding the text', () => {
    // An empty needle matches at every position: it would destroy the message
    // while removing nothing. That is the ONE case worth skipping.
    const text = 'HTTP 403: forbidden'
    expect(scrubSecrets(text, ['', null, undefined])).toBe(text)
  })

  it('leaves a body alone when no secret occurs in it', () => {
    expect(scrubSecrets('HTTP 400: bad request', ['sk-ant-0123456789'])).toBe('HTTP 400: bad request')
  })
})

describe('readRawPage', () => {
  const res = (init: { ok: boolean; status: number; text: string }): Response =>
    ({ ok: init.ok, status: init.status, text: async () => init.text }) as unknown as Response

  it('scrubs the credential out of an error body', async () => {
    const page = await readRawPage(
      res({ ok: false, status: 401, text: 'invalid key sk-ant-0123456789' }),
      { secrets: ['sk-ant-0123456789'] },
    )
    expect(page.ok).toBe(false)
    if (page.ok) return
    expect(page.bodyText).not.toContain('sk-ant-0123456789')
  })

  it('caps and flags an over-long error body', async () => {
    const page = await readRawPage(res({ ok: false, status: 500, text: 'x'.repeat(MAX_ERROR_BODY_CHARS + 10) }))
    expect(page.ok).toBe(false)
    if (page.ok) return
    expect(page.truncated).toBe(true)
    expect(page.bodyText).toHaveLength(MAX_ERROR_BODY_CHARS)
  })

  it('treats a 200 whose body is not JSON as an ERROR, not as an empty shape', async () => {
    // An HTML error page summarised as "shape: nothing" would hide a real signal.
    const page = await readRawPage(res({ ok: true, status: 200, text: '<html>gateway</html>' }))
    expect(page.ok).toBe(false)
    if (page.ok) return
    expect(page.bodyText).toContain('not JSON')
  })
})
