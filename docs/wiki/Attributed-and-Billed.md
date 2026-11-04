# Attributed and Billed — the trust model

TokenScope shows two kinds of figure. **Billed** figures are money: their
amounts come only from the provider's own usage and billing data. **Attributed**
figures are indicative: they add the detail only a developer's device can
report (which session, which project, which activity), and no amount is ever
charged from them.

This page says where each comes from, what a developer can and cannot change,
where indicative data touches money, and what checks exist. The mechanics are
in [Data Flow §2](Data-Flow.md#2-the-two-axes--a-and-b) and
[Data Lineage](Data-Lineage.md).

---

## 1. The two lanes

| | **Attributed** (§A, "show me") | **Billed** (§B, "charge me") |
|---|---|---|
| Answers | What did I, my project, my unit use, and on what? | What does each Business Unit pay? |
| Comes from | Device telemetry (OpenTelemetry, per session), topped up from the provider's per-person daily total where the provider reports more (§3) | The provider's usage and billing APIs only |
| Device telemetry used for the amount? | Yes | **Never** |
| Device telemetry used for the split? | — | Anthropic: yes, it weights how a person's bill is split across projects (§2). Copilot: no, its bill is pooled per GitHub organisation and never split |
| Who relies on it | Developers, project managers, Business Unit owners (showback, budgets) | Finance (chargeback) |
| Labelled | "estimated" / "indicative" where it is not a billed charge | "estimated" while the period is open, then "settling" and "settled" on each provider's horizon |

Budgets and allocations are reporting only. TokenScope enforces no quota and
blocks nothing.

### Where the provider data comes from

| Provider | Per-person usage | The bill |
|---|---|---|
| Anthropic (Claude Enterprise / Claude Code analytics) | Per person per UTC day, by email | Per person; charged to the person's Business Unit |
| GitHub Copilot | Per person per UTC day (`ai_credit` usage), shown as usage | Pooled per GitHub organisation; charged to the unit that organisation maps to, never split per person |

Device figures are priced from what the client reports (Claude's own span
cost, a rate card where it reports none, Copilot AI credits), so they differ
from the bill even for honest usage.

---

## 2. What a developer controls, and what they cannot

A developer's device emits their own telemetry, so they control what it
reports.

| A developer **can** | A developer **cannot** |
|---|---|
| Report more or less usage than they had | Change any billed total: billed amounts come from the provider |
| Tag their sessions to a project they are a member of | Tag to a project they are not a member of: the tag is checked against membership at join, refused and audited |
| Leave usage untagged | Change which Business Unit pays: an Anthropic bill is charged to the unit the person is placed in, a Copilot bill to the unit its GitHub organisation maps to |
| Accept, quarantine or escalate their own reconciliation flags | |

**Emitting as someone else.** Every record carries a device id, and the server
attributes it to that device's enrolled owner. A device credential is broadly
readable on the machine it is installed on, so a record claiming another
person's device is possible. It is checked only partly (heartbeat coverage,
§4), and not at all if the credential itself was stolen. Such records reach
attributed figures; their amount never reaches billed totals.

### Where indicative data touches money

The **project chargeback split** divides a person's billed cost for a day and
tool across projects by the dollar weight of that person's attributed usage:
their tagged sessions, their tagged unaccounted usage (§3), and an untagged
remainder that stays on their unit. So inflated, mis-tagged or spoofed
telemetry in that person's cell can change **which projects carry that
person's billed cost**. It cannot change the amount, and it can only reach
projects the record's owner is a member of.

Telemetry also feeds attributed reporting and budget signals directly. Those
are indicative, but the project split is where it moves billed money between
projects, which affects a project's reported margin.

---

## 3. Reconciliation: comparing the two lanes

The `usage-reconciliation` worker compares each person's telemetry with the
provider's figure, per (person, UTC day, tool), every two hours over a trailing
35 days, for Claude Code and Copilot.

- **Provider figure above telemetry** (under-reported, or usage from a device
  that was never enrolled): the difference becomes an **unaccounted usage**
  record for that day, in the developer's needs-tagging list. Until tagged it
  counts on their unit as unallocated. Within that window the person's
  attributed total is therefore not below the provider's figure.
- **Telemetry far above the provider figure** (over-reported): a day is flagged
  when telemetry exceeds the provider figure by more than the greater of $25
  and the provider figure itself (so it is more than double the provider
  figure and more than $25 over it), on settled days only (the most recent days are still filling at the
  provider). The flag appears in the developer's review list (it is not an
  inbox notice). They **quarantine** a session (it leaves attributed figures and
  the project split), **accept** it (they vouch for it), or **escalate** it.
- **Telemetry with no provider figure at all** gets no review flag. Large
  amounts (over $250 on a settled day) are recorded as a separate,
  lower-confidence signal, and the developer is asked whether the tool is
  personally paid for.

