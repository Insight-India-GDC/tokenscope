# Changelog

Reader-facing release notes for TokenScope. Each entry is one line: what
changed, as a user of the product would describe it. Entries accumulate under
`Unreleased`; each dated section below is one public snapshot. (Maintainers:
the publish tooling stamps the heading and a pre-PR gate reminds you to add
the line — see the internal `tools/publish/README.md`, which is not part of
the public mirror.)

## v1.0.5 — 2026-11-03 (snapshot b497e515)

- Security: node-forge is updated to 1.4.1, which is outside the affected
  range of all 12 published node-forge advisories (6 high). node-forge is used
  only by the local development server (`nuxt dev`) to make its self-signed
  certificate. The deployed app never loads it, so no running deployment was
  exposed.
- Updated dependencies: Nuxt 4.6.3, nuxt-security 2.7.0 and the MCP SDK
  1.32.2. Nothing changes in how you deploy or use TokenScope.

## v1.0.4 — 2026-11-01 (snapshot 41782ff9)

- **Before upgrading:**
  - Region admin can no longer be granted; Admin is the one admin role. People
    who are Region admins today keep that role and still administer their own
    region; nobody gains or loses access in the upgrade.
  - The per-person report access "revoke" is removed, and existing revocations
    are deleted in the upgrade: anyone whose access was revoked sees reports
    again as their role and grants allow.
  - For anyone scripting against the API: the placement API now refuses a
    request that still sends `rehome` (400);
    `POST /api/v1/admin/users/{id}/placement-span` and the rollup endpoints
    `GET /api/v1/rollups/manager`, `GET /api/v1/rollups/org-tree` and
    `GET /api/v1/rollups/practice/{ouId}/velocity` are removed.
  - GitHub credentials have generic slots: secrets `GH_PAT_1`, `GH_PAT_2`,
    `GH_PAT_3` and `GH_APP_KEY_1`, read under the credential names `github-1`,
    `github-2`, `github-3` (and `github-1` for the App key). Nothing breaks if
    you do nothing: the earlier secrets (`GH_PAT_PARTNER_DEMO`,
    `GH_PAT_PRODUCTION`, `GH_PAT_ENTERPRISE_NFR`, `GH_APP_KEY_PARTNER_DEMO`) are still
    read, under their old credential names (`partner-demo`, `production`,
    `enterprise-nfr`). To move each enterprise without a gap: add the new secret
    next to the old one in your secrets file or GitHub environment, with the
    same value (`GH_PAT_PARTNER_DEMO` becomes `GH_PAT_1`, `GH_PAT_PRODUCTION`
    becomes `GH_PAT_2`, `GH_PAT_ENTERPRISE_NFR` becomes `GH_PAT_3`,
    `GH_APP_KEY_PARTNER_DEMO` becomes `GH_APP_KEY_1`); apply the infrastructure;
    change the enterprise's credential name under Admin, Reconciliation
    (`partner-demo` to `github-1`, `production` to `github-2`, `enterprise-nfr` to
    `github-3`); then delete the old secret and apply again. The old secret
    names are read in this release and at least the next; the release that
    stops reading them will say so here first.
- The `project` prompt now writes `.tokenscope` in the documented
  `project:` / `code:` form, and the setup and usage prompts name only commands
  that exist in the client reading them. Tagging a session by id says where the
  full id is (the session detail on My usage), and the device-limit message
  names the My account page. (Copilot plugin 0.1.29: the project skill's note
  on one-line files is corrected. Claude plugin 0.1.54: `/tokenscope:backfill`
  says plainly why the server refused a payload format.)
- The example deploy workflow rolls the Container App to the registry the app
  pulls from, not the first registry the resource group lists, and stops with
  a clear error when the group holds more than one Container App. A failed
  first deploy, with no earlier working build, no longer fails a second time
  trying to roll back. The manual steps in `docs/DEPLOY-AZURE.md` match.
- When an infrastructure apply fails, the example infra workflow now prints
  each failed resource and Azure's reason for it, not only the name of the
  module that failed.
- The example infra workflow applies again, up to twice, when an apply fails
  only on Azure's side (an `InternalError`, a timeout, a conflict) or Front
  Door Premium is not yet routing to the app 30 minutes after it deployed. An
  error that names the template or your parameters still fails at once.
- A project's Manage and Request more budget are now buttons at the top of its
  page, opening a side panel; Manage shows how many budget requests are
  waiting. A project's managers no longer see Request more budget.
- Sending a project request again, unchanged, after a lost connection no longer
  files it twice.
- `/tokenscope:activity research` tags the session you are in with an activity,
  with no session id to find (the Copilot plugin has an `activity` skill). The
  status line and `/tokenscope:status` show the project and activity a session
  is tagged with, and where each came from.
- Plugins (Claude 0.1.52, Copilot 0.1.28): `/tokenscope:status` now says when
  usage from this computer last arrived, not only that the credential works.
- The Claude and Copilot plugins on one computer no longer overwrite each
  other's "last arrived" record, so the status line stops flipping to unknown.
- A repo tagged with a one-line `.tokenscope` (just the project code, as the
  project prompt wrote it) is now tagged; it used to be read as untagged.
