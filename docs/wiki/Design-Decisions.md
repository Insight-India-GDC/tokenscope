# Design Decisions

This page summarises each architecture decision record (ADR) the other wiki
pages cite, as the decision stands in the system today. The full records, with
their context and the alternatives considered, are kept internally.

Where the code and a record disagree, the entry states what the code does. Each
entry also names the record's own labels (E1, rule 5, D11 and so on) that other
pages refer to.

---

## ADR-0001 — Language and framework stack

TokenScope is one TypeScript code base in strict mode on Node.js 24: Nuxt 4 and
Vue 3.5 for the dashboard and the Nitro server API, Tailwind and Nuxt UI for
styling, Drizzle ORM over PostgreSQL, Zod for shared validation, and the Model
Context Protocol SDK for the MCP server. Tests are Vitest and Playwright, lint
and format are ESLint and Prettier, and it deploys to Azure Container Apps from
Bicep. Every component carries a permissive licence. Any Redis-protocol store
is limited to the Redis 7.2 command surface so Valkey can stand in for it. The
app does not use one today, and job queues and AI coaching are planned, not
built (see [Architecture](Architecture.md)). Major-version upgrades are
deliberate, reviewed changes.

## ADR-0002 — PostgreSQL as the database

The database is Azure Database for PostgreSQL Flexible Server, PostgreSQL 16,
accessed through Drizzle. PostgreSQL was chosen for features the model relies
on: range types with exclusion constraints, which stop two effective-dated rate
cards or rate plans overlapping, JSONB for audit payloads, and partial indexes.
The record also lists row-level security as a reason, which does not apply:
the policies exist but do not execute (see
[ADR-0013](#adr-0013--authorization-is-enforced-in-the-application)). The
decision is revisited only if the hosting platform mandates another engine or
PostgreSQL Flexible Server changes materially.

## ADR-0003 — Telemetry goes directly to Azure Monitor

Claude Code sends OpenTelemetry log events directly to the Azure Monitor
ingestion endpoint. TokenScope runs no component on that path. A headers
helper on the device refreshes the ingestion bearer about every 29 minutes from
`/api/v1/instances/{id}/bearer`, which returns a token minted from the app's
managed identity. The person is taken from the device's enrolment through
`tokenscope.instance_id`; the `user.email` the client emits is informational.
In private-networking deployments the Log Analytics query path is private,
while ingestion stays public so devices outside the network can send. The
record's Copilot bridge service and its metric-based telemetry design are not in
force; Copilot is covered by
[ADR-0009](#adr-0009--copilot-emit-path), and token usage is read from the
`api_request` log event.

## ADR-0004 — Attribution trust model

Each usage record is attributed to the enrolled owner of the device it names.
The project on the record is a claim, accepted only if that person is a current
member of the project and otherwise left untagged and audited. Claude's own
session id only groups a person's records into sessions; it is never used for
identity or authority. The accepted residual is the device emit credential: it
is readable on the machine it is installed on, so an enrolled user who extracts
it can send records naming another device or project. The record's claim that
reconciliation "nets out" such records, and that its flags are acted on by
operations, is not in force. Flags go to the developer and reach admins only
when escalated, nothing is netted out of attributed figures, and telemetry never
sets a billed total: it only weights the project split of a person's own billed
cost (see [Attributed and Billed](Attributed-and-Billed.md)).
The activity label the record lists as proposed is built (one per session, set by
the developer, never a gate). Status: accepted, provisional; it is re-opened if
TokenScope ever blocks or grants usage, emit credentials become per-user and
identity-bearing, or the session id becomes load-bearing.

## ADR-0005 — Durable emission credentials and revocation

A device holds a durable OAuth emit credential, provisioned by the `provision_emit`
MCP tool and redeemed on the device at `/api/v1/setup/redeem`, so the secret
never passes through the model. The emit credential carries emit scope only and
never read scope (the record's E1), and that redeem is the one audited crossing
from read to emit. Refresh does not rotate the token; device lifetime is an idle
window renewed while the device is in use; revocation is the control (E2). An
explicit revoke or retiring a teammate ends their devices and refuses refresh
and bearer requests. A role change or region move does not stop a device, and a
region move re-places the teammate's live devices. Telemetry is defended by
detection, revocation and reconciliation, not per-record signing, and an ingest
proxy is rejected. The record is marked Proposed but is built and in force. Its
statement that unconfirmed telemetry is dropped or corrected down is not:
see [Attributed and Billed](Attributed-and-Billed.md).

## ADR-0006 — The repository tag is rebuilt on every launch

The repository-local settings file that tags a repo to a project holds no state
that an upgrade could leave behind. On every launch in that repo it is rebuilt
from the device's current enrolment. It carries an instance id and the repo's
`project.code_hash` in `OTEL_RESOURCE_ATTRIBUTES`, and nothing else; the helper,
endpoints and credential apply from each install's own settings. The instance is
this install's, or another local install's when that one is enrolled with the
same deployment, so Claude Desktop and the CLI do not rewrite it in turn. When
the rebuild replaces any other instance, the session start tells the
developer to relaunch. "Emitting" means records have landed, not that a
credential is present. A repo that is never reopened is not rebuilt.

## ADR-0007 — Clients authenticate as themselves

A client never borrows a browser session cookie: reads and tagging run over the
MCP server's own OAuth grants (`tokenscope.read`, `tokenscope.tag`), separate
from the emit credential, which never gains read scope. Status checks run the
real emit path rather than inspecting stored credentials. The record names a
set of client skills the system does not ship; the OAuth client model
supersedes it. Its principle stands.

## ADR-0008 — Emission spoof detection by heartbeat coverage

Each bearer mint stamps an authenticated heartbeat on the device
(`last_bearer_at`), and only that device's own emit credential can mint it. A
background worker marks recent Claude Code spend whose session falls outside the
owner's authenticated window, with a grace of about 35 minutes, as quarantined
"unverified spend". The device owner sees it at
`/api/v1/me/quarantined-spend`, and an audit event is recorded (the record's
§2). It is informational only: it never revokes or deletes anything, and it
does not cover Copilot, devices that never minted a bearer, or a stolen
credential. The emit credential is refused by every read, tag, MCP and admin
surface. The record's statements that reconciliation wipes spend that does not
match the provider, and that a reconciliation reviewer or admin view sees
quarantined spend, are not in force: see
[Attributed and Billed](Attributed-and-Billed.md). Status: accepted,
provisional, with security review retrospective.

## ADR-0009 — Copilot emit path

Copilot uses the same OAuth provisioning as Claude Code, tagged with the tool
`copilot-cli`. The emitter today is a usage extension loaded by the Copilot
runtime: it turns usage events into the same `api_request` log records and
sends them directly to Azure Monitor, with the bearer minted by the same helper.
TokenScope runs no receiver for Copilot telemetry, and a server-side receive
route is rejected. An older file forwarder sends only when Copilot's extensions
feature is off and is due to be removed. A read path for GitHub's native managed
telemetry export is built but switched off until its assumptions are verified
live. The GitHub billing reconciliation the record calls deferred is built:
per-person usage comes from GitHub's AI-credit usage data and the bill from the
pooled Copilot bill (see [Copilot CLI Client](Copilot-CLI-Client.md)). Status:
Proposed.

## ADR-0010 — Showback and chargeback

One ledger, two lenses. Attributed figures (showback) show all genuine usage,
including demo, partner-funded and other spend that is never charged back. Billed figures (chargeback)
are the single place where chargeable or not is decided (the record's rule 5).
Every user who appears in a provider bill is provisioned. Billed amounts come
from provider data, and telemetry is never summed into a bill (rule 3).
Anthropic is billed per person; Copilot is charged as its pooled organisation
bill, net as read from the bill, to the Business Unit the organisation maps to.
The record's Correction rejects a per-user Copilot overage charge and a
seats-times-price licence. Rule 2 (integrity is the only exclusion from
attributed figures) holds in this form: the only telemetry removed from
attributed figures is a session the developer quarantines after a reconciliation
flag (see [Attributed and Billed](Attributed-and-Billed.md)). While a period is
open, billed figures are labelled estimated.

## ADR-0011 — Provider governance is data not configuration

Whether spend is charged back is a `billing` value (`billed` or `tracked`) on
the provider's billing unit, set in the admin UI and audited when changed (the
record's D1). The billing unit is the entity that holds the credential: the
GitHub enterprise, or the Anthropic organisation (D11). The old name and
environment-variable heuristic (D2) is still in the code as a rollback path, and
GitHub money paths use it until the governance cutover is activated; after that
only `billing` decides (see [Reporting](Reporting.md)). A personal subscription
is a teammate's own declaration (D3, D4): it adds showback context and
suppresses only the no-provider-bill review signal, never a provider's billing
verdict, and the teammate is prompted when their usage looks personally paid
for. Copilot credits pool per organisation: seat price and included allowance
are effective-dated rate-plan inputs (D9). When the pool runs out, the overage
on the bill is shared across Business Units by a per-enterprise policy, by
default in proportion to consumption, and the allocated overage shares sum
exactly to the billed overage; seat charges are separate (D10). `reconciliation_mode` decides which organisations are pulled, and the
coverage of each GitHub organisation's app installation is reported, never
silent (D13). Status: Proposed, largely built.

## ADR-0012 — One usage figure with a selectable lens

Attributed usage is the primary figure on every surface, for the same subject
and window. "Your usage" means all of it, including unallocated usage. Billing
is a lens the viewer selects, never a silent substitute. Every figure names its
lens in the visible copy, and any percentage, bar or trend beside a figure comes
from the same lens. Where the lenses disagree materially, the surface discloses
why (for example a declared personal subscription) rather than raising an
alarm. The soft cap counts all unallocated usage, while the needs-tagging list
leaves out usage that arrives with no session to tag. A usage dollar is shown
as real spend, not hedged as notional.

## ADR-0013 — Authorization is enforced in the application

The application is the authorization boundary: `requireRole`, per-resource
scope predicates, and report reach as a revocable per-teammate grant. The
database's row-level-security policies are kept but do not execute, because the
app connects as the table owner. They encode roles, not grants, so enabling them
would silently narrow configured access. This is a settled position, not
deferred work. A CI check that each handler runs in its request-scoped
transaction, apart from 16 exceptions each listed with its reason in
`scripts/check-handler-rls-context.mjs`, and the shared scope-predicate helpers
carry the weight. Revisiting
it would need policies that express grants, enforcement on new partitions, and
the remaining policy gaps fixed.

## ADR-0014 — A customer LLM gateway as a usage source

Status: Proposed, not built. A customer-operated LLM gateway, such as LiteLLM,
would be one kind of observed-usage source, read by a scheduled pull over its
management API with a read-only credential. TokenScope would never sit on the
request path or expose a write surface to it. The source would be a data row
carrying its own `billing` and `reconciliation_mode`. Gateway-priced usage
would be attributed but never billed, and the source would be `tracked` until
the owner rules otherwise. TokenScope would not enforce budgets, issue keys or
price from its own map where the gateway has priced. Usage that never passes a
gateway, such as credit-billed Copilot, stays on the provider API lane.

## ADR-0015 — Native client runtime per OS

Emission needs no runtime to install. On macOS, Linux, WSL and containers the
headers helper is `sh` and `curl`. On Windows it is a PowerShell script run by
the Windows PowerShell 5.1 that ships with Windows, called by absolute path
because `cmd.exe` searches the current repository before `PATH`. Both helpers
read and write the same files in the same shapes and pass one conformance suite
in CI on Linux and real Windows. The helper command is generated per platform at
setup and at every session start. Setup uses Node on POSIX; on Windows without
Node a PowerShell setup enrols an emit-only device, recorded on the server. The
device caches the Azure bearer so a TokenScope outage does not stop emission,
and an ingest relay is rejected because it would put TokenScope on the data
path.

## ADR-0016 — The project code hash is a public join key

`project.code_hash` is an unsalted SHA-256 of the project code, computed on the
client from the repository's committed `.tokenscope` file and used to join
records to projects. It is a public join key, not a secret, and is not salted
or stretched: a salt every client must know protects nothing. Anyone who can
read the hash can recover the code by enumeration. That reaches no one new
except Log Analytics readers, and project codes are internal identifiers;
`client_facing_name` is the confined field. Reopened only if project codes
become confidential or the hash is sent where the code would not be.