---

## 4. The checks, and who sees them

| Check | What it catches | Who sees it |
|---|---|---|
| Project membership | A tag naming a project the person is not on | Refused at join and audited; the spend lands untagged |
| Heartbeat coverage | Recent Claude Code records whose session falls outside the device's live window: from its enrolment to its latest ingest-token fetch (`/bearer`, authenticated by the device credential), with about 35 minutes' grace at each end. It does not need a fetch near each record, so a spoofed record inside a live device's window passes. It does not cover Copilot, devices that never fetched a token, or a stolen credential, whose fetches look like the owner's | The device owner, as quarantined spend, plus an audit event |
| Over-reporting flag (§3) | Telemetry more than double the provider figure and more than $25 over it | The developer, in their review list. **Escalated** flags reach the Admins, and any remaining Region admin of the person's region, as an inbox notice. A quarantine is also lifted and escalated automatically when the quarantined conversation has records outside the flagged day and tool |
| Unaccounted usage (§3) | Under-reported or unenrolled usage | The developer's needs-tagging list; Business Unit owners see current members whose unallocated spend over the period reaches the soft cap |
| Attribution gap | A device that has been attributed before and still fetches ingest tokens (`/bearer`), but whose last attributed record is more than 72 hours older than its latest fetch. A fetch is not proof of spend or of a person signing in, so an idle device can show up too. A device that has never been attributed is not covered: it looks the same as one that has not spent yet | Admins |
| Audit log | Every accept, quarantine, escalate, tag and dismiss, with who and when | Admins at `/admin/audit`. Region admins see events whose actor or subject teammate is in their region, which leaves out system-authored flag events |

---

## 5. Shared and pooled credentials

The per-person comparison needs a per-person provider figure. Two cases do not
have one.

- **A shared Anthropic API key.** The provider reports API-key usage per key,
  not per person, so TokenScope does not attribute that bill to anyone and it is
  not in billed figures. Telemetry a developer sends while using such a key
  still lands in their attributed figures under their own person, day and tool.
  If that person also has billed usage for the same day and tool, the
  telemetry adds weight to how that bill is split across projects (§2).
- **GitHub Copilot.** Per-person usage exists and is compared. The bill is
  pooled per organisation and charged per unit, never split per person.

---

## 6. The three questions reviewers ask

**Can a developer inflate or deflate their own figures?** Yes, in attributed
figures, because they control their device's telemetry. No, in billed totals.
Inflated or mis-tagged telemetry can change which of their projects carries
their billed cost (§2). Deflating works differently by lane. Where there is a
per-person provider figure (Claude Code, Copilot), reconciliation tops the
attributed total back up to it as unaccounted usage within the reconciliation
window (§3), so a developer can
strip session and project detail but not lower the total. Where there is none
(a shared key, other uncovered lanes), deflated telemetry simply lowers the
attributed figures.

**When figures disagree, who finds out?** The developer first: over-reporting
flags are in their review list and unaccounted usage in their needs-tagging
list. Admins are notified when a flag is escalated, by the developer or
automatically (§4). Every resolution is in the audit log. Project managers and
Business Unit owners see unallocated and untagged spend in their reports, not the flags.

**Does usage on a shared credential escape the checks?** There is no per-person
provider figure to check it against (§5). It shows as attributed, and its
shared-key bill is not in billed figures.

---

## 7. Known limitations

1. **Nobody but the developer is told about a flag they ignore or accept.** A
   flag has no time limit and is not escalated on its own, except in the
   quarantine case in §4. An accepted flag is visible only in the audit log.
2. **No admin view lists open or accepted over-reporting flags.** The escalation
   notice is the only admin-facing signal.
3. **Project managers and Business Unit owners are not notified** of flags on sessions
   tagged to their projects, including when the flagged telemetry changes the
   project split of billed cost.
4. **Records claiming another person's device are only partly detected** (§2,
   §4).
5. **Attributed figures are not badged per person as "unverified"** when there
   is no provider figure to compare them with (§5). Report labels say a figure is
   estimated or indicative, not that one person's figures were never reconciled.
6. **Provider records that name no person are counted, not shown.** The poller
   counts records it cannot bind to a person, shared-key usage among them; no
   admin page shows the count. Records whose email is not yet known are queued
   and placed later.
7. **A device that stops sending entirely raises no admin alert.** Its owner's
   provider usage still appears in full as unaccounted usage, in the developer's
   list and on their unit.

---

## See also

- [Data Flow](Data-Flow.md): where a dollar comes from, §A and §B in detail
- [Data Lineage](Data-Lineage.md): tables, columns, invariants
- [Reporting](Reporting.md): which surface reads which lane
- [Security Overview](Security-Overview.md)
