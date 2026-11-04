/*
 * readRawPage — read ONE provider response as an UNPARSED body, for the wire-shape
 * diagnostic (server/diagnostics/).
 *
 * WHY IT EXISTS. Every provider client here returns a Zod-PARSED object, and a Zod
 * parse is lossy in exactly the two ways that would make a wire-shape report lie:
 *   - a non-passthrough object STRIPS undeclared keys, so a field the provider
 *     newly sends becomes invisible;
 *   - `.default(0)` FABRICATES a key that never arrived, so presence-counts read
 *     100% for a field the wire omitted.
 * Summarising the parsed object would therefore make the probe structurally
 * incapable of answering the question it exists to answer. It reads the body
 * before any schema touches it.
 *
 * It does NOT open a second HTTP path: the callers are thin methods on the
 * EXISTING clients that reuse those clients' own URL builders, headers and
 * resilientFetch. Nothing here knows about credentials.
 *
 * ERROR BODIES ARE RETURNED RAW, deliberately. A classified "safe" reason is a
 * lossy summary, and this project has repeatedly been sent to the wrong layer by
 * one — a 400 is a REQUEST error, never connectivity, and only the body says why.
 * The body is capped and scrubbed of any credential handed to `scrub` (an exact
 * substring match — cheap, and it can only remove).
 */

/** How much of a provider error body is kept. Enough for a JSON error envelope. */
export const MAX_ERROR_BODY_CHARS = 4000

export interface RawPageOk {
  ok: true
  status: number
  /** The response body, parsed as JSON but NOT schema-validated. */
  body: unknown
}

export interface RawPageErr {
  ok: false
  status: number
  /**
   * The provider's own error text, verbatim apart from truncation and credential
   * scrubbing. `status: 0` means the request never got a response (DNS/TLS/timeout)
   * and the text is our transport error.
   */
  bodyText: string
  /** True when the body was longer than MAX_ERROR_BODY_CHARS and has been cut. */
  truncated: boolean
}

export type RawPage = RawPageOk | RawPageErr

/**
 * Remove every occurrence of each secret from `text`, verbatim or XML-escaped.
 * Substring removal only: it makes no claim to detect a credential we were not
 * given, it only guarantees the ones we hold cannot survive verbatim or as an
 * XML error body echoes them (a signed URL's `&` comes back as `&amp;`).
 *
 * NO LENGTH FLOOR. This used to skip any secret shorter than 8 characters, on
 * the reasoning that a short value "would match everywhere and destroy the
 * message" and "a real credential is never this short". The second half is an
 * assumption about configuration, not a property of this function, and the
 * combination made the guarantee above conditional on it while stating it
 * unconditionally — a caller reading "the ones we hold cannot survive verbatim"
 * got silence instead for exactly the values most likely to be a misconfiguration.
 * Every non-empty secret is now removed. A pathologically short one will mangle
 * the error text, and that is the correct trade: a mangled message is recoverable
 * by looking at the configuration, a leaked credential is not. Empty / null /
 * undefined are still skipped — an empty needle matches at every position and
 * would shred the text while removing nothing.
 */
export function scrubSecrets(text: string, secrets: ReadonlyArray<string | undefined | null>): string {
  let out = text
  for (const s of secrets) {
    if (!s) continue
    for (const form of new Set([s, xmlEscape(s)])) out = out.split(form).join('<redacted-credential>')
  }
  return out
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function cap(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_ERROR_BODY_CHARS) return { text, truncated: false }
  return { text: text.slice(0, MAX_ERROR_BODY_CHARS), truncated: true }
}

/**
 * The error shape for a body the caller read ITSELF.
 *
 * `readRawPage` below owns the normal path, but it JSON-parses a successful body,
 * which is wrong for a response that is not JSON — an NDJSON file, for instance.
 * A caller that has to read such a body its own way still needs the SAME two
 * guarantees on its failures (capped, and scrubbed of the credentials it holds),
 * and there must be one implementation of them rather than a second that drifts.
 */
export function errorPageFrom(
  status: number,
  text: string,
  secrets: ReadonlyArray<string | undefined | null> = [],
): RawPageErr {
  const capped = cap(scrubSecrets(text, secrets))
  return { ok: false, status, bodyText: capped.text, truncated: capped.truncated }
}

/**
 * Turn a Response into a RawPage.
 *
 * A 200 whose body is not JSON is reported as an ERROR, not as an empty shape:
 * an HTML error page or a truncated body is a genuine drift signal, and calling
 * it "shape: nothing" would hide it.
 */
export async function readRawPage(
  res: Response,
  opts: { secrets?: ReadonlyArray<string | undefined | null> } = {},
): Promise<RawPage> {
  const secrets = opts.secrets ?? []
  if (!res.ok) {
    const raw = await res.text().catch(() => '<body could not be read>')
    return errorPageFrom(res.status, raw, secrets)
  }
  const raw = await res.text().catch(() => '')
  try {
    return { ok: true, status: res.status, body: JSON.parse(raw) as unknown }
  } catch {
    const { text, truncated } = cap(scrubSecrets(raw, secrets))
    return {
      ok: false,
      status: res.status,
      bodyText: `HTTP ${res.status} but the body is not JSON: ${text}`,
      truncated,
    }
  }
}

/**
 * The ordered query parameters of a URL, repeats preserved (`group_by[]` is sent
 * twice). Reading them back off the URL the client actually built means the
 * report shows what was SENT, not what a caller believes was sent.
 */
export function paramPairsOf(url: string): Array<[string, string]> {
  return [...new URL(url).searchParams.entries()]
}

/** The path component of a URL — never the query, which can carry a login. */
export function pathOf(url: string): string {
  return new URL(url).pathname
}