- The Copilot skills find a plugin installed straight from a folder, not only
  one installed from a marketplace.
- Setup stops, before using its one-time code, when the session started before
  a plugin update; restart Claude Code and run it again.
- Where one `~/.claude` is shared with containers, sessions on each side no
  longer break the other side's telemetry; the side the path does not suit says
  so and how to fix it. A plugin set up from a local checkout moves to the
  installed copy at the next session start.
- On Windows without Node, setup and `/tokenscope:status` now use the Claude
  app's own settings folder when it has one, so the app and the command-line
  Claude Code no longer share one TokenScope device.
- When telemetry is refused because the device store is missing, the message
  now says so and names the files it found.
- Plugin (Claude 0.1.53): when the Claude app and the Claude Code CLI on one
  computer work in the same tagged folder, a session is counted under the
  device it ran on, not whichever one tagged the folder last, once its session
  start has reached TokenScope (usage recorded before that stays where it
  was, and Windows without Node is not covered).
  `/tokenscope:status` names this install's device as the Account page shows
  it.
- `/tokenscope:status` checks whether the folder's project tag is billable on
  a computer that is online and signed in (it used to say "unverified"), and
  when it cannot check, it says why.
- A project tag set while that session's usage is arriving now applies to all
  of it; some rows could stay on the old project.
- A folder's default activity is applied to new sessions from it (only
  standard activity names count; anything else is ignored), and a tag made
  while that session's usage is still arriving is no longer lost.

- A project manager removed from a project while one of their changes was
  waiting can no longer complete it: removing or changing the role of a
  member, editing the budget and adding a top-up now check that they are
  still a manager after the wait, and a member removed meanwhile is no longer
  given a new role on their ended membership.
- Anyone can request a new project from My projects: name, type, Business
  Unit, budget, a suggested code and a proposed project manager. Admins approve
  (setting the final code) or decline it under Admin → Project requests, and the
  requester sees the outcome in their inbox and on My projects.
- Admins can put people on the Project managers list (Admin → Project
  managers). People on it create projects in any region without approval and
  manage them. A governance setting can limit them to their own region.
- A project's manager now runs that project whatever their role: they see its
  spend and who is spending, change or add to its budget, move its end date,
  and add or remove members. Only an admin can remove or demote a project's
  last open-ended manager. A manager assignment given an end date still lapses
  on that date.
- Project members can ask their manager for more budget from the project page.
  The manager approves (for the requested or a different amount) or declines,
  and approval adds to the project's budget. Budgets still block nothing.
- Projects that give each developer their own cap no longer count their budget
  twice in project and Business Unit totals.
- The admin devices list and an admin's force-end of a device follow the region
  the device's owner sits in now, not the region it was enrolled in, so a region
  admin sees and can end the devices of the people in their region.
- Every report now groups a person's usage, history included, by where they sit
  today: move someone to another region or Business Unit and their past usage
  moves with them within a minute. On Business Unit pages, usage tagged to a
  project still counts toward the project's Business Unit, and only
  provider-reported usage follows the person. A closed month's figures are the
  ones in the finance export.
- Finance figures keep a person in the region they sit in even when their unit
  has no Business Unit above it; they used to drop out of that region.
- Moving a person to another Business Unit no longer offers to move their
  recorded usage: reports follow where people sit now, so there is nothing to
  carry across. The "Repair history" button, the history checkbox and From
  date, and the "Check what would move" preview are gone from the Users page,
  Place teammates and the move confirmation.
- The placement API refuses a request that still sends `rehome` (400) instead
  of ignoring it, and `POST /api/v1/admin/users/{id}/placement-span` is removed.
  Bulk placement no longer reports a `historyRepaired` count.
- The practice page counts each person's usage, history included, under the
  practice and region they sit in now, in every panel: spend, people, top models,
  share of region, the 14-week trend and the sibling comparison.
- Admin diagnostics (pipeline freshness, costing rungs, attribution gaps, device
  diagnosis and telemetry recoveries) and escalated over-emission notices follow
  the region each person sits in now, not the region recorded when their usage
  or device was first seen.
- The Copilot overage split goes to the Business Unit each person sits in when
  it is computed. The current and previous month follow a restructure on the
  next daily run; an older month keeps its split until it is re-pulled from the
  Provider governance page, which now says so.
- Org setup now finds the top person in TokenScope when their account was first
  seen on a provider bill and they have not signed in yet (matched by directory
  email), instead of saying they are not a TokenScope user.
