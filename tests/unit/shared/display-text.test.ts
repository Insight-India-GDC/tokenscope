/*
 * shared/schemas/display-text.ts: the write validator and the read-side cleaner
 * for admin-authored names that reach every member's agent (#1394).
 */
import { describe, it, expect } from 'vitest'
import { ACTIVITY_LABEL_MAX, PROJECT_NAME_MAX, cleanDisplayText, displayText } from '../../../shared/schemas/display-text'

describe('displayText counts code points, as Postgres char_length does', () => {
  it('an emoji is one character: exactly max passes, max+1 fails', () => {
    const s = displayText(PROJECT_NAME_MAX)
    expect(s.safeParse('😀'.repeat(PROJECT_NAME_MAX)).success).toBe(true)
    expect(s.safeParse('😀'.repeat(PROJECT_NAME_MAX + 1)).success).toBe(false)
  })
  it('accepts CJK, Arabic and Cyrillic; rejects tabs, newlines and escapes; trims when asked', () => {
    const s = displayText(ACTIVITY_LABEL_MAX, { trim: true })
    for (const ok of ['設計レビュー', 'مراجعة', 'Ревью', '  padded  ']) expect(s.safeParse(ok).success, ok).toBe(true)
    for (const bad of ['a\tb', 'a\nb', 'a\u001b[2Jb', '', '   ']) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    expect(s.parse('  padded  ')).toBe('padded')
  })
})

describe('C1 controls are controls too', () => {
  it('rejects U+009B (one-character CSI) and the rest of U+0080-U+009F; accepts Latin-1 letters', () => {
    const s = displayText(PROJECT_NAME_MAX)
    for (const bad of ['ok\u009b2J', 'a\u0080b', 'a\u009fb']) expect(s.safeParse(bad).success, JSON.stringify(bad)).toBe(false)
    for (const ok of ['Café é ñ ü', 'a\u00a0b']) expect(s.safeParse(ok).success, ok).toBe(true)
  })
  it('the cleaner strips them on the way out', () => {
    expect(cleanDisplayText('ok\u009b2J', 64)).toBe('ok 2J')
  })
})

describe('cleanDisplayText bounds a legacy value on the way out', () => {
  it('leaves a valid value unchanged', () => {
    expect(cleanDisplayText('Project Ålpha 😀', PROJECT_NAME_MAX)).toBe('Project Ålpha 😀')
  })
  it('turns control runs into one space, trims, and cuts to max code points', () => {
    expect(cleanDisplayText('a\n\u001b[2Jb\t', 64)).toBe('a [2Jb')
    expect([...cleanDisplayText('😀'.repeat(70), 64)].length).toBe(64)
  })
})
