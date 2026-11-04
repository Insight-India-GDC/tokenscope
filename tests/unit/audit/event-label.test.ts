import { describe, it, expect } from 'vitest'
import { auditEventLabel } from '../../../shared/audit/event-label'

describe('auditEventLabel', () => {
  it('turns a kebab code into a sentence', () => {
    expect(auditEventLabel('project-request-approved')).toBe('Project request approved')
  })
  it('handles snake codes', () => {
    expect(auditEventLabel('oauth_token_issue')).toBe('OAuth token issue')
  })
  it('keeps acronyms capitalised wherever they fall', () => {
    expect(auditEventLabel('session-pii-purged')).toBe('Session PII purged')
    expect(auditEventLabel('teammate-jit-no-upn')).toBe('Teammate JIT no UPN')
    expect(auditEventLabel('oauth-gc-swept')).toBe('OAuth GC swept')
  })
  it('says Business Unit, not the cou_owner identifier', () => {
    expect(auditEventLabel('cou-owner-assigned')).toBe('Business Unit owner assigned')
  })
  it('returns an unparseable code unchanged', () => {
    expect(auditEventLabel('--')).toBe('--')
  })
})