- Org setup's "Create a Business Unit" card now asks for the name first
  (prefilled with the manager's department, or "<name>'s team") and says which
  unit the new one will sit inside; nothing is created until you press Create.
- Org setup no longer says the person at the top of the organisation has no
  region, and no longer counts people an Admin placed by hand as having none.
  The overview shows where the top person sits in TokenScope today, with a link
  to change it on the Users page.
- Org setup flags someone who is above two or more of one region's leaders and
  has no leader above them, such as a newly hired head of that region, and opens
  the Regions step at them.
- A region card in Org setup names at most three leaders; a longer list folds
  behind "Show all".
- A new Business Unit always sits inside its region: one created with no parent
  goes under the region's default unit, and the Move dialog no longer offers
  "Top level" or the Unplaced holding node. The region's default unit and its
  Unplaced node cannot be moved.
- A Business Unit's code can now be changed from its Edit dialog. Projects,
  owners and directory rules follow the unit.
- The create dialog on a region page now defaults to a cost-owning Business
  Unit under the region's default unit, so the new unit can take an owner
  straight away.
- Redeploying no longer renames, re-marks or brings back Business Units in a
  region that has been set up; the built-in structure is only added to a region
  that has no units of its own yet.
- An empty region can now be deleted from its page (Admin → Regions → the
  region → Delete). A region with any people, projects, Business Units, leaders,
  rules or recorded spend cannot be deleted.
- Org setup no longer lists people nobody reports to on the Business Units step,
  and once everything has been moved the last step offers only the way back to
  the overview.
- Checkboxes no longer render as solid black squares when the computer is set
  to dark mode.
- The account menu says "Admin" for admins, and the Admin home talks about the
  organisation rather than "your region".
- A new Org setup page (Admin → Organisation → Org setup) places the whole
  organisation from a few decisions about managers. Pick the person at the top,
  read the directory, choose a region for each of their direct reports, tick the
  managers who should own a Business Unit, then review exactly who moves before
  moving them. Every count of what a choice changes comes from the directory
  read, and nobody moves until you confirm the last step. Afterwards the page
  lists what needs deciding (moves waiting, new teams, owners or leaders who
  left, people the directory cannot place), and the Admin home shows a card
  while anything does.
- There is one admin role, Admin; Region admin can no longer be granted.
- Once the top of the organisation is set in Org setup, TokenScope re-reads the
  directory automatically, monthly by default or weekly if you choose, and checks
  that every Business Unit owner and region leader is still in it.
- A new Placement check page for Admins shows everyone whose region or
  Business Unit differs from what the directory says today. Each row says why:
  the rule that decided it, or the manager chain with the owner or leader it
  reached. People with no unit owner above them are grouped by manager, and you
  can apply the proposed moves in bulk. Region rules have a Preview that lists
  who a rule would move before you save it.
- On the Placement check page, Read directory now reads everyone in one go,
  with a running count and a Stop button. Each pass is short enough to finish
  within Azure Front Door's request time-out (it returned 504 before).
- When a directory region rule and a person's manager chain disagree, the
  manager chain now wins, and the chain is followed up to 12 managers (was 5).
- A person's first sign-in now places them from the directory instead of in the
  first region alphabetically, falling back to that region only if the
  directory does not answer within 3 seconds.
- Security fixes from a full audit. Highlights:
  - A self-linked GitHub login no longer moves any of a billed Copilot
    overage onto a Business Unit until an admin confirms the binding. Shares
    now land on the Business Unit rather than the teammate's team node.
  - Only an Admin can set a region's leader.
  - Only an Admin can make someone who is not yet a teammate a
    Business Unit owner.
  - The Front Door Private Link approval script approves a request only when
    it is the only one, and otherwise stops and lists them for you to decide.
  - Removing your own GitHub link no longer removes bindings an admin or the
    directory made.
  - An authorisation code issued before an admin signed someone out no longer
    works, and the token revoke endpoint now revokes access tokens too.
- The per-person report access "revoke" option is removed. Report access
  follows the role and the operational and finance grants.
- The manager, org-tree and practice velocity rollup endpoints, which no page
  used, are removed.
- Back-dated budget top-ups now count towards the per-project top-up cap, and
  per-developer caps can be changed only through the split.
- The plugin keeps its refresh token out of the shared Claude Code settings
  file and removes copies an older version left there. It also warns when the
  server URL is not https.
- Claude Desktop and the CLI on one machine now keep separate TokenScope
  enrolments when setup runs with Node; re-run setup once in each to separate
  an existing install.
- A repository tagged to a project now holds only its project tag. When Claude
  Desktop and the CLI both open it, each authenticates with its own credential
  and both record usage under the device id in the tag, so opening it in both no
  longer warns about a superseded device enrolment.
- Impossible dates such as 2026-02-31 are rejected with a clear error instead
  of failing.
- The Front Door Private Link approval script approves only requests from
  Front Door's own private endpoint carrying the deployment's own message, and
  never re-approves a connection an operator rejected.
- The Reconciliation records ledger now shows each record's Business Unit, not
  the person's team.
- The GitHub connection check's seats line counts only logins bound by
  directory sync or an admin as matched, and shows logins claimed only by the
  teammate as a separate number.
- Signing an MCP client in from a container or over SSH no longer leaves a
  browser error page in front: the sign-in is handed over in a small popup that
  closes by itself, and when the client cannot be reached the consent page says
  to copy the URL and paste it at the client's prompt (Claude Code's `URL >`).
- A sign-in made while an admin changes your role or region, or ends your
  sessions, now has to sign in again like every other session, instead of
  keeping its token.

## v1.0.3 — 2026-10-14 (snapshot d358530b)

- Dependency updates within their current versions, including Nuxt 4.6.1,
  which builds the app with Vite on Rolldown.

## v1.0.2 — 2026-10-14 (snapshot d12dab88)

