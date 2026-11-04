# Data Flow

**What this page is for.** It answers one question: *where does a dollar of
TokenScope spend come from, and what is it allowed to be used for?* Read it
before changing anything that touches money, and before designing any report
that puts two spend numbers on the same axis.

The companion page [Data Lineage](Data-Lineage.md) is the data-architect view:
every table, column, transformation and invariant. This page is the shape; that
page is the detail.

> **How to read it.** Claims carry a `file:line` or a dated observation. Where
> two canonical documents disagree, this page says so and names which wins.
> Claims that could not be closed from code are marked `[VERIFY]`.

---

## 1. The one principle

Everything on this page follows from a single fact, and most mistakes made
against this system are a variant of forgetting it:

> **The provider API states HOW MUCH was spent, for every teammate in a scope
> we have onboarded.**
> **OTel telemetry states WHOSE WORK it was, only where the plugin is enrolled.**
>
> They are not two spend feeds to be added together. One is truth; the other is
> detail.

**The API's completeness is scoped, not absolute.** It covers every teammate in
an org that is registered *and* set to `reconciliation_mode = 'reconciled'`. An
unregistered or `indicative` org yields **no rows at all** — and no row is not an
authoritative zero. The over-emission detector encodes exactly this caution:
`api_usd = 0` is treated as ambiguous between "org unreconciled" and "genuinely
zero", and is never flagged (`over-emission-detection.ts:173-179`). Zero
reconciled orgs is a clean no-op, not a report of zero spend
(`server/workers/registry.ts:148-152`).

Detected rows carry which lane found them, in `over_emission.reason` (mig 0132):
`api-uncorroborated` is the high-confidence lane — emitted spend materially above
a bill that *does* exist — and `no-bill-to-corroborate` is the weaker one, where
no bill has landed to compare against. Only the high-confidence lane reaches a
developer: every user-facing reader filters on it, so a `no-bill-to-corroborate`
row is counted and alertable without ever being shown to the person it concerns.

Two adjacent things are **not** the same as absence, and conflating them is its
own error:

- **A failed poll** writes no *fresh* rows but leaves earlier ones standing. The
  stale-row prune is reached only after every day in the window succeeds
  (`analytics-poller.ts:626-629`), so a partial failure never deletes what it
  could not re-assert. The figure you read may simply be older than you think —
  check `pulled_at`.
- **An unsettled day still has rows.** The current day is fetched and written
  like any other (`analytics-poller.ts:463-469`, `:616-623`); settling is
  *reporting metadata* (`server/reports/settling.ts:53-68`), not an ingestion
  filter. Recent figures are provisional and will move under the 31-day revision
  window, but they are present.

| | **Provider API** (Anthropic, GitHub) | **OTel telemetry** (TokenScope plugin) |
|---|---|---|
| Coverage | complete within an onboarded scope | enrolled devices only |
| Grain | day, no session | event: session, project, model |
| Answers | **how much** was spent | **whose work** it was |
| Becomes | the amount every figure reconciles to | the detail on that amount |

Both meet in the §A reconciliation, per (teammate, day, tool), and
`v_complete_usage` is the result: complete, and as detailed as the estate
allows (§3.2 draws it).

The API column carries money. The OTel column carries meaning. **A design that
sums the two is wrong**, and a chart that puts them side by side without
saying which is which is misleading.

### Why the coverage looks the way it does

Roughly **5% of the estate runs the TokenScope plugin**. That is the *designed*
state, not a shortfall to be closed — the plugin is opt-in and the API is the
permanent primary source for everyone else. A reporting axis built only from
OTel is therefore blank for 95% of spend **by construction**, and the fix is
never "chase enrolment"; it is "read the dimension the API already carries."

The model axis is the example. Anthropic reports cost at model grain. GitHub
reports AI-credit cost per day and model activity separately, so Copilot cost is
not named by model. The API lane reads what each provider sends: the hourly `provider-transform` worker stores it
in `provider_usage_fact` (migs 0118–0122), and `v_complete_usage` names a model
on every row the sources can name (mig 0124):

