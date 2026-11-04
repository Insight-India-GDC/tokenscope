<script setup lang="ts">
/*
 * AppHeader — persistent chrome.
 *
 * Role-aware nav per the prototype's NAV map (docs/archive/ux-pilot/tokenscope-pilot-design/project/src/chrome.jsx):
 * each persona sees a different set of links. Cookie-session-driven
 * (useSession). Dark toggle is a no-op placeholder per
 * docs/archive/build-plans/mvp-lite-epic.md §Out-of-scope.
 */

import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { consola } from 'consola'
import { withReportingEntry } from '#shared/nav/reporting-entry'
import { isNavLinkActive } from '#shared/nav/active-link'
import { roleLabel } from '#shared/auth/roles'

const { session, devLogin, logout, stopImpersonating } = useSession()
const router = useRouter()

// Persona-SWITCH controls render ONLY on a demo-capable env ({local, sandbox});
// off pilot-prod they never appear (cosmetic — the server gate is authoritative).
// "Acting as" / "Stop acting" stay on isImpersonating so a user is never trapped.
const { demoCapable } = useDemoFeatures()

// Wave-V — when the session carries an impersonatorEmail, the user is
// an admin currently "wearing" a demo persona. The header chrome
// reflects this: the persona's avatar/role chip stays on top (so the
// admin sees the world the persona sees), with "Acting as <admin>"
// below as a permanent reminder. The menu's "Sign out" item is
// replaced by "Stop acting", which POSTs to /stop-impersonating.
const isImpersonating = computed(() => Boolean(session.value?.impersonatorEmail))
const impersonatorEmail = computed(() => session.value?.impersonatorEmail ?? '')

async function stopActing() {
  const result = await stopImpersonating()
  menuOpen.value = false
  await router.push(result?.landing ?? '/admin')
}

const menuOpen = ref(false)
const menuRef = ref<HTMLElement | null>(null)

const DEV_PERSONAS = [
  { key: 'developer', label: 'Developer', sub: 'Priya Iyer' },
  { key: 'manager', label: 'Manager', sub: 'Anil Verma' },
  { key: 'admin', label: 'Admin', sub: 'Lena Park' },
  { key: 'finance', label: 'Finance', sub: 'Mara Holloway' },
  // J3 (mig 0048): keep in sync with login.vue's grid + DEMO_PERSONAS.
  { key: 'cc-owner', label: 'Business Unit owner', sub: 'Owen Cole' },
] as const

const switching = ref<string | null>(null)

async function switchPersona(persona: string) {
  if (switching.value) return
  switching.value = persona
  try {
    const result = await devLogin(persona)
    menuOpen.value = false
    if (result?.landing) await router.push(result.landing)
    else await router.push('/')
  } catch (err) {
    consola.warn('persona switch failed', err)
  } finally {
    switching.value = null
  }
}

async function signOut() {
  menuOpen.value = false
  // logout() POSTs to /api/v1/auth/logout (sidecar clear + audit) then
  // navigates the browser to /auth/entra/logout (OIDC provider logout).
  // The OIDC endpoint redirects to /login after clearing the cookie,
  // so no router.push here — it would race the full-page nav.
  await logout()
}

function handleClickOutside(ev: MouseEvent) {
  if (!menuRef.value) return
  if (!menuOpen.value) return
  if (menuRef.value.contains(ev.target as Node)) return
  menuOpen.value = false
}

function handleKeydown(ev: KeyboardEvent) {
  if (ev.key === 'Escape' && menuOpen.value) {
    menuOpen.value = false
  }
  if (ev.key === 'Escape' && navOpen.value) {
    navOpen.value = false
    navToggleRef.value?.focus()
  }
}

// Narrow screens (below md, 768px): the nav links collapse behind a Menu
// button into a panel under the bar, so the header reflows at 320px wide
// (WCAG 1.4.10) instead of pushing the bell and user menu off screen. It is a
// disclosure (aria-expanded + aria-controls), not a modal: the page stays
// usable, Escape closes it and returns focus to the button, and following a
// link closes it.
const navOpen = ref(false)
const navToggleRef = ref<HTMLButtonElement | null>(null)