- Moving someone to another Business Unit, alone or in a bulk placement, now
  moves their devices too, so new spend lands on the new unit from the next
  attribution run, as a region move already did. A device set up or confirmed
  while a move is in progress now lands on the new placement.
- Escalated over-emission flags now reach the inbox of the admins of the flag's region, with the day's figures and a link to the teammate's usage.
- An admin whose report access is revoked is no longer sent inbox notices that
  carry report data (over-emission escalations and Copilot bill notices),
  cannot see ones already delivered, and cannot forward or be forwarded one.
- The wiki has a new page, Attributed and Billed, on the trust model: which
  figures are money and which are indicative, what a developer can and cannot
  change, the checks and who sees them, and the known limitations. Security
  Overview and Authentication & Security no longer say reconciliation deletes
  spend that does not match the provider; it flags it for review.
- The wiki has a Design Decisions page summarising each architecture decision
  as it stands, so the decisions the wiki refers to can be read publicly. The
  wiki now describes the system as it is, and several statements that no longer
  matched the code are corrected, notably that row-level security policies
  exist but do not run (the app enforces authorisation itself).
- Security fixes: provider-governance diagnostics (Anthropic org health, GitHub
  org discovery, backfill, cost drift) are now platform-admin only; self-claimed
  identities are capped at 10 per person; budget top-ups have an explicit role
  check, a 50-live-top-up cap per project and a $1,000,000 ceiling; resolving an
  over-emission flag can only quarantine usage inside the flagged day and tool;
  admins acting through persona override are recorded on audit rows; and seven
  vulnerable runtime dependencies are patched.
- Connecting Claude Code no longer needs Git, a GitHub account or a server-URL
  step: each TokenScope deployment serves its own plugin marketplace, already
  pointed at itself (Claude Code 2.1.224+). In a terminal, one
  `/plugin marketplace add https://<your-tokenscope>/api/v1/plugin/marketplace.json`
  is enough. Claude Desktop gets its own Connect guide: its marketplace form
  takes only Git hosts, so you paste a short prompt into a Code session that
  adds the marketplace to your settings, and signing in with `/mcp` works in
  the app (verified on macOS). In the app, setup also puts this computer in
  your login environment, because the app ignores the tracking labels in the
  settings file; without that, Desktop usage arrived but could not be linked to
  you. The admin Client connection page also shows
  the same keys for managed settings; that route is not yet tested.
  Installing from Git is still there as the CLI troubleshooting fallback.
- Claude Desktop with its own settings folder (`CLAUDE_CONFIG_DIR`, as some
  Claude app installs have) is now set up as itself: the Connect guide's paste,
  `/tokenscope:setup` and `/tokenscope:status` use that folder instead of
  `~/.claude`, so setup no longer writes the terminal CLI's settings and status
  no longer reports the CLI's sign-in as the app's. Claude Desktop on Linux is
  now linked to you after setup and one log out and back in. The Desktop guide
  also says to leave Auto mode before the paste (Auto mode refuses edits to
  Claude's own settings), and the marketplace entry keeps plugin updates on.
- A repo under your home folder with no `.tokenscope` of its own no longer
  reads TokenScope's own `~/.tokenscope` folder as its project tag, and on
  Windows the session-start hook's fallback search path works again.
- Claude Code and the Claude Desktop Code tab now report usage from Windows,
  and Windows users can set up without installing Node (emit-only, through
  Windows PowerShell); Copilot CLI and the Copilot App work on Windows too.
  The plugin connects to your own deployment — set its server URL in the
  plugin options — instead of a built-in host, a TokenScope deploy no longer
  interrupts telemetry, and granting someone a role no longer stops their
  devices reporting.
- The plugins' hooks and commands now run when the install path goes through
  a symlink or junction (for example a symlinked `~/.claude`); before, they
  exited without doing anything or reporting an error.
- Background workers now keep up as more people enrol: attribution reads
  devices three at a time in fair rotation, provider usage is written in bulk,
  and directory lookups are bounded and retried. New alerts warn when a worker
  nears its time budget and when telemetry approaches the workspace's daily cap.
  Behind Front Door the origin timeout default is now 240 s, so scheduled
  workers are no longer reported failed at 60 s.
- The daily re-read that recovers late telemetry no longer runs inside the
  attribution worker: it is queued once a day on the telemetry recovery queue
  and read one device-day at a time instead of a device's whole week at once.
  Attribution no longer pauses while it runs, and an operator's recovery is
  not blocked by it.
- With private telemetry query on, the platform's own logs (container console
  and system logs, diagnostic settings) now go to a separate workspace,
  `log-ops-<name>`, that you can query from the Azure portal; the usage
  telemetry stays private. In that workspace the console table is
  `ContainerAppConsoleLogs` with a `Log` column (previously
  `ContainerAppConsoleLogs_CL` with `Log_s`), so update saved queries.
- The app container's CPU and memory are configurable (`appCpu`, `appMemory`).
- New alerts fire when an app replica restarts more than once in 30 minutes, and
  when the platform-log workspace receives no container log for an hour.
- Connecting Claude Code or Copilot now takes four or five short steps in plain
  English, and on Windows the TokenScope helper gives up on a stalled server
  after 10 seconds instead of hanging.

## v1.0.1 — 2026-10-02 (snapshot f86a61cf)

