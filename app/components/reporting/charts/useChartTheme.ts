/*
 * useChartTheme — the single source of brand colour + shared ECharts chrome for
 * the reporting chart kit (app/components/reporting/charts/**).
 *
 * WHY read CSS vars at runtime instead of importing hexes: the brand palette
 * lives in brand-tokens.css bound to Tailwind @theme (app/assets/css/main.css).
 * Reading `getComputedStyle(documentElement)` means a rebrand — or a future dark
 * theme that redefines the same custom properties — flows into every chart with
 * zero code change. NEVER hardcode a hex in a chart; always resolve the var.
 *
 * The resolvers touch a reactive `rev` tick so any `computed()` option that calls
 * them re-runs when the theme mutates (a MutationObserver on <html> bumps `rev`
 * when class / style / data-theme changes). On the client `document` is always
 * present, so resolution is synchronous with no first-paint flash; the small
 * fallback hexes only ever fire on the server (where the charts are ClientOnly
 * and never actually render) or if a token is genuinely missing.
 *
 * DATAVIZ note: the provider split (Claude = hunger #d40e8c, Copilot = vision
 * #5990f0) is validated — do not repaint those two. Rankings are MAGNITUDE, so
 * ranked bars use a single hue (magnitudeColor), never a categorical cycle.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { toolToVendor, type Vendor } from '#shared/usage/vendor'
import { VENDOR_LANE_COLORS } from '../../../composables/useChartScale'
import { FOLDED_LANE_ID } from './fold-lanes'

/** SSR-only last-resort values. The live client path always reads the CSS var;
 *  these exist so a server render / missing token degrades to something on-brand
 *  rather than an empty string. Every colour here must equal its brand-tokens.css value
 *  (tests/unit/reporting/chart-theme-fallback-tokens.test.ts checks it). */
export const FALLBACK: Record<string, string> = {
  '--brand-hunger': '#d40e8c',
  '--brand-vision': '#5990f0',
  '--brand-harmony': '#582873',
  '--brand-zeal': '#4ec7ea',
  '--brand-heart': '#b01c87',
  '--carbon': '#3e332d',
  '--carbon-2': '#5a4d45',
  '--carbon-3': '#6b6059',
  '--calm': '#e0e0e0',
  '--calm-2': '#ececec',
  '--paper': '#fafaf8',
  '--white': '#ffffff',
  '--rag-red': '#b91c1c',
  '--rag-amber': '#a14a07',
  '--rag-green': '#137336',
  // Vendor-lane tokens (brand-tokens.css §Chart vendor-lane colours) — SSR-only
  // last-resort mirrors, like every entry above. The live client path resolves
  // the CSS custom property (which aliases the brand token where one exists).
  '--lane-claude': '#d40e8c',
  '--lane-claude-ai': '#3368c4',
  '--lane-claude-cowork': '#bd014a',
  '--lane-claude-office': '#a977c8',
  '--lane-claude-chrome': '#fd4057',
  '--lane-claude-design': '#1398b8',
  '--lane-claude-slack': '#7e4d9b',
  '--lane-claude-other': '#8a7e76',
  '--lane-copilot': '#5990f0',
  '--lane-copilot-agent': '#aa1282',
  '--lane-copilot-license': '#2e5fb7',
  '--lane-copilot-usage': '#1699bb',
  '--lane-copilot-unclassified': '#5a4d45',
  '--lane-other': '#bdbdbd',
  '--font-sans': "'Manrope', Arial, system-ui, sans-serif",
  '--shadow-card': '0 4px 24px rgba(88, 40, 115, 0.08)',
}

export type RagState = 'ok' | 'warn' | 'over'

export interface ProviderColors {
  'claude-code': string
  'copilot-cli': string
  other: string
}