onMounted(() => {
  if (import.meta.client) {
    document.addEventListener('click', handleClickOutside)
    document.addEventListener('keydown', handleKeydown)
  }
})
onBeforeUnmount(() => {
  if (import.meta.client) {
    document.removeEventListener('click', handleClickOutside)
    document.removeEventListener('keydown', handleKeydown)
  }
})

const role = computed(() => (session.value?.role ? roleLabel(session.value.role) : 'Guest'))
const userInitials = computed(() => {
  const name = session.value?.displayName ?? session.value?.email ?? '?'
  const parts = name.split(/[\s.@]+/).filter(Boolean)
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase()
})

// The unread-bell count (open = unread+read+acknowledged, i.e. unresolved). A
// stable `key` lets the surfaces that mutate inbox items (the /inbox page, the
// homepage drawer) refresh THIS fetch via refreshNuxtData('inbox-open-count')
// so the badge updates the moment an item is resolved/dismissed — without it the
// count was stale until a hard reload. Also re-synced on navigation as a backstop.
// LAZY + client-only, deliberately. A plain `useFetch` here is awaited by
// suspense, so this badge held up first paint of EVERY page for a number that
// is decoration until it arrives — the pattern docs/design/
// admin-nav-responsiveness.md outlawed for admin pages and never applied to the
// global chrome. `default` keeps the badge at 0 until the count lands.
const { data: inbox, refresh: refreshInboxCount } = useLazyFetch<{
  items: unknown[]
  total: number
}>('/api/v1/me/inbox?ack_state=open&limit=1', {
  key: 'inbox-open-count',
  server: false,
  default: () => ({ items: [], total: 0 }),
  watch: [session],
})
const unreadCount = computed(() => inbox.value?.total ?? 0)
const route = useRoute()
watch(() => route.fullPath, () => {
  refreshInboxCount()
  navOpen.value = false
})

// The current section by PATH (shared/nav/active-link.ts): router active-class
// cannot see that /admin/users belongs to the Admin tab.
const isActive = (to: string) => isNavLinkActive(route.path, to)

// Developer-first ordering; Admin always last. Inbox lives in the bell, not the
// nav. `disabled` marks signposted-but-unbuilt items per the
// "disabled-with-tooltip > silent placeholder" lesson (none currently —
// My projects / My usage shipped in the consumption sprint).
//
// ONE WORD, ONE MEANING. The nav used to read "My usage · My projects · My
// consumption": two English synonyms naming two different pages, so nothing in
// the nav said which held budgets and which held the model mix. The dashboard is
// now "Home"; "My usage" names the usage-detail page (`/usage`), and the word
// "consumption" is not a nav label at all.
const NAV_BY_ROLE: Record<string, Array<{ to: string; label: string; disabled?: boolean }>> = {
  developer: [
    { to: '/', label: 'Home' },
    { to: '/projects', label: 'My projects' },
    { to: '/usage', label: 'My usage' },
  ],
  // Team / Practices / Finance collapsed into the consolidated Reporting entry
  // (spliced in navLinks below) at the reporting cutover.
  /*
   * EVERY ROLE HAS PERSONAL SPEND. Manager, admin and the org-wide role used to get
   * "Home" (plus Reporting/Admin) and nothing else — no "My usage", no "My
   * projects" — while `platform-admin` got both. That was never an access
   * boundary: the pages RENDER for these roles today (a Global-finance capture
   * of /usage returns a full page), so the effect was simply that a manager
   * could not reach their own untagged days without typing the URL.
   *
   * A manager incurs spend, has days needing a decision, and has a budget to
   * learn from — which is the product's whole premise. Reporting answers "how is
   * my org doing"; it has never answered "what did I spend".
   */
  manager: [
    { to: '/', label: 'Home' },
    { to: '/projects', label: 'My projects' },
    { to: '/usage', label: 'My usage' },
  ],
  admin: [
    { to: '/', label: 'Home' },
    { to: '/projects', label: 'My projects' },
    { to: '/usage', label: 'My usage' },
    { to: '/admin', label: 'Admin' },
  ],
  // Cross-region super-admin sees everything.
  'platform-admin': [
    { to: '/', label: 'Home' },
    { to: '/projects', label: 'My projects' },
    { to: '/usage', label: 'My usage' },
    { to: '/admin', label: 'Admin' },
  ],
}