- Project pages gain a chargeback toggle showing each project's share of the
  actual vendor bill, split by tagged share, alongside the attributed view.
- Security hardening:
  - Estate-wide billing configuration and creating directory unit rules are now
    platform-admin only.
  - Every device enrolment mints a fresh device and never touches an existing one.
  - Client registration has a hard cap and keys on the Front Door socket IP.
  - The client plugins keep the emit token off the command line.
- **Before upgrading:** a self-set `NUXT_ENROLLMENT_SECRET` weaker than the key
  strength floor (32+ characters of random text; generate one with
  `openssl rand -base64 48`) is now
  ignored, so enrolment with it fails closed. The Azure templates do not set it.
- Dependency updates, including undici, drizzle-orm, vue and nuxt-echarts.

## v1.0.0 — 2026-09-30 (snapshot 9f04b8d6)

- **1.0.0, the first release.** Public releases are now versioned tags with
  GitHub Release notes: a major version means the upgrade needs action (a
  removed or newly required template parameter, a renamed secret), minor and
  patch releases are a redeploy. Each release's notes say which deployment
  postures it passed on Azure before it was tagged; deploy a release rather
  than `main`.

- Worker jobs are created one at a time, and a new optional template parameter,
  `workerJobPrefix`, names them (default unchanged), so two deployments can
  share a resource group. The example deploy workflow retries a momentary
  Azure error while checking a new build instead of rolling it back.

## 2026-09-29 (snapshot 3d47ef59)

- `npm run dev:stack` no longer fails on a stock Docker host: the local
  telemetry collector could not write to its volume and exited.
- A Burstable Postgres apply no longer fails intermittently with
  `ServerIsBusy`: its configuration writes now always run one at a time.
- The example GitHub Actions workflows can be called from another workflow,
  take a parameter-file override and a `prebuilt` build mode for images pushed
  by your own pipeline, and a first apply now ends green with a notice instead
  of failing on the not-yet-built image. Several docs references were
  corrected (helper script paths, a removed setting) and are now checked on
  every change.

## 2026-09-29 (snapshot cba982b4)

- The deploy guide names the Anthropic credential the published template
  actually reads, so Claude spend reconciliation finds its key.
- Staging and production deployments can put Azure Front Door Premium in front
  of the VNet-integrated posture over Private Link, so nothing but Front Door's
  WAF is public; the template refuses Front Door Standard there. The apply
  approves Front Door's Private Link request while it runs, and an optional
  build subnet hosts a self-hosted runner or an ACR agent pool for building into
  the private registry.
- The public docs were checked end to end: installing the plugins and pointing
  them at your own deployment, configuration, the architecture and wiki pages
  now describe what the code does.
- Example GitHub Actions workflows (`examples/github-actions/`) deploy
  TokenScope from your fork: infrastructure with a what-if preview, and image
  rolls that only promote a build once it is verified serving, rolling back
  otherwise.

## 2026-09-29 (snapshot 0bc69c1f)

- Running locally and deploying to Azure now work as documented: the local
  stack is reachable from your machine and accepts real Claude Code telemetry,
  and the sandbox and VNet parameter files deploy, with a step-by-step guide
  covering the Entra app registration and every other prerequisite.

## 2026-09-26 (snapshot 678cdc99)

- Claude Code 2.1.283 warned at every startup that it ignores telemetry settings
  in a repository's `.claude/settings.local.json`. TokenScope's project tag no
  longer copies them there; they already apply from your user settings, and
  project attribution is unchanged. The local OTLP forwarder that worked around
  the chunked-upload bug in Claude Code 2.1.191-2.1.211 is removed; those
  versions are long superseded. Claude plugin 0.1.41.
- Copilot usage is now captured by a Copilot extension that reads Copilot's own
  per-call usage events, in both Copilot CLI and the GitHub Copilot App (which
  was not captured at all before). Setup no longer adds anything to your shell
  rc files (it removes the block earlier versions added) or writes span files
  into your repositories. Re-run TokenScope setup in Copilot once to switch over:
  from then on every session is captured by the extension, and setup removes the
  old forwarder's files from your projects. Installing or setting up the plugin
  turns on Copilot's extensions feature (in `load_only` mode unless you chose one);
  with it on, a repository you trust in Copilot can also run its own Copilot
  extensions, as it can already run repository hooks.
  Until then, capture carries on through
  the old forwarder. Copilot plugin 0.1.18.
- A failing Copilot CLI emitter no longer turns every Claude Code statusline on
  the same machine red (and vice versa): each tool reports its own emission
  health, and `/tokenscope:status` names the other tool's failure separately.
  Plugins 0.1.39 (Claude Code) and 0.1.17 (Copilot CLI).
- OAuth sign-in: approving access now hands the sign-in to desktop MCP clients
  such as the GitHub Copilot App automatically, instead of asking you to copy
  and paste a URL. If the client can't be reached (for example, it runs in a
  container) the page notices and offers the Copy URL fallback.

## 2026-09-23 (snapshot 51ce6e22)

- Security: `devalue` (used by Nuxt to serialise page payloads) updated to
  5.9.4, fixing a denial-of-service on malformed input (GHSA-9rgm-9g3h-6x36).