export function useChartTheme() {
  // Reactive tick — resolvers read it so option computeds recompute on theme change.
  const rev = ref(0)

  function readVar(name: string): string {
    // Establish a reactive dependency: when called inside a computed, that
    // computed re-runs on `rev` bump (theme toggle / rebrand).
    void rev.value
    if (typeof document !== 'undefined') {
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
      if (v) return v
    }
    return FALLBACK[name] ?? ''
  }

  /** Provider hues — DATAVIZ-validated split. Claude=hunger, Copilot=vision. */
  function providerColors(): ProviderColors {
    return {
      'claude-code': readVar('--brand-hunger'),
      'copilot-cli': readVar('--brand-vision'),
      other: readVar('--carbon-3'),
    }
  }

  /** A registry lane's FIXED colour: unwrap useChartScale's `var(--lane-…)`
   *  reference and resolve it live (theme-reactive via readVar). */
  function laneColor(lane: Vendor): string | null {
    const token = /^var\((--[\w-]+)\)$/.exec(VENDOR_LANE_COLORS[lane] ?? '')?.[1]
    if (!token) return null
    return readVar(token) || null
  }

  /** Resolve a colour for an arbitrary series/slice key — ONE system app-wide
   *  (lane-visuals V1 item 1). Resolution order:
   *    1. an EXACT registry lane id → its FIXED vendorLaneColor (colour follows
   *       the lane id, never its position);
   *    2. the folded-remainder pseudo-lane (`other-lanes`) → the neutral hue;
   *    3. a laned emit TOOL (`claude-code`, `copilot-cli`, `copilot-agent`, the
   *       #142 surfaces) → its OWNING lane's colour via the registry;
   *    4. provider-fuzzy fallback ONLY for non-lane keys (display names,
   *       models, regions), matching the way clientMeta() marks them;
   *    5. the neutral "other" hue. */
  function colorForKey(key: string): string {
    const p = providerColors()
    const k = (key || '').toLowerCase()
    // 1. Exact lane id (the registry is the source of truth).
    if (k in VENDOR_LANE_COLORS) return laneColor(k as Vendor) ?? p.other
    // 2. The kit's folded remainder — a deliberate neutral, never a brand hue.
    if (k === FOLDED_LANE_ID) return readVar('--carbon-3') || p.other
    // 3. A laned tool resolves through the registry to its lane's colour.
    const lane = toolToVendor(k)
    if (lane !== 'other') return laneColor(lane) ?? p.other
    // 4. Provider-fuzzy fallback for non-lane keys only.
    if (k.includes('claude')) return p['claude-code']
    if (k.includes('copilot')) return p['copilot-cli']
    return p.other
  }

  /** Single magnitude hue for ranked bars (rankings are magnitude, not identity). */
  function magnitudeColor(): string {
    return readVar('--brand-vision')
  }

  function ragColor(state: RagState): string {
    if (state === 'over') return readVar('--rag-red')
    if (state === 'warn') return readVar('--rag-amber')
    return readVar('--rag-green')
  }

  /** Shared ECharts chrome: recessive axes/grid, brand text, a tasteful white
   *  HTML tooltip. Charts spread this then add their series + tooltip trigger. */
  function baseOption(opts: { tooltipTrigger?: 'axis' | 'item' } = {}): ECOption {
    const carbon = readVar('--carbon')
    const calm = readVar('--calm')
    const calm2 = readVar('--calm-2')
    const white = readVar('--white') || '#ffffff'
    const font = readVar('--font-sans')
    const shadow = readVar('--shadow-card')
    const trigger = opts.tooltipTrigger ?? 'item'

    return {
      textStyle: { color: carbon, fontFamily: font },
      animationDuration: 400,
      aria: { enabled: true },
      grid: { top: 16, right: 16, bottom: 24, left: 16, containLabel: true },
      tooltip: {
        trigger,
        backgroundColor: white,
        borderColor: calm,
        borderWidth: 1,
        padding: [8, 12],
        textStyle: { color: carbon, fontFamily: font, fontSize: 12 },
        extraCssText: `box-shadow: ${shadow || '0 4px 24px rgba(88,40,115,0.10)'}; border-radius: 8px;`,
        ...(trigger === 'axis'
          ? { axisPointer: { type: 'line' as const, lineStyle: { color: calm2, width: 1 } } }
          : {}),
      },
    }
  }

  // Recompute on theme mutation so a dark/rebrand toggle repaints every chart.
  let observer: MutationObserver | null = null
  onMounted(() => {
    // First client tick — harmless if vars were already present.
    rev.value++
    if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
      observer = new MutationObserver(() => {
        rev.value++
      })
      observer.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ['class', 'style', 'data-theme'],
      })
    }
  })
  onBeforeUnmount(() => {
    observer?.disconnect()
    observer = null
  })

  return {
    rev,
    readVar,
    providerColors,
    colorForKey,
    magnitudeColor,
    ragColor,
    baseOption,
  }
}