// Reporting visibility is decided SERVER-SIDE and arrives on the session
// (server/auth/nav-visibility.ts). CC ownership is still a RELATIONSHIP, not a
// role (J3, mig 0048) and report-access grants are a third input — but the
// chrome no longer fetches those inputs and OR-s them itself. It used to, over
// two blocking round-trips, and the browser could disagree with the server
// about who may see what.

/*
 * The consolidated Reporting area (/reporting) is the SINGLE reporting surface — it
 * replaced the former Team / Practices / Finance / Business-Unit pages at the reporting
 * cutover (legacy pages deleted; no redirects — internal links now point at the scopes).
 *
 * Three things open it, and only ONE of them is a role: a reporting role, an
 * active cou_owner row (a RELATIONSHIP, not a role — J3, mig 0048), or a
 * report-access grant (mig 0129 — a granted developer is in neither of the
 * other two, and without this arm an admin could grant access the nav never
 * showed). All three are combined server-side in
 * server/auth/nav-visibility.ts and arrive as `session.reporting`; the role
 * list itself now lives in shared/auth/roles.ts so client and server cannot
 * drift. No feature flag: at pilot scale we ship directly and git-revert.
 */
const navLinks = computed(() => {
  const r = session.value?.role ?? 'developer'
  const base = NAV_BY_ROLE[r] ?? NAV_BY_ROLE.developer ?? []

  // Splicing and the link target live in shared/nav/reporting-entry.ts so they
  // are testable without mounting the chrome — a server test cannot see the
  // client inverting the verdict or dropping the owner deep-link.
  return withReportingEntry(base, session.value?.reporting)
})
</script>