## 2026-09-23 (snapshot cfd2e137)

- Emitting devices no longer go red 90 days after setup ("Session ended") while
  in use: a device and its credential now last as long as they keep being used,
  and only go idle after 90 days without activity. Ending a device (revoke, admin,
  idle cleanup) now revokes its credential immediately, everywhere. `/tokenscope:backfill` (plugin 0.1.38) now works
  from inside a session instead of reporting "not enrolled".

## 2026-09-17 (snapshot 725be6e1)

- The "attribution stall" alert no longer pages when the estate simply goes
  quiet after activity (an overnight lull paged every night and cleared on the
  first message of the morning): rows the previous landing already wrote no
  longer count as a backlog. Unchanged: when the ingest metric cannot be read
  at all, the alert still errs toward paging while emission is recent. The inbox `read-path-stale` items from the same
  cause stop too.

## 2026-09-11 (snapshot e1d3321f)

- Dependency security update: the fourteen advisories GitHub reported against
  the lockfile (transitive packages under the MCP SDK, the Nuxt build tooling
  and Nuxt UI) are cleared; `npm audit` is clean. No behaviour change.

## 2026-09-11 (snapshot 9c3df90d)

- If you use both Claude Code and Copilot CLI on the same machine, they no
  longer overwrite each other's TokenScope enrolment. Each now keeps its own
  credentials, so setting up the second one stops silently switching off
  telemetry for the first. A device where this had already happened repairs
  itself the next time you start a session, with nothing to re-run: Claude Code
  falls back to the credentials in your own settings while it waits, so
  telemetry keeps flowing. If it ever cannot work out which enrolment is yours,
  it now stops with an explanation naming the file to fix rather than going
  quiet. Update to plugin 0.1.37 (Claude) / 0.1.15 (Copilot) to pick it up.

- Copilot CLI: a device whose TokenScope enrolment file is present but
  incomplete no longer re-attempts automatic enrolment on every launch (it
  could never succeed, and it sent the enrolment secret each time). Re-run the
  `tokenscope-setup` skill to repair such a device. Copilot plugin 0.1.16.

## 2026-09-10 (snapshot c5ba50b4)

- The "Global finance" role has been withdrawn. It was described as a
  reporting role but in practice granted the whole cross-region admin surface —
  including changing people's roles and granting report access. Nobody held it,
  and nothing is lost: company-wide report access is granted per person on the
  Report access screen and needs no role, while org-wide administration stays
  with Platform admin. It is also no longer offered when setting someone's role.

- The Claude and Copilot plugins are hardened against a hostile repository you
  merely open. A cloned repo could previously supply its own `PATH` and get its
  own `git` run on your machine at session start; point the plugin at a fake home
  and choose where your emit credential was sent; or ship a `.gitignore` symlink
  that corrupted your Claude settings and silently switched telemetry off. None
  of these needed you to run anything — opening the repo was enough. Update to
  plugin 0.1.36 (Claude) / 0.1.14 (Copilot) to pick the fixes up.

- The two "attribution has stalled" alerts now tell a real outage from an idle
  estate using an independent ingest-side signal — the count of rows the Azure
  Monitor pipeline physically received (a platform metric read straight from the
  data-collection rule, not a query over the stored data). An editor left open
  overnight no longer pages: nothing arrived, so nothing is stuck. A reader that
  quietly stops landing usage while rows keep arriving still pages, even if it
  returns "success", and no longer auto-resolves mid-outage while rows are still
  arriving. When the metric cannot be read the alerts fall back to the previous
  behaviour,
  which errs toward paging. Admin's diagnostics show the coverage verdict and the
  received/dropped counts next to each run. (Needs a Monitoring Reader role grant
  on the data-collection rule, shipped in infra; until it is applied the fallback
  keeps the alerts working.)
- Contributors: opening the repo in its devcontainer now gives you a working
  integration-test run out of the box — a local Postgres is installed and wired
  up, so `npm run test:integration` no longer needs Docker there.

## 2026-09-02 (snapshot 39578d5f)

- Re-running setup in a repo tagged for a project no longer leaves that session
  quietly reporting the wrong device. The repo keeps its own copy of the
  enrolment, and it is only refreshed once the session has already started, so
  the session that set things up carried on emitting under the previous device
  until it was restarted — its usage still counted, but it never appeared
  against the new one. Claude Code now says so at session start and tells you to
  restart. Repos without a project tag were never affected.

- The status line no longer shows a device that has never recorded anything as
  healthy. A brand-new enrolment is still given time to settle before anything
  is claimed, but one that has gone hours without a single record now reads as
  not landing rather than as an untroubling neutral state.

- Ops alerts stop paging for things you cannot act on at 3am. Only critical
  conditions reach the phone now; warnings are recorded in Admin's inbox
  instead. The "attribution has stalled" alert no longer fires just because a
  machine is switched on, and Admin's diagnostics now show the evidence behind
  it.

- My usage loads considerably faster. The page was re-reading your full spend
  history several times per view; it now reads finished days from a pre-computed
  daily summary and only today from the live records. The page checks the summary
  is complete and up to date before trusting it, and falls back to the old path
  automatically when it is not, so the two agree wherever the fast path is used.
  Admin's diagnostics show whether the job that maintains the summary is
  healthy.

