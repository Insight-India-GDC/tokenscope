/*
 * A readable label for an audit event code.
 *
 * Event codes are written by ~100 call sites as literals
 * ('project-request-approved', 'oauth_token_issue'); there is no central list
 * to hang hand-written labels on, and the Audit log's filter must label codes
 * it has never seen. So the label is derived: separators become spaces, the
 * first word is capitalised, and known acronyms keep their capitals. The code
 * itself stays visible (as a tooltip) so an admin can still grep for it.
 */
const ACRONYMS: Record<string, string> = {
  oauth: 'OAuth',
  pii: 'PII',
  jit: 'JIT',
  gc: 'GC',
  upn: 'UPN',
  mcp: 'MCP',
  oid: 'OID',
  ui: 'UI',
  api: 'API',
  otel: 'OTel',
  ai: 'AI',
  cou: 'Business Unit',
}

export function auditEventLabel(code: string): string {
  const words = code.split(/[-_.:\s]+/).filter(Boolean)
  if (words.length === 0) return code
  return words
    .map((w, i) => {
      const lower = w.toLowerCase()
      if (ACRONYMS[lower]) return ACRONYMS[lower]
      return i === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower
    })
    .join(' ')
}
