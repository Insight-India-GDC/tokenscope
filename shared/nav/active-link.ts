/*
 * Which header nav link is the current section.
 *
 * Vue Router's `active-class` only marks a link active when its route record
 * is a PARENT of the current match. Nuxt's /admin/* pages are siblings of
 * /admin (pages/admin/index.vue, pages/admin/users.vue, ...), not children, so
 * the Admin tab lit up on /admin alone and went dark on every other admin page.
 * This decides by PATH instead: a link is active on its own path and on every
 * path below it. Home ('/') is exact, or it would match every route.
 *
 * A link's query string (the Reporting entry may carry `?scope=...`) is not
 * part of the section, so it is ignored.
 */
export function isNavLinkActive(currentPath: string, linkTo: string): boolean {
  const target = (linkTo.split(/[?#]/, 1)[0] ?? '').replace(/\/+$/, '') || '/'
  const path = (currentPath.split(/[?#]/, 1)[0] ?? '').replace(/\/+$/, '') || '/'
  if (target === '/') return path === '/'
  return path === target || path.startsWith(`${target}/`)
}