- Admin's database check now shows whether per-statement recording is actually
  switched on, and whether it is storing statement text it should not be. It
  could previously report the instrument as loaded while it was recording
  nothing.

- Admin's database check now shows how far back its counts reach and when each
  table's statistics were last refreshed. A table can be read end-to-end simply
  because the planner has no figures to work from, and that was previously
  indistinguishable from a scan it chose deliberately. Indexes that enforce a
  constraint are no longer listed as unused.

- Pages now start drawing sooner. The header used to wait on three background
  requests before anything appeared, including two it made only to decide
  whether to show the Reporting link; that decision now arrives with your
  sign-in, and the unread-mail count fills in on its own.
- Admin's database diagnostics now show when each table's statistics were last
  refreshed. A table can be scanned end-to-end simply because the planner has no
  figures to work from — which is what a major database upgrade leaves behind —
  and that was previously indistinguishable from a scan it chose on purpose.

- The needs-tagging list could hide a session from you entirely. Sessions were
  ordered by their last activity with no tiebreaker, so when several shared the
  same timestamp the list showed a different, arbitrary selection each time you
  loaded it — and a session that kept losing the tie never appeared at all. The
  order is now stable, so the same sessions appear in the same order every time.

- Admin → Diagnostics can now answer "which database queries are slow?" on
  demand. A new Database performance check reports the heaviest statements,
  tables being scanned without an index, cache behaviour, indexes nothing uses,
  and the relevant server settings — so a slow page can be diagnosed from the
  admin pages instead of needing access to the cloud logging workspace. It runs
  only when you press the button, never on page load.

- Your usage page counted every Claude Code conversation as harness overhead.
  The lane each request came from was being compared against a label Claude
  Code has never actually sent, so real conversation tokens were filed as
  "auxiliary" — which is why the page could claim 100% of your volume was
  overhead and offer a large, wrong saving. Lanes are now read from the values
  the client really emits, and the overhead insight stays quiet when there is
  no conversation-lane signal to compare against rather than reporting 100%.
  Historical figures correct themselves on the next page load.

- Ops alerts now say why they fired. An alert page records the specific reason
  (a probe that timed out, a query that was refused, a worker streak) alongside
  the condition, and Admin → Workers shows each worker's slowest run and lets
  you open any run to read what it recorded — so an alert can be answered from
  the admin pages instead of reconstructed from timestamps. Alerts also wait for
  a second consecutive observation before paging, which stops a single slow
  check from raising a false alarm.

- Admin pages now change the moment you click a link and show a loading state
  while their data arrives, instead of appearing to do nothing until the
  slowest request had finished. The Diagnostics page loads its quick checks
  first and brings in its network/telemetry probes and cost checks separately,
  so the page is readable before the slow parts land. The Audit log's default
  view (newest first, no filters) also no longer waits for the whole log to be
  sorted before showing its first page.

- The Diagnostics worker card no longer shows a worker an admin has switched
  off as "failing" on failures from before it was disabled: a skipped run ends
  the failure streak the same way a successful one does (as the pager already
  did), and the worker now reads "disabled" rather than ok or failing.

- Scheduled workers no longer jam when many fire at the same minute. Each
  dispatch used to pin one database connection for its run-lock and then wait
  for a second from the same small pool, so a top-of-the-hour batch could wedge
  every worker at once — the telemetry reader stopped, the "attribution has not
  landed data" banner went up, and nothing recovered until a restart. The lock
  now lives on its own connections, so a large batch simply queues and finishes.

- The Diagnostics network card stops reporting failures nobody can fix: it no
  longer probes the Log Analytics agent endpoint (we run no agent, and the
  private endpoint has no such address), and it only dials the Azure Monitor
  hosts the app actually calls — the rest share one private endpoint, so their
  DNS answer is the evidence and a dial only invented red rows. Those two rows
  were also paging the operator as criticals every 15 minutes.

- TokenScope no longer competes with other teams for the shared Azure Monitor
  private-DNS records: dev reads telemetry through corporate IT's private-link
  scope instead of running a rival one, removing the conflict that silently took
  the read path down for 28 hours in August. The Diagnostics network card also
  stops calling a zone "working" on evidence it does not have — it can prove a
  zone is linked, not that it points at our own endpoint, and it now says so,
  and it no longer reports all-clear when a record fails to resolve at all.

- The last slow read on the reports page is gone: the Top-drivers project
  breakdown (and the Business-Unit population count behind it) now reads the
  same continuously pre-aggregated table as the rest of the region figures
  instead of rescanning the whole usage history on every request.
- TokenScope now pages its operator when the service degrades, instead of
  waiting to be looked at: a watchdog checks every 15 minutes that telemetry
  can actually be read, that attribution is landing data, and that the
  background workers are running, and pushes criticals to the operator's
  phone and email on first detection — with Azure-side alerts that still fire
  when the app itself is down. The usage pages now say when the figures may
  be missing recent spend: the freshness dot no longer shows green on data it
  cannot vouch for, and a banner appears while attribution is stalled.
