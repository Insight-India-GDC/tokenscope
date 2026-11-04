<script setup lang="ts">
/*
 * Sign-in page.
 *
 * Per docs/archive/ux-pilot/tokenscope-pilot-design/project/design-notes.md §Screen 1: two-column
 * split. Left = brand hero with slogan-style headline; right = the
 * sign-in panel — Microsoft (Entra OIDC) button + a 2x2 demo persona
 * grid. Demo grid stays in pilot builds (cleanly removable for prod).
 *
 * Wave-V — Entra button is live when oidc is enabled (i.e. NOT
 * NUXT_OIDC_AUTH_DEV_MODE). Click invokes nuxt-oidc-auth's
 * useOidcAuth().login('entra'). On bootstrap-class JIT failure, the
 * `auth-jit-error` cookie carries the operator-visible cause; we read
 * + clear it here and display it inline. NO auto-redirect to Entra
 * (manual click only) so a failing JIT bridge can't bounce the user
 * into an infinite Entra loop.
 */
import { computed, ref } from 'vue'

definePageMeta({ layout: false })

const { devLogin } = useSession()
const route = useRoute()
const config = useRuntimeConfig()
const isDevMode = computed(() => Boolean(config.public.authDevMode))
// Pre-Entra demo persona grid is LOCAL-ONLY (the shared classifier) — never on
// sandbox (which switches personas post-Entra via the AppHeader) and never on a
// pilot-prod surface. localOnly is the single source of truth for that decision.
const { localOnly } = useDemoFeatures()
const error = ref<string | null>(null)
const busy = ref<string | null>(null)

// Bootstrap-error cookie set by server/plugins/oidc-jit-teammate.ts when
// the JIT bridge hits a PERMANENT failure (missing region / org_unit /
// migration). Display once and clear so a subsequent successful sign-in
// doesn't keep showing the stale message. Defaults to null in dev-mode.
const jitErrorCookie = useCookie<string | null>('auth-jit-error')
const jitError = ref<string | null>(jitErrorCookie.value ?? null)
if (jitErrorCookie.value) jitErrorCookie.value = null

const personas = [
  { key: 'developer', label: 'Sign in as Developer', sub: 'Priya Iyer · Services APAC' },
  { key: 'manager', label: 'Sign in as Manager', sub: 'Anil Verma · Practice lead' },
  { key: 'admin', label: 'Sign in as Region admin', sub: 'Lena Park · APAC' },
  { key: 'finance', label: 'Sign in as Global finance', sub: 'Mara Holloway · cross-region finance' },
  // J3 (mig 0048): developer ROLE with cou_owner rows — demos that the
  // P&L view flows from the ownership relationship, not the role enum.
  { key: 'cc-owner', label: 'Sign in as Business Unit owner', sub: 'Owen Cole · owns Delta + Echo' },
]

async function signIn(persona: string) {
  busy.value = persona
  error.value = null
  try {
    const result = await devLogin(persona)
    const next = (route.query.next as string | undefined) ?? result?.landing ?? '/'
    await navigateTo(next)
  } catch (err) {
    error.value = err instanceof Error ? err.message : 'Sign-in failed'
  } finally {
    busy.value = null
  }
}

function signInWithEntra() {
  // Navigate to nuxt-oidc-auth's provider login route directly rather than
  // importing useOidcAuth from #imports: the OIDC module is disabled in
  // dev mode (nuxt.config `enabled: !devMode`), so that auto-import does
  // not exist and a static import 500s the whole dev app at transform.
  // The button is disabled in dev anyway; in sandbox/prod this route is
  // the module's login handler (mirrors the /auth/entra/logout path used
  // by useSession().logout).
  if (isDevMode.value || !import.meta.client) return
  busy.value = 'entra'
  error.value = null
  window.location.href = '/auth/entra/login'
}
</script>

