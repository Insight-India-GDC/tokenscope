/*
 * directory-exclusions matcher — the pure policy logic (no DB). Locks in the
 * two load-bearing safety properties: FAIL-OPEN (empty patterns / null upn
 * match nothing → the cleanup worker deactivates nothing) and the MATCH-ALL
 * FOOTGUN guard (a one-char pattern can't empty every picker).
 */
import { describe, it, expect } from 'vitest'
import {
  isExcludedUpn,
  upnGlobMatches,
  upnGlobToSqlLike,
  validateExclusionPattern,
} from '../../server/utils/directory-exclusions'
import { escapeLikeLiteral } from '../../server/utils/sql-like'

describe('isExcludedUpn', () => {
  it('FAIL-OPEN: empty pattern list matches nothing', () => {
    expect(isExcludedUpn('rtanaka-cld@contoso.onmicrosoft.com', [])).toBe(false)
  })

  it('FAIL-OPEN: null / blank upn matches nothing', () => {
    expect(isExcludedUpn(null, ['*@*.onmicrosoft.com'])).toBe(false)
    expect(isExcludedUpn('', ['*@*.onmicrosoft.com'])).toBe(false)
  })

  it('matches a privileged onmicrosoft account against a tenant pattern', () => {
    expect(isExcludedUpn('rtanaka-cld@contoso.onmicrosoft.com', ['*@contoso.onmicrosoft.com'])).toBe(true)
  })

  it('does NOT match a standard vanity-domain account', () => {
    expect(isExcludedUpn('rob.oconnor3@example.com', ['*@contoso.onmicrosoft.com'])).toBe(false)
  })

  it('is case-insensitive', () => {
    expect(isExcludedUpn('RTanaka-CLD@contoso.onmicrosoft.com', ['*@contoso.onmicrosoft.com'])).toBe(true)
  })

  it('matches on ANY pattern in the list', () => {
    const patterns = ['*-cld@*', 'svc-*@*.example.com']
    expect(isExcludedUpn('roconno3-cld@example.com', patterns)).toBe(true)
    expect(isExcludedUpn('svc-billing@app.example.com', patterns)).toBe(true)
    expect(isExcludedUpn('normal.user@example.com', patterns)).toBe(false)
  })
})

describe('upnGlobMatches', () => {
  it('treats dots and other regex metacharacters as literal (does not over-match)', () => {
    expect(upnGlobMatches('*@*.onmicrosoft.com', 'x@a.onmicrosoft.com')).toBe(true)
    expect(upnGlobMatches('*@*.onmicrosoft.com', 'x@aXonmicrosoftYcom')).toBe(false)
    expect(upnGlobMatches('a+b(c)@x.io', 'a+b(c)@x.io')).toBe(true)
    expect(upnGlobMatches('a+b(c)@x.io', 'aab(c)@x.io')).toBe(false)
  })

  it('anchors — a pattern matches the WHOLE upn', () => {
    expect(upnGlobMatches('admin@corp.com', 'admin@corp.com')).toBe(true)
    expect(upnGlobMatches('admin@corp.com', 'admin@corp.com.evil.test')).toBe(false)
    expect(upnGlobMatches('admin@corp.com', 'x.admin@corp.com')).toBe(false)
  })

  it('`*` matches any run including the empty one, and runs of `*` behave as one', () => {
    expect(upnGlobMatches('*-cld@*', '-cld@x')).toBe(true)
    expect(upnGlobMatches('a**b@x.io', 'ab@x.io')).toBe(true)
    expect(upnGlobMatches('a*b*c@x.io', 'a-b-b-c@x.io')).toBe(true)
    expect(upnGlobMatches('a*b*c@x.io', 'a-c-b@x.io')).toBe(false)
    expect(upnGlobMatches('svc-*@*.example.com', 'svc-@app.example.com')).toBe(true)
    expect(upnGlobMatches('*@x.io*', 'a@x.io')).toBe(true)
  })

  it('a many-wildcard pattern against a near-miss upn stays linear (no catastrophic backtracking)', () => {
    const started = Date.now()
    expect(isExcludedUpn(`${'a'.repeat(50)}@corp.co`, [`*${'a*'.repeat(10)}@corp.com`])).toBe(false)
    expect(Date.now() - started).toBeLessThan(50)
  }, 5_000)
})

describe('upnGlobToSqlLike (DB-side match count)', () => {
  it('translates * → % and escapes LIKE metacharacters in literals', () => {
    expect(upnGlobToSqlLike('*@contoso.onmicrosoft.com')).toBe('%@contoso.onmicrosoft.com')
    expect(upnGlobToSqlLike('svc_*@app.example.com')).toBe('svc\\_%@app.example.com') // _ escaped
    expect(upnGlobToSqlLike('a*b*c@x.io')).toBe('a%b%c@x.io')
  })
})

describe('escapeLikeLiteral — the ILIKE search-term escaper the admin typeaheads bind (server/utils/sql-like.ts)', () => {
  it('escapes a literal underscore so ILIKE cannot read it as a single-character wildcard', () => {
    // Unescaped, `_` is a LIKE/ILIKE single-char wildcard: an ILIKE search for
    // 'a_b' would ALSO match 'axb'. Escaped, the term is a literal — pair with
    // `ESCAPE ${LIKE_ESCAPE}` bound as a parameter (never `ESCAPE '\'` written
    // into the template — see sql-like.ts's header for that trap).
    expect(escapeLikeLiteral('a_b')).toBe('a\\_b')
    expect(escapeLikeLiteral('a_b')).not.toBe('axb')
  })

  it('escapes a literal percent so ILIKE cannot read it as a multi-character wildcard', () => {
    expect(escapeLikeLiteral('100%done')).toBe('100\\%done')
  })

  it('escapes a literal backslash (the escape character itself)', () => {
    expect(escapeLikeLiteral('a\\b')).toBe('a\\\\b')
  })

  it('leaves an ordinary search term untouched', () => {
    expect(escapeLikeLiteral('jane.doe')).toBe('jane.doe')
  })
})

describe('validateExclusionPattern — match-all footgun guard', () => {
  it('rejects the catastrophic match-all patterns', () => {
    for (const p of ['', '   ', '*', '**', '***', '*@*', '*@*.*']) {
      expect(validateExclusionPattern(p), `pattern ${JSON.stringify(p)}`).not.toBeNull()
    }
  })

  it('rejects a domain with no literal label', () => {
    expect(validateExclusionPattern('*@*.com')).not.toBeNull() // no real domain label
  })

  it('rejects overly long patterns', () => {
    expect(validateExclusionPattern('a'.repeat(201) + '@x.com')).not.toBeNull()
  })

  it('accepts realistic org patterns', () => {
    for (const p of ['*@contoso.onmicrosoft.com', '*-cld@example.com', 'svc-*@app.example.com', 'admin@corp.io']) {
      expect(validateExclusionPattern(p), `pattern ${JSON.stringify(p)}`).toBeNull()
    }
  })
})