- The Diagnostics network card no longer paints the deliberately-unused Dev
  redis as a failure: it shows a neutral "not mapped / not implemented"
  state, stays out of the failure counts, and never enters the copy-paste IT
  report.
- API responses now tell you where their time went (a Server-Timing header
  your browser's network tab shows: database vs app vs cache), admins can
  see how long each background worker ran over the last day, page assets
  download compressed, and the reporting rollup does a fraction of its
  former background work.

- Region reports open much faster: their figures are now pre-aggregated
  continuously in the background instead of being recomputed from full history
  on every request, so a page shows up in the time it takes to read one small
  table.
- The usage page and the reports open noticeably faster: every request now
  makes far fewer database roundtrips, connections stay warm between clicks,
  and the activity list does far less work per page — it builds full rows for
  only the sessions the page shows instead of every session you have ever
  had.

## 2026-08-19 (snapshot 74cf5c7c)

- Copilot usage now counts the tokens spent in the Copilot app, not just the
  Copilot CLI, and reports them as their own surface rather than folding them
  into CLI totals.
- Your usage page now shows how your Copilot work splits between the CLI and the
  Copilot app, and says when IDE activity cannot be shown on the same measure.
- The Copilot engagement card shows its language mix again. It had been blank
  for everyone, because it was weighted on a figure GitHub does not send.

## 2026-08-18 (snapshot ecd23e5b)

- The open-source mirror now publishes the engineering wiki to its own GitHub
  Wiki tab, instead of leaving it empty while the same pages sat in the repo
  tree, and its test suite no longer fails on files the mirror deliberately
  withholds.

## 2026-08-18 (snapshot 1358d845)

- The published open-source snapshot no longer ships an agent configuration
  whose hook pointed at tooling that is not part of the public tree, so running
  a coding agent against a public clone no longer fails on its first command.

## 2026-08-18 (snapshot cbedba50)

- Opening Reporting no longer shows "You don't have access to any reports" to
  people who do have access, and the page loads in place of the long wait that
  used to precede it.

- Administrators can now see, on the Diagnostics page and in the boot log,
  exactly how much of the database's row-level security is actually in force —
  which connection the app is using, how many tables are enforced, and whether
  the deployment can create the restricted database account the enforcement
  needs. Read-only: it reports, and changes nothing.
- Copilot per-seat showback no longer deletes valid rows when GitHub returns a
  partial seat roster: a response that is short, malformed, or smaller than the
  count GitHub itself reports now skips the clean-up instead of treating the
  missing seats as removed.
- Re-pulling a Copilot bill for a month is now restricted to finance
  administrators. It was open to regional administrators, who could trigger it
  for any enterprise, not just their own region's.
- GitHub Copilot reporting now works for an enterprise that has moved from a
  personal access token to the GitHub App: per-seat Copilot showback populates
  again, and "Discover Copilot orgs" lists the enterprise's organisations
  instead of failing. Both used to call an endpoint only a token can read, so
  an App-mode enterprise saw no seats and no orgs to onboard.
- Reconciliation keeps going when one GitHub enterprise's credentials are not
  wired up: previously that single misconfiguration stopped the hourly run
  before it reached anybody else's data.
- Budgets can no longer be recorded against a scope the product does not
  recognise, and a per-developer cap can only sit on a project or business-unit
  budget.

## 2026-08-15 (snapshot cd9e2ff0)

- The published repository's own test suite and checks now pass on a fresh
  clone. Four of them read files that are internal-only and therefore absent
  here, so they failed on every published snapshot; they now skip where the
  source they check does not exist, and still fail wherever it does.

## 2026-08-15 (snapshot 8cafda19)

- Security hardening round 2: a manager can no longer reach another region's
  projects or write allocations against them; a deactivated teammate now loses
  their API tokens as well as their browser session; the worker kill-switch is
  restricted to org-wide admins, matching the door that runs those workers; a
  malicious repository can no longer steer the plugin into writing your
  credential where it can read it, nor redirect where your telemetry is sent,
  and it can no longer choose which `curl` or `sh` the credential-refresh helper
  runs; and the setup helper ignores attempts to point it at another server.
- Attribution now raises an admin alert when the telemetry joiner hits its
  per-run device cap, instead of silently attributing only the busiest devices.
- Global finance and Platform admin see the whole company's reports by their
  role again, with no grant needed (Region admins are unchanged — still their
  own region); and an admin can now revoke one person's report access
  entirely — the "administer, no data" case — without changing their role.

## 2026-08-12 (snapshot 3c430d2f)

- The project site's landing page shows the six product screenshots (they were
  README-only, and the site builds from the docs folder where they never
  appeared).

## 2026-08-11 (snapshot 71467f44)

- Reporting access is now a per-teammate grant: an admin can give any user
  operational (company-wide regions and Business Units) or finance reporting
  without making them a platform admin — and platform roles no longer imply
  report access. Grants are revocable, can expire, and are fully audited.
- Public snapshots now carry these release notes, and code PRs are gated on
  adding their synopsis line.
- The README shows the product: six screenshots captured from the synthetic
  demo estate, and the demo data now uses canonical fictitious client names
  (Northwind Bank, Woodgrove Bank, Contoso League) with realistic per-developer
  spend generated through the real ingestion pipeline.