<template>
  <header
    class="sticky top-0 z-30 bg-white/95 backdrop-blur-md border-b border-brand-harmony/10"
  >
    <div class="max-w-[1600px] mx-auto px-4 sm:px-6 lg:px-10 h-16 flex items-center gap-2 sm:gap-4 lg:gap-8">
      <!-- Logo lockup -->
      <NuxtLink to="/" class="flex items-center gap-3 group shrink-0">
        <div
          class="w-8 h-8 rounded-lg flex items-center justify-center text-white font-extrabold text-sm tracking-tight shadow-[inset_0_-2px_8px_rgba(0,0,0,0.15)]"
          style="
            background: radial-gradient(circle at 30% 30%, var(--brand-vision), var(--brand-harmony) 70%);
          "
        >
          TS
        </div>
        <div class="flex flex-col leading-tight">
          <span class="font-sans font-extrabold text-base tracking-tight text-carbon"
            >TokenScope</span
          >
          <span class="hidden sm:inline font-slab italic text-[11px] text-carbon-3 tracking-[0.2px]"
            >an open-source tool</span
          >
        </div>
      </NuxtLink>

      <!-- Nav links (md and up). The active section is decided by path
           (isActive), and marked with aria-current for screen readers. -->
      <nav class="hidden md:flex gap-1 flex-1 min-w-0" aria-label="Main">
        <template v-for="link in navLinks" :key="link.to">
          <span
            v-if="link.disabled"
            class="px-3.5 py-2 rounded-lg text-sm font-semibold text-carbon-3/50 tracking-tight cursor-not-allowed select-none"
            title="Coming soon"
            aria-disabled="true"
          >
            {{ link.label }} <span class="sr-only">(coming soon)</span>
          </span>
          <NuxtLink
            v-else
            :to="link.to"
            class="px-3.5 py-2 rounded-lg text-sm font-semibold tracking-tight whitespace-nowrap hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors"
            :class="isActive(link.to) ? 'bg-brand-harmony-sheer text-brand-harmony' : 'text-carbon-2'"
            :aria-current="isActive(link.to) ? 'page' : undefined"
            active-class=""
            exact-active-class=""
          >
            {{ link.label }}
          </NuxtLink>
        </template>
      </nav>

      <!-- Below md the links live behind this button (panel at the end of the header). -->
      <div class="flex-1 md:hidden" />
      <button
        ref="navToggleRef"
        type="button"
        class="md:hidden w-9 h-9 inline-flex items-center justify-center rounded-lg text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors"
        :aria-expanded="navOpen"
        aria-controls="app-nav-mobile"
        aria-label="Menu"
        data-testid="app-nav-toggle"
        @click="navOpen = !navOpen"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
          <path v-if="navOpen" d="M6 6l12 12M18 6 6 18" />
          <path v-else d="M4 7h16M4 12h16M4 17h16" />
        </svg>
      </button>

      <!-- Icon buttons. Dark toggle is an explicit placeholder per
           design-notes §0 (no-op icon for v1). Search is deferred until
           a real cross-resource search lands — hidden rather than dead.
           Inbox bell links to /inbox with unread badge. -->
      <button
        type="button"
        title="Toggle theme (placeholder for v1)"
        aria-label="Toggle theme (placeholder for v1)"
        disabled
        data-testid="dark-toggle"
        class="hidden sm:inline-flex w-9 h-9 items-center justify-center rounded-lg text-carbon-3 cursor-not-allowed opacity-60"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
        </svg>
      </button>

      <NuxtLink
        to="/inbox"
        title="Open inbox"
        aria-label="Open inbox"
        data-testid="inbox-bell"
        class="relative shrink-0 w-9 h-9 inline-flex items-center justify-center rounded-lg text-carbon-2 hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors"
      >
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
          <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
        </svg>
        <span
          v-if="unreadCount > 0"
          class="absolute top-1.5 right-1.5 min-w-[16px] h-4 px-1 rounded-lg bg-brand-hunger text-white text-[10px] font-bold inline-flex items-center justify-center border-2 border-white"
        >
          {{ unreadCount }}
        </span>
      </NuxtLink>

      <!--
        Role badge + persona menu. Clicking opens a dropdown to switch
        persona (dev-mode only flow today) or sign out. The button
        targets the same shape as the prior static badge — a logged-in
        user sees no visual diff at rest.
      -->
      <div ref="menuRef" class="relative shrink-0">
        <button
          type="button"
          data-testid="role-badge"
          class="flex items-center gap-2 px-2 py-1 rounded-lg hover:bg-brand-harmony-sheer focus-visible:outline-2 focus-visible:outline-brand-harmony cursor-pointer transition-colors"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          aria-label="Open user menu"
          @click="menuOpen = !menuOpen"
        >
          <div
            class="w-8 h-8 rounded-full bg-brand-harmony text-white inline-flex items-center justify-center text-xs font-bold"
            aria-hidden="true"
          >
            {{ userInitials }}
          </div>
          <div class="hidden sm:block leading-tight text-left">
            <div class="text-[13px] font-bold text-carbon">{{ role }}</div>
            <div
              v-if="isImpersonating"
              data-testid="acting-as"
              class="text-[11px] text-brand-hunger font-semibold"
              :title="`Acting as ${impersonatorEmail}`"
            >
              Acting as {{ impersonatorEmail }}
            </div>
            <div v-else class="text-[11px] text-carbon-3">{{ session?.displayName ?? session?.email ?? '' }}</div>
          </div>
          <svg
            class="w-3 h-3 text-carbon-3 ml-0.5"
            :class="menuOpen ? 'rotate-180' : ''"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true"
          >
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <div
          v-if="menuOpen"
          role="menu"
          data-testid="user-menu"
          class="absolute right-0 mt-2 w-64 max-w-[calc(100vw-2rem)] bg-white border border-calm rounded-lg shadow-lg z-50 py-2"
        >
          <!-- Persona switcher — demo-capable envs only (local/sandbox). Never
               renders on dev/staging/prod; the server refuses regardless. -->
          <template v-if="demoCapable">
            <div class="px-3 py-1.5 text-[11px] font-bold uppercase tracking-[1.2px] text-carbon-3">
              Switch persona
            </div>
            <button
              v-for="p in DEV_PERSONAS"
              :key="p.key"
              type="button"
              role="menuitem"
              :disabled="switching !== null"
              :data-testid="`menu-switch-${p.key}`"
              class="w-full px-3 py-2 text-left flex items-center justify-between hover:bg-brand-harmony-sheer disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer transition-colors"
              @click="switchPersona(p.key)"
            >
              <div class="leading-tight">
                <div class="text-[13px] font-bold text-carbon">{{ p.label }}</div>
                <div class="text-[11px] text-carbon-3">{{ p.sub }}</div>
              </div>
              <span
                v-if="isImpersonating && (session?.role === p.key || (p.key === 'finance' && session?.role === 'platform-admin'))"
                class="text-[10px] font-bold uppercase tracking-wider text-brand-harmony"
              >Current</span>
              <span
                v-else-if="switching === p.key"
                class="text-[10px] text-carbon-3"
              >…</span>
            </button>
            <div class="border-t border-calm-2 my-1" />
          </template>
          <NuxtLink
            to="/account"
            role="menuitem"
            data-testid="menu-account"
            class="block px-3 py-2 text-left text-[13px] font-bold text-carbon hover:bg-brand-harmony-sheer cursor-pointer transition-colors"
            @click="menuOpen = false"
          >
            My account · identities
          </NuxtLink>
          <div class="border-t border-calm-2 my-1" />
          <button
            v-if="isImpersonating"
            type="button"
            role="menuitem"
            data-testid="menu-stop-acting"
            class="w-full px-3 py-2 text-left text-[13px] font-bold text-brand-hunger hover:bg-brand-harmony-sheer cursor-pointer transition-colors"
            @click="stopActing"
          >
            Stop acting (back to {{ impersonatorEmail }})
          </button>
          <button
            v-else
            type="button"
            role="menuitem"
            data-testid="menu-sign-out"
            class="w-full px-3 py-2 text-left text-[13px] font-bold text-carbon hover:bg-brand-harmony-sheer cursor-pointer transition-colors"
            @click="signOut"
          >
            Sign out
          </button>
        </div>
      </div>
    </div>

    <nav
      v-if="navOpen"
      id="app-nav-mobile"
      aria-label="Main"
      class="md:hidden border-t border-calm-2 bg-white px-4 py-2 flex flex-col"
      data-testid="app-nav-mobile"
    >
      <template v-for="link in navLinks" :key="link.to">
        <span
          v-if="link.disabled"
          class="px-3 py-2.5 rounded-lg text-sm font-semibold text-carbon-3/50 cursor-not-allowed select-none"
          aria-disabled="true"
        >
          {{ link.label }} <span class="sr-only">(coming soon)</span>
        </span>
        <NuxtLink
          v-else
          :to="link.to"
          class="px-3 py-2.5 rounded-lg text-sm font-semibold hover:bg-brand-harmony-sheer hover:text-brand-harmony transition-colors"
          :class="isActive(link.to) ? 'bg-brand-harmony-sheer text-brand-harmony' : 'text-carbon-2'"
          :aria-current="isActive(link.to) ? 'page' : undefined"
          active-class=""
          exact-active-class=""
          @click="navOpen = false"
        >
          {{ link.label }}
        </NuxtLink>
      </template>
    </nav>
  </header>
</template>
