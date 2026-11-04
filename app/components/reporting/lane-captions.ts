/*
 * lane-captions — the reporting area's per-lens explainer sentences.
 *
 * WHY A MODULE. These sentences used to live inside LaneToggle, printed under
 * the control. They now render inside the reporting header's notes disclosure
 * instead (ReportHeaderNotes) — the control stays above the fold, the paragraph
 * explaining it does not. Two components therefore need the same two strings,
 * and a caption copied into the second one is a caption that will eventually
 * contradict the first.
 *
 * These are the EXACT sentences that were rendered before the move. Do not
 * reword them here to suit the new position: the caveats were relocated, not
 * rewritten, and each one was argued for where it was written.
 */
import type { ReportLane } from '../../composables/useReportState'
import { BU_LABEL } from '#shared/reports/vocabulary'

/*
 * Where a person's usage is counted (docs/design/current-org-lens/00-design.md
 * §3.5). Every report groups a person's usage by their CURRENT placement; the
 * Business Unit pages keep project-tagged usage on the project's unit; and the
 * figures a month was reported with live in finance's export, not here.
 */
export const PLACEMENT_NOTE =
  `Usage is grouped by where each person sits now. On ${BU_LABEL} pages, usage tagged to a project counts toward the project's ${BU_LABEL}. A reported month's own figures are finance's export.`

export const REPORT_LANE_CAPTIONS: Record<ReportLane, string> = {
  usage: 'Provider usage truth — what was consumed. Not an invoice; includes NFR/exempt.',
  /*
   * IT SAYS WHICH PART OF "cost-of-record" IT CANNOT DELIVER. Copilot raises ONE
   * pooled invoice per cost centre, so a per-person or per-model Copilot charge
   * does not exist — those breakdowns carry Anthropic's charge alone. Naming
   * only the pooling ("Copilot pooled per cost-centre") left a reader to infer
   * that every breakdown under this lens was still both providers.
   */
  chargeback:
    'Cost-of-record — what cross-charges to Business Units. Copilot bills one pooled invoice per Business Unit (pending validation), so per-person and per-model breakdowns are Anthropic’s charge alone.',
}