| rows | model comes from |
|---|---|
| arm 1 — OTel-emitted | the wire, per event |
| arm 2 — the API residual | the stored subtraction split: `unaccounted_usage_model` children, `cap(max(0, API_model − OTel_model))` per model, written with the parent (mig 0123) |
| arm 3 — ingest-only lanes | the provider's own `provider_usage_fact` cost rows for the same (teammate, day, tool) key |

What cannot be named is one **reason-typed remainder row** per key
(`model_gap_reason`: `provider-day-grain` — Copilot money carries no per-model
dollars; `awaiting-provider-detail` and `provider-revision-drift` — transient
fact-lane lag, self-healing; `unmodelled-provider-cost` / `surface-remainder` —
provider cost reported without a model). Remainders preserve the sum-back
(Σ per key = the day's total) and render as the Top-models card's coverage
footer, never as a category row.

---

## 2. The two axes — §A and §B

The system separates two concerns that look alike and are not, and the design
holds them apart explicitly.

| | **§A — usage completeness** | **§B — billing / chargeback** |
|---|---|---|
| Question | "Is my usage fully shown, and whose was it?" | "Who pays for this?" |
| Grain | teammate · day · tool | Business Unit · month |
| Anthropic source | `actual_spend` → `v_teammate_usage_daily` | `actual_spend`, per teammate |
| Copilot source | `reconciliation_record` | `copilot_pool_bill` |
| Uses OTel? | Yes — for the detail axis | **Never** |
| Surface | `v_complete_usage` | `v_finance_chargeback_month` |

**A §B fact never settles a §A question, and vice versa.** Copilot billing
being *pooled per Business Unit* (§B) says nothing about whether per-*user* usage
is available (§A — it is, and we already store it).

---

## 3. The generic model

### 3.1 Three ingest paths, not two

Three live paths write three different tables. Two further lanes are dormant
or non-monetary.

![Three provider-API paths cover every teammate in an onboarded scope; the OTel path covers enrolled devices only](images/data-flow-ingest-paths.svg)

1. Enrolled devices send `api_request` log events to `OTelLogs`.
   `azure-monitor-read` reads them with KQL every 5 minutes, joined on
   `tokenscope.instance_id`, and writes one `attribution_record` row per event
   and token type.
2. `analytics-poll` pulls Anthropic usage and cost reports at `bucket_width=1d`
   every 15 minutes, re-reading a trailing 30-day window, into `actual_spend`.
   The provider rows ride along verbatim in `actual_spend.raw_payload`.
3. `reconciliation-sync` reads GitHub's per-user `ai_credit/usage` hourly into
   `reconciliation_record`. It also reconciles Anthropic orgs into the same
   table, but only the GitHub rows feed §A usage.
4. The same run writes whole-month Copilot seat rows into `actual_spend`
   (`tool = 'copilot-cli'`). They are showback only and kept out of every §A
   and §B operand by tool name.
5. `copilot-pool-bill` reads the enterprise billing usage report daily into
   `copilot_pool_bill`, and writes `copilot_overage_allocation` in the same run.
6. `v_teammate_usage_daily` is the §A usage truth: Anthropic rows from
   `actual_spend` plus GitHub rows from `reconciliation_record`. It excludes the
   Copilot seat rows from step 4.
7. `provider-transform` derives the API lane, `provider_usage_fact`, hourly
   from `actual_spend.raw_payload` and `reconciliation_record.raw`. This is
   where the model dimension of API-reported money comes from.

*Every money table is written by a scheduled worker reading a provider; only
`attribution_record` depends on a device being enrolled.*

Two further lanes exist and are **not** shown because they are dormant or
non-monetary: the native-GenAI Copilot read (`server/azure/reader.ts:552-589`,
gated `NUXT_COPILOT_NATIVE_OTEL`, **default off** at `reader.ts:539-543`) and the behavioural
`usage_signal` lane into `usage_signal_record`
(`server/workers/azure-monitor-reader.ts:1689-1715`), whose values are gauges and
are **never summed as spend**.

### 3.2 The §A reconciliation

Both sides collapse to **(teammate, day, tool)** — and the reason is the single
most consequential provider limitation in the system:

> **Neither provider API carries a session identifier.** The day is therefore
> the finest grain at which API truth and OTel detail can be compared at all.
>
> In code: the OTel side is collapsed to the day by
> `GROUP BY ar.teammate_id, (ar.ts_event AT TIME ZONE 'UTC')::date, ar.tool`
> (`unaccounted-reconciliation.ts:119`), because the API side already arrives at
> that grain. The rationale is stated at `:14`.

![The API figure fixes the total for each teammate, day and tool; OTel fills in the detail, and the residual makes up the difference](images/data-flow-reconciliation.svg)

1. The API operand: `v_teammate_usage_daily` for the key, here $100. It has no
   session and no project.
2. The OTel operand: corroborated `attribution_record` rows for the same key,
   here $30. Both directions share this operand
   (`server/usage/corroborated-otel.ts`). It leaves out sessions in an open
   `api-uncorroborated` quarantine and self-billed rows (mig 0119).
3. API above OTel, the normal case: `usage-reconciliation` writes
   `unaccounted_usage` = max(0, API − OTel) = $70, a taggable worklist item,
   with its per-model `unaccounted_usage_model` children in the same
   transaction.
4. OTel above API: `over_emission` holds max(0, OTel − API). It flags only an
   excess above max($25, API) on a settled day, plus a weaker no-bill lane. It
   is an integrity signal and never spend.
   A developer resolves a flag by quarantining one conversation, but only if
   all of that conversation's records sit in the flag's (UTC day, tool) cell.
   The quarantine itself covers the whole conversation, so each
   `usage-reconciliation` run re-checks it. If the conversation later records
   usage outside the cell, the run lifts the quarantine and escalates the flag
   (`sweepStrayQuarantines` in `over-emission-detection.ts`). An escalated flag,
   whoever escalated it, goes to the Admins and any remaining Region admin of its region (Admins only
   when it has no region) as an
   `over-emission-escalated` item (`server/notifications/over-emission.ts`).
5. Arm 2 (`api-reconciled`) shows the residual, per model where the
   subtraction names one, otherwise as a reason-typed remainder row.
6. Arm 1 (`otel-emitted`) shows OTel rows directly, with session, project and
   model. It drops quarantined sessions but keeps self-billed rows, so a
   personal-subscription day sits above the API figure by exactly those rows.
7. Arm 3 (`provider-usage`) reads ingest-only tools straight from
   `v_teammate_usage_daily`. They never reach steps 3 and 4.

*Arm 2 is the API figure minus the OTel detail, so arms 1 and 2 add back to
the bill.*

**The invariant, stated precisely:**

> For a given (teammate, day, tool) **where OTel ≤ API**:
> `Σ arm 1 + arm 2 = the API figure`.
>
> Where **OTel > API**, arm 2 is clamped to zero by `GREATEST(0, …)` and arm 1
> alone exceeds the API figure. That case is not reconciled — it is *detected*,
> by `over_emission`. The clamp is deliberate: §A guarantees never
> under-counting, and an overshoot is the integrity lane's problem
> (the clamp is at `unaccounted-reconciliation.ts:121-124`; rationale at `:20-22`).

**How the residual carries a model without breaking conservation.** The
residual's per-model split is `max(0, API_m − OTel_m)` — a subtraction of two
observed operands — written as `unaccounted_usage_model` child rows in the same
transaction as the parent. Naive flooring alone would over-state: API model X
$10 / model Y $10 against OTel X $15 / Y $0 gives per-model floors summing to
$10 against a day residual of $5. The cross-model overshoot rule is a
**deterministic cap**: children are allocated in descending order, each taking
`min(floored, remaining)`, so `Σ children ≤ parent` always, and the view emits
any positive difference as one reason-typed remainder row. Never a ratio —
a named cell is an observed subtraction, possibly truncated, never inflated.

Tags survive recomputation. `project_id`, `activity`, `tagged_at`, `tagged_by`
and the dismissal columns are deliberately absent from the upsert's `SET` list
(`unaccounted-reconciliation.ts:129-134`), so a developer's tag persists while
its amount shrinks under them.

### 3.3 The third arm — ingest-only lanes

Eight tools never emit OTel at all (`INGEST_ONLY_USAGE_TOOLS`,
`shared/usage/surface.ts:111`): `copilot-agent` plus the seven non-Code Claude
surfaces. For these, `API − OTel` would equal the full amount every single day,
turning every dollar into a permanent untaggable worklist item
(excluded at `unaccounted-reconciliation.ts:98`; rationale at `:30-38`).

So they are excluded from arms 1 and 2, and are the *only* members of arm 3.
The three arms are **structurally disjoint** — arms 1 and 2 exclude exactly the
set arm 3 includes — so no data anomaly can land one tool in two arms
(`drizzle/migrations/0101_…sql:198-201`).

Arm 3 rows carry `project_id` and `activity` as NULL **by construction**: the
lane is untaggable, so no activity axis exists for that money. That is a
structural absence, not a bookkeeping gap, and readers must render it as a
named bucket rather than as zero or as "untagged"
(`drizzle/migrations/0113_complete_usage_activity.sql:17-22`).

### 3.4 §B — chargeback

Chargeback never reads OTel. The two providers bill differently and are charged
differently, and this asymmetry is the whole content of §B:

![Anthropic is charged per teammate to their Business Unit; Copilot is charged per org pool to Business Units, never to a person](images/data-flow-chargeback.svg)

1. `v_finance_bill_chargeback` reads Anthropic `actual_spend`, drops
   `chargeback_exempt` rows, and homes each row to the nearest cost-owning
   ancestor of the teammate's placement.
2. Copilot seat rows in `actual_spend` never enter: every Copilot tool is
   excluded by name.
3. Anthropic rows reach `v_finance_chargeback_month` rolled up to the month.
4. `copilot_pool_bill` splits into three lanes in
   `v_finance_copilot_pool_chargeback`. `copilot-license` is homed to the org's
   Business Unit. `copilot-usage` follows `copilot_overage_allocation`, which
   splits the overage by seat-holders' usage, and falls back to the org's
   Business Unit until an allocation exists (a `WHERE NOT EXISTS` keeps the two
   exclusive).
5. The licence and usage lanes are the Copilot charge, at Business Unit, tool
   and month grain, with no person column.
6. `copilot-unclassified` is carried in the view so it stays visible, and every
   chargeable total excludes it.

*The asymmetry comes from the bills: Anthropic invoices per user, GitHub
invoices a pool.*

Three consequences that are enforced, not conventional:

- **Copilot `actual_spend` rows are showback-only.** The `copilot-cli` flat-seat
  rows are firewalled out of every chargeback view *by name*
  (`drizzle/migrations/0085_…sql:62`, `:114`, `:135`). A reader who assumes
  Copilot charges flow through `actual_spend` will be wrong.
- **§B money is READ, never priced.** Net/gross/discount come straight off the
  bill (`server/workers/copilot-pool-bill.ts:141-179`). `seats × rate` does
  not reproduce the invoice: it is 27% off a live one
  (`provider-billing-attribution-model.md:164-173`).
- **No double charge is structural.** The pool view charges either the
  allocation *or* the org-homed figure, made mutually exclusive by a
  `WHERE NOT EXISTS` (`drizzle/migrations/0107_…sql:44-47`).

---

## 4. How money is valued — and the rate card's real job

The two canonical documents contradict each other on this point. This section
resolves it.

**The cost-precedence ladder** (`server/usage/span-costing.ts:209-225`):

| rung | fires when | effect |
|---|---|---|
| 1 `provider` | the provider sent a usable cost | the provider figure **is** the span total |
| 2 `rate-card` | provider cost missing, zero, negative or unstorable | our card prices each row — **and raises an alert** (`azure-monitor-reader.ts:1750-1756`) |
| 3 `skip` | neither | the span is not written at all |

**On the reference deployment, a 7-day sample (2026-08-01) had 21,839 spans
provider-priced and 0 rate-card-priced.** That is one environment, **not** proof
that rung 2 is dead. Rung 2 is live code: it fires for missing, zero and
negative provider cost (`tests/integration/azure/joiner-provider-cost.test.ts:330-380`)
and for an unstorable one (`:793-842`). Any decision that depends on rung 2 being
rare needs production-wide rung counts, not this sample.

### The conflict, and which document wins

- The billing-attribution design and
  `server/usage/over-emission-detection.ts:11-23` both describe
  `attribution_record` as the *"OTel rate-carded estimate"*, a different money
  basis from the bill.
- The cost-precedence design and the live evidence say the amounts are
  provider-priced.

**The precedence design plus the evidence wins** on the common case. But "rate-carded"
and "provider-priced" are both too absolute, because the card plays **three
different roles depending on the rung**:

| situation | what the card does |
|---|---|
| provider cost present, and every row has a **positive** card weight | **weights the split** — the provider total is divided in proportion to those weights |
| provider cost present, but the weights are unusable — any row unpriceable, any negative weight, or a total weight of zero | **nothing** — no split is defensible, so the whole total lands on one deterministic carrier row (`span-costing.ts:258-273`, `:434-462`) |
| provider cost missing, zero, negative or unstorable (**rung 2**) | **sets the amount** — each *priceable* row keeps its own card estimate, rows the card cannot price are **skipped entirely**, and an alert fires (`span-costing.ts:394-407`, `azure-monitor-reader.ts:1360-1367`, `:1750-1756`) |

The mechanics behind role 1: one `api_request` span fans out to up to four
token-type rows, but the provider sends **one** cost for the whole span. The
total is therefore taken as `MAX` per span, never `SUM`
(`azure-monitor-reader.ts:1119-1126`) — summing would multiply it up to 4× — then
allocated by largest-remainder so the parts sum to the whole exactly
(`span-costing.ts:429-468`, `:262-308`).

`rate_card_id` is pinned **only** when the card decided the *amount*, which makes
`rate_card_id IS NULL` the reliable "not card-priced" marker for `claude-code`.
Pinned on rung 2 and NULL on provider-priced, both asserted at
`tests/integration/azure/joiner-provider-cost.test.ts:230`, `:360`, `:440`.

| token-type row | rate-card weight share | allocated |
|---|---|---|
| input | 25% | $0.10 |
| output | 60% | $0.24 |
| cache-read | 10% | $0.04 |
| cache-write | 5% | $0.02 |
| **span total** | | **$0.40**, the provider's own figure |

An illustrative span: the provider sends $0.40 for one `api_request`, taken
once per span as `MAX`, never `SUM`
(`server/workers/azure-monitor-reader.ts:1517-1525`). The rate card supplies
only the weights. The split is largest-remainder in integer micro-dollars, so
the rows add back to the provider total exactly, whatever order they arrive in.

If **any** token type has no rate line, no split is defensible, so the whole
provider total lands on one deterministic carrier row rather than being guessed
(`span-costing.ts:434-462`).

### Two consequences

1. **The over-emission threshold stays at 2× (owner-settled).**
   `over-emission-detection.ts:11-23` justifies the 2× band plus a $25 floor as
   absorbing "honest rate-card drift", on the premise that OTel is an estimate
   and the API is a bill. That premise does not hold, but the **threshold is
   still right, for a different reason**: the alarm is an informational
   "something looks off" signal, not an integrity control, *because OTel is
   never billed*. The API is the bill; OTel is project direction and indicative.
   A loose threshold on an advisory signal is correct.
   Note also that the two figures do **not** share a basis even on the common
   rung: OTel cost is the client-emitted per-event `Attributes['cost_usd']`
   (`server/azure/reader.ts:476`), while the API figure is aggregated from
   cost-report rows (`analytics-poller.ts:568-613`). Different provider surfaces,
   free to differ on rounding, timing and inclusion. **Do not "tighten" this
   threshold as a correctness fix.**
2. **A stale rate card silently skews the token-type split.** The card is
   flagged stale and measured ~36% off. When it prices nothing it still acts as
   the *weight vector* deciding how each span's exact total is distributed across
   input/output/cache rows — so span totals stay correct while the per-token-type
   breakdown drifts. The same card also feeds rate-derived estimates in
   `server/usage/insights.ts:225-254` and `:319-349` (loaded by `fetchRateLines`,
   `:676-690`).
   **The owner's decision: refresh the card and keep the savings advice on.**
   Refreshing fixes both consumers at once — the nudges become accurate and
   the token-type split stops drifting. **Open — issue #42.**

### The personal-subscription false positive

A teammate on a personal or team Claude subscription emits OTel that never
appears in the enterprise API, because the billing email differs. They are
protected: `api_usd = 0` and the material lane requires `api_usd > 0`
(`over-emission-detection.ts:177`). A declaration additionally suppresses the
lower-confidence no-bill lane (`:199-203`).

**One case is not protected, deliberately.** A teammate with *both* enterprise
spend and a personal subscription on the same enrolled device has `api_usd > 0`,
while their OTel carries both sources — so the material lane can fire, and the
personal declaration explicitly does not waive it (*"a REAL bill mismatch is
never waived by a personal declaration"*, `:194`). Accepted as-is: the signal is
advisory and costs nobody money.

**Copilot never uses a rate card at all.** Its cost is `nano_aiu × 1e-11` at a
fixed $0.01/credit (`azure-monitor-reader.ts:294`, `:317-332`). No Copilot
rate card exists (`drizzle/migrations/0037_…sql` removes the seeded one).

---

## 5. Reference deployment (example)

Everything above is the generic model. This is how the reference deployment is
configured; a deployment's own provider plans and credentials may differ.

### Anthropic

| | |
|---|---|
| Plan | **Usage-based.** Seat-based plans cannot be purchased. |
| API kind | **`enterprise-analytics`** — *not* `claude-code-admin` |
| Branch | `server/workers/analytics-poller.ts:810`, on `provider_org.api_kind` |
| Endpoints | `/v1/organizations/analytics/user_usage_report` and `…/user_cost_report` |
| Grain requested | `bucket_width=1d`; `group_by[]` = `[product, model, context_window]` for usage, `[product, model, cost_type, context_window]` for cost |
| Window | trailing **31 days inclusive** — `[now−30d, now]`, `server/workers/registry.ts:132-141`. **Not** month-start. |
| Cadence | `*/15 * * * *` |
| Credential | `x-api-key` from Key Vault, per `provider_org.credential_secret_name` |
| Raw capture | **yes** — mig 0117, pre-Zod page bodies |

The `claude-code-admin` path (`server/anthropic/client.ts`) is **dormant here**.
It is a different endpoint with no `group_by`, no `bucket_width`, a hardcoded
`tool='claude-code'` and no raw capture. Evidence drawn from it does not
describe production.

The two `group_by` arrays differ in exactly one member, deliberately:
`cost_type` exists only on cost rows, so sending it to the usage report would
fragment rows on an unreadable dimension against the page ceiling. Requesting it
on the cost report is what makes the `web_search` / `code_execution` exclusion
**reachable at all** — the filter reads a field that is otherwise never
populated. `context_window` goes on **both** reports or neither: the two reports
are at different grains, and a dimension on one side only makes the join harder.
`speed` is the other dimension the same rule names and is deliberately not
requested — no surface needs it, and every added dimension multiplies rows
against the page ceiling.

### GitHub Copilot

| | |
|---|---|
| Target mode | **App mode** (preferred) |
| App read | `GET /enterprises/{ent}/copilot/metrics/reports/users-1-day?day=` → signed NDJSON `download_links[]`, fetched **with no `Authorization` header** (a bearer breaks the signature) |
| PAT read | `GET /enterprises/{ent}/settings/billing/ai_credit/usage?user=…` — carries full SKU/gross/discount/net |
| §B bill | `GET /enterprises/{ent}/settings/billing/usage?year=&month=` |
| Rate | $0.01 per AI credit |
| Raw capture | **no** — no GitHub writer exists |

**Which mode a deployment runs** is decided per enterprise by
`provider_enterprise.github_app_id` being non-NULL
(`server/reconciliation/credentials.ts:216-245`), which is set through the admin
UI, not by seed or env.

The modes are **not** interchangeable, and the difference is load-bearing:

| | PAT | App |
|---|---|---|
| Per-user billing detail | ✅ full SKU array, USD, gross/discount/net | ❌ 403, GitHub-acknowledged |
| Per-user usage | ✅ | ✅ credits only |
| Category split | per SKU → `copilot_interactive` / `copilot_coding_agent` | one `copilot_interactive` line only |
| Verdict grain | per license org | **one verdict for the whole enterprise** — a mixed enterprise cannot be split (`legacy-chargeback-heuristic.ts:122-128`) |

Every classic PAT scope that reaches `ai_credit/usage` is mutate-capable
(`manage_billing` / `admin:enterprise`) — there is no read-only billing scope.

### Enrolment

The plugin ships via a server-managed marketplace; `provision_emit` mints the
instance. Enrolment is effectively **per-host**: the credential lives in
`~/.claude/settings.json`, so every container sharing a home directory on one
host emits the same `tokenscope.instance_id`.

---

## 6. Failure modes

What each hop does when it breaks, and what a reader sees as a result.

| hop | failure | behaviour | visible as |
|---|---|---|---|
| LAW → joiner | event lands late | absorbed only within a **5-minute** watermark overlap; older events wait for the daily `telemetry-recovery` pass or an operator recovery | spend appears hours late, then reconciles |
| Joiner | no rate line for any token type | whole span total lands on one carrier row | token-type split distorted; total correct |
| Joiner | rung 3 — no provider cost, no card | **span not written at all** | usage silently missing from OTel; the API residual absorbs it |
| Joiner | membership gate fails | row **is** written, `project_id` NULL | spend appears as unallocated, never lost |
| Poller | one org's fetch throws | per-org catch; other orgs unaffected | that org writes **no rows this cycle** |
| Poller | Zod parse fails on a report | same per-org catch → "poll failed" | deterministic outage for that org until fixed |
| Poller prune | >50% of rows fail identity binding | prune skipped, warning logged | stale rows survive rather than money being deleted |
| Poller prune | any day in the window throws | prune never runs | partial pull can never delete rows it did not re-assert |
| Copilot report | `download_links` empty on a 200 | **fail loud** — treated as a retryable gap | never recorded as an authoritative zero |
| Copilot bill | `netAmount` absent or renamed | **throws** — no `.default(0)` | never silently coerced to $0 |
| Seat prune | roster empty, short page, or page cap hit | prune skipped | stale seat rows survive |

The recurring shape: **every guard fails toward keeping stale data rather than
deleting real money**, and every "authoritative zero" is treated as a bug until
proven otherwise.

---

## 7. What the providers cannot give us — and the standing obligation

**This section has a shelf life.** Each row carries the date it was last
verified.

| limitation | consequence | verified |
|---|---|---|
| No session identifier on either API | §A reconciles at day grain; the residual is untaggable to a conversation | 2026-08-02 |
| Anthropic cost report has no token columns; usage report has no cost | the two reports must be read separately and cannot be joined per row | 2026-08-02 |
| Copilot App mode returns credits only, no USD, no SKU | §B cannot be derived from the metrics report | 2026-06-30 |
| Copilot App mode cannot read per-user *billing* | 403, GitHub-acknowledged (community #184208) | 2026-06-30 |
| Copilot App mode cannot read `consumed-licenses` | identity resolves via org SAML `externalIdentities` instead | 2026-07-02 |

> ### Standing obligation — re-check the provider API specs
>
> **Every limitation above is a fact about a provider's API on a date, not a law
> of nature.** These specs move. If Anthropic or GitHub adds a session
> breakdown, a `session_id` group-by, or per-user billing to an App
> installation, the day-grain compromise in §3.2 stops being necessary and
> several designs built around it should be revisited.
>
> **Our wire-shape probe cannot detect this.** It reports new *fields on
> responses we already request*. It cannot see a new *capability* we do not ask
> for — a `group_by` value we never send is invisible to it. Detecting these
> needs someone reading the changelogs.
>
> Re-read both providers' API references at least quarterly, and whenever a
> reconciliation design decision leans on "the API cannot do X". Record the date
> and the finding here. Tracked as issue **#43**.

---

## 8. Known gaps

Real and current. Listed so they are not rediscovered as surprises.

1. **The over-emission threshold and the stale rate card** — §4, issue #42.
2. **Copilot has no raw capture.** Mig 0117 covers Anthropic only.
3. **`is_frozen` enforces nothing.** Written `true` on every
   `attribution_record` row and read nowhere; no trigger, CHECK or policy makes
   the row immutable.
4. **§A residuals are not frozen by a reporting snapshot.** Reconciliation
   recomputes `unaccounted_usage` over its trailing 35-day window on every run,
   including days before a recorded month boundary, so a residual in a recorded
   month can change after the snapshot.

---

## See also

- [Data Lineage](Data-Lineage.md) — tables, columns, transformations, invariants
- [Data Model](Data-Model.md) — schema reference *(some money-path tables are
  not documented there yet; Data Lineage lists them)*
- [Reporting](Reporting.md) — what reads these surfaces