<template>
  <div class="grid min-h-screen grid-cols-1 lg:grid-cols-[1.1fr_1fr]">
    <!-- Brand hero -->
    <aside
      class="relative hidden lg:flex flex-col justify-between px-16 py-16 text-white overflow-hidden"
      style="
        background:
          radial-gradient(circle at 100% 0%, rgba(212, 14, 140, 0.24), transparent 60%),
          radial-gradient(circle at 0% 100%, rgba(89, 144, 240, 0.22), transparent 55%),
          radial-gradient(circle at 50% 50%, rgba(78, 199, 234, 0.12), transparent 60%),
          var(--brand-harmony);
      "
    >
      <div>
        <UiEyebrow class="text-white/80">TokenScope · Pilot</UiEyebrow>
        <h1 class="mt-4 text-5xl font-bold tracking-tight leading-[1.05] max-w-lg">
          Track every token.<br>Trust the developer.
        </h1>
        <p class="font-slab italic text-lg mt-5 text-white/85 max-w-md leading-snug">
          The budget does the teaching — TokenScope tracks the work and lets
          you steer it.
        </p>
      </div>
      <!-- What this instance actually is, fetched not typed. The literal that
           used to sit here ("APAC · v0.1.0 · MVP-Lite first slice") was wrong
           on every field: dev is a global instance, not APAC; the version had
           moved; the slice was long finished. -->
      <div class="text-[11px] text-white/70">
        <UiBuildStamp />
      </div>
    </aside>

    <!-- Sign-in panel (Epic 14 polish — tighter spacing per hi-fi) -->
    <section class="flex items-center justify-center px-8 py-12 bg-paper">
      <div class="w-full max-w-md">
        <div class="mb-8">
          <UiEyebrow>Welcome back</UiEyebrow>
          <h2 class="text-3xl font-bold tracking-tight text-carbon mt-2">Sign in to TokenScope</h2>
          <p class="text-sm text-carbon-2 mt-2 leading-relaxed">
            TokenScope uses your Insight Microsoft account.
          </p>
        </div>

        <p
          v-if="jitError"
          data-testid="jit-error-banner"
          class="mb-4 rounded-lg border border-rag-red/30 bg-rag-red/5 p-3 text-sm text-rag-red"
        >
          <span class="block font-bold">Sign-in setup incomplete</span>
          <span class="block mt-0.5 leading-snug">{{ jitError }}</span>
          <span class="block mt-1 text-[11px] text-carbon-3">
            The operator needs to fix the underlying bootstrap before sign-in can succeed.
            Contact the TokenScope deploy owner.
          </span>
        </p>

        <UiButton
          kind="primary"
          size="lg"
          class="w-full justify-center"
          :disabled="isDevMode || busy !== null"
          data-testid="signin-microsoft"
          @click="signInWithEntra"
        >
          <span v-if="isDevMode" class="font-mono text-xs mr-2">[Local dev]</span>
          Sign in with Microsoft
        </UiButton>

        <!-- Demo personas: ONLY shown in local-dev mode. In sandbox/prod
             real Entra is the sole entry point; clicking a persona before
             Entra sign-in trips the triple-gate's 401 (no caller session).
             Persona-switching post-sign-in lives in the AppHeader menu. -->
        <div
          v-if="localOnly"
          class="mt-8 mb-3 flex items-center gap-4 text-xs uppercase tracking-[1.4px] text-carbon-3"
        >
          <div class="flex-1 h-px bg-calm-2" />
          <span>or jump in as (demo)</span>
          <div class="flex-1 h-px bg-calm-2" />
        </div>

        <div v-if="localOnly" class="grid grid-cols-2 gap-2.5">
          <button
            v-for="p in personas"
            :key="p.key"
            type="button"
            class="text-left p-3 rounded-xl border border-calm bg-white hover:border-brand-harmony hover:bg-brand-harmony-sheer transition-colors disabled:opacity-50"
            :disabled="busy !== null"
            :data-testid="`persona-${p.key}`"
            @click="signIn(p.key)"
          >
            <div class="text-sm font-bold text-carbon">{{ p.label }}</div>
            <div class="text-[11px] text-carbon-3 mt-1">{{ p.sub }}</div>
          </button>
        </div>

        <p v-if="error" class="mt-5 text-sm text-rag-red">{{ error }}</p>

        <p class="mt-8 text-[11px] text-carbon-3 leading-relaxed">
          By signing in you agree to use TokenScope per the responsible-use
          guidelines. We never block your AI tools: going over budget raises an
          item in your TokenScope inbox, not a hard stop.
        </p>
      </div>
    </section>
  </div>
</template>
