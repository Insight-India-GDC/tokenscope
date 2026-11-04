# Authentication & Security

As-built reference for how TokenScope authenticates callers and defends its data.
Names the exact mechanisms, env vars, headers, and cookies in the shipped code.
System shape: [Architecture](Architecture.md). Endpoint detail: [API Reference](API-Reference.md).

> Deployment-specific values (hostnames, the public entrypoint, environment
> switches) are illustrated generically here; see
> [Deployment & Operations](Deployment-and-Operations.md) for the switches.

## Trust boundaries

Four caller classes, four authentication mechanisms — each carries a different kind of trust.

| Caller | Mechanism | Notes |
|---|---|---|
| **Browser users** (developer / manager / Admin) | Entra OIDC cookie (`nuxt-oidc-auth`) + per-request DB enrichment | Only path that can read "my projects"/consumption or change attribution |
| **MCP / CLI clients** (Claude Code) | **OAuth 2.1** (PKCE) — `tokenscope.read`+`tag` for the MCP tools; `tokenscope.emit` for ingest | One browser consent grants read+tag; device emit is provisioned via a secret-isolating handoff (`provision_emit` → `/setup/redeem`). |
| **Internal schedulers / workers** | **HMAC-SHA256** request signature | Key separate from the user-session HMAC key |
| **Telemetry → Azure** | App-level **Managed Identity** bearer, `monitor.azure.com/.default` | Write-only, narrow-scope, same token every session — Azure never sees a TokenScope token |

![Each caller class presents its own credential on its own route; only the telemetry write bypasses the app](images/authentication-and-security-trust-boundaries.svg)

1. Browser users come through the public edge. The Entra OIDC cookie identifies them, and `requireRole`, `requireRegionScope` and the scope predicates decide what they may do. The OAuth consent (`POST /oauth/authorize`) also rides this cookie.
2. CLI clients present three different credentials on three routes: an OAuth access token for the MCP tools, a one-time handoff code (or the plugin's enrollment secret on `/setup/enroll`) to obtain an emit credential, and that emit credential to fetch the Azure Monitor token.
3. Cron jobs sign each trigger with the internal HMAC key and call the app's own address from inside the environment.
4. With `frontDoorId` set, `require-front-door` rejects any request without the matching `X-Azure-FDID`, so `workerBaseUrl` must then be the Front Door endpoint and the jobs go out through it.
5. Device telemetry goes straight to the Azure Monitor ingest endpoint with the managed-identity token the app minted. It never passes through the app.
6. Workers run inside the app process. The read joiner queries `OTelLogs` with the app's managed identity.

*Five credential routes lead into the app; the one write that bypasses it carries a write-only token the app issued.*

**Authorization is enforced in the application.** The **app gate** (`requireRole`,
`requireRegionScope`, per-resource scope predicates) is the authorization boundary:
it runs before the query and denies *loudly* — `403` RFC-9457 body + audit entry.
Report reach is a revocable per-teammate grant (`report_access_grant`, mig 0129)
resolved by `requireReportScope`.

## Web authentication (Entra OIDC)

![Every request re-reads the teammate behind the OIDC cookie, so revocation and deactivation apply on the next request](images/authentication-and-security-oidc-session.svg)

1. The browser starts sign-in at the `nuxt-oidc-auth` routes (`/auth/entra/*`).
2. The module runs the Entra authorization with `openid profile email offline_access`.
3. Entra returns the tokens. The module copies `oid`, `email`, `name`, `preferred_username` and `upn` into the session.
4. The browser receives the encrypted session cookie, which is the only identity cookie.
5. Every request carries that cookie to `tryAuth`.
6. `tryAuth` decrypts it and reads the claims. Without `oid` or `email` there is no session.
7. One query loads the teammate by `entra_oid`, together with `revoked_at` and `is_active`.
8. On first sign-in only: a UPN on the directory-exclusion list is refused with 403; a bill-provisioned row with the same email is adopted; otherwise the teammate is inserted (`ON CONFLICT (entra_oid) DO NOTHING`) as `platform-admin` if the email matches `NUXT_BOOTSTRAP_ADMIN_EMAIL`, else `developer`, homed on the first region's `__UNPLACED__` unit, with a `teammate-jit-created` audit row.
9. The session survives only if `is_active` is true and the cookie's login time is not earlier than `revoked_at`.
10. The handler gets a frozen `Session` cached on the request, or `requireAuth` returns 401.

*There is no second app cookie: identity is the OIDC cookie plus a database read on every request.*

- Configured in `nuxt.config.ts` under the `entra` provider; OIDC enabled unless `NUXT_OIDC_AUTH_DEV_MODE === 'true'`.
- Secrets (`clientId`, `clientSecret`, URLs) are build-time placeholders, overridden at boot by `NUXT_OIDC_PROVIDERS_ENTRA_*` env vars — `nuxt.config.ts` is evaluated at build with no secrets present, so reading `process.env` in provider config is deliberately avoided.
- `userNameClaim = preferred_username`; the optional claims copied into the session are `oid`, `email`, `name`, `preferred_username` and `upn`. The last two carry the sign-in UPN, which is the axis the directory-exclusion policy matches on, and this list is their only source — `user.claims` is populated from it alone, and no `userInfoUrl` is configured. `userNameClaim` is not a substitute: it is read from the access token, which does not reliably carry `preferred_username`.
- **Session resolution**: identity is resolved **per request** from the OIDC cookie + DB enrichment. There is no second session cookie.
  - `tryAuth(event)` → resolved `Session` or `null` (unauthenticated / enrichment fails).
  - `requireAuth(event)` → strict gate; `401` problem-details on no session.
  - Enriched `Session` = `teammateId, email, displayName, role, regionId, orgPath, issuedAt`; **frozen + cached per request** on `event.context.__tokenscope_session` so middleware → `withRequestRls` → route share one DB lookup.
  - **Revocation:** a session minted before the teammate's `revoked_at` is rejected — and on an assumed identity, the impersonator's own row is checked on the same two axes.
  - **Deactivation:** a teammate with `is_active = false` resolves no session at all — existing or freshly signed-in, with no timestamp comparison.

### Revocation and deactivation

**Two axes, and they are not the same shape.** `revoked_at` is a *session anchor*,
and nothing else: a benign role change or region move bumps it, as do the
explicit revoke endpoints, so it only clears sessions minted **before** it — the
same person can sign in again a second later and hold a valid session. It is never
an eligibility or offboarding flag; that is `is_active`.

An authorization code is judged by the session that approved it, not only by when
the code was created: the code stores that session's mint time and the exchange
refuses it if `revoked_at` is later than either. The exchange also locks the
teammate row before it consumes the code, so it serialises with a role change,
region move or revoke-sessions that is still committing: a sign-in whose session
predates the change either finishes first and has its token revoked by it, or
waits and is refused. A session minted while the change was committing is newer
than the change's `revoked_at` (the transaction's start) and is kept; it reads
the new role and region on every request anyway.
`is_active = false` is **deactivation**: a durable state that denies every
credential for that teammate, existing or newly minted, because there is no
"after" to be on the right side of. Both tests fail closed — a missing teammate
row, or an `is_active` that is not exactly `true`, denies.

**Devices answer to a separate anchor, `emit_revoked_at`** (mig 0152).
A role change or region move bumps `revoked_at` only: cookie sessions and
read/tag credentials are re-validated, but a device keeps emitting, because its
emit credential carries no read scope and the RLS context of each emit request
is read from the teammate row at that moment. Explicit revoke-sessions bumps
both anchors and ends the teammate's devices. Device-bound emit credentials
(`scope = 'tokenscope.emit'` with an `instance_id`) are judged against
`emit_revoked_at` on refresh and on every `/instances/{id}/*` route, as are
`/bearer`'s instance gate and the joiner.

Deactivation is enforced on every credential path, not just the cookie:

| Path | Where |
|---|---|
| Cookie session (`tryAuth`/`requireAuth`) | `revocationDenies` judges `revoked_at` **and** `is_active` for the primary identity from the same fused query that resolved it — a missing row denies outright. When the session carries a persona override, `isRevoked` re-reads and judges the override target and the impersonator's row on the same two axes (a missing impersonator row is not itself a denial) |
| OAuth bearer (MCP, the four instance-scoped emit routes) | `requireOAuthBearer` joins `teammate.is_active` and rejects with `invalid_token` |
| Refresh-token grant | `tm.is_active IS TRUE` is a conjunct of the refresh `UPDATE`, so no match ⇒ `invalid_grant` |
| Authorization-code exchange | part of `consumeAuthCode`'s compare-and-swap predicate, so a deactivation landing mid-exchange cannot be straddled. A refused code is left **unburned** and reports the same opaque `invalid_grant` as an unknown one — no deactivation oracle |
| Token issuance (`issueTokens`) | the single choke point through which both the interactive exchange and the durable emit credential (`/setup/redeem`, `/setup/enroll`) mint an `oauth_token` row |

This matters because the **privileged-identity-cleanup** worker's only identity
mutation is `is_active = FALSE` — it never writes `revoked_at`. On the
`revoked_at` axis alone a retired account would keep its live cookie session and
keep refreshing a fresh access token indefinitely.

### Persona override (non-production demo impersonation — sidecar path)

> **Structurally disabled outside demo environments.** This is a non-production
> *demo* affordance. Its availability is an **allowlist floor**, not a
> production denylist: demo / act-as / impersonation is enabled **only when the
> deploy env ∈ {`local`, `sandbox`}** (`shared/env/deploy-env.ts` —
> `DEMO_CAPABLE_ENVS`). Every other env — `dev`, `staging`, `production`, and
> `unknown` (a dropped/unrecognised env identity) — **404s whatever any flag or
> the caller's role says**, so no single env flag
> (`NUXT_ALLOW_PERSONA_OVERRIDE`, `NUXT_OIDC_AUTH_DEV_MODE`) can re-open
> impersonation. The mechanism below ships in code and is documented for
> completeness; in any non-demo env it is refused at the structural floor.

![Persona override is refused everywhere except local and sandbox, whatever the flags or the caller's role](images/authentication-and-security-persona-gate.svg)

1. The structural floor. Unless `NUXT_DEPLOY_ENV` classifies as `local` or `sandbox`, the endpoint returns 404 whatever the flags or the caller's role; the gate decides on the environment first. An unset value on a deployed container classifies as `unknown`.
2. With `NUXT_OIDC_AUTH_DEV_MODE=true` there is no Entra at all, so gates 3 to 5 are skipped.
3. Otherwise `NUXT_ALLOW_PERSONA_OVERRIDE` must be `true`, or the endpoint returns 404.
4. The caller must have a signed-in Entra session (401).
5. The caller must be `admin` or `platform-admin` (403).
6. The request must pass the same-origin check (403).
7. The requested persona must be one of the fixed demo personas (400).
8. The audit row is written before the cookie: `persona-impersonation` for an override, `dev-login` in dev mode. If the insert fails, the request fails and no cookie is set.
9. The sidecar cookie is minted. On later requests it is read only on `local` or `sandbox`, and only while its `impersonatorOid` matches the live Entra identity.

*The environment is checked first, so no flag can reopen impersonation on any other environment.*

- **Allowlist floor first** (`server/auth/persona-override.ts` →
  `evaluatePersonaGate`): if the env is not demo-capable (`demoCapable=false`,
  i.e. not `local`/`sandbox`), the gate returns `404` first, whatever the flags
  or the caller's role. An env that is unset or unrecognised is refused too.
- HMAC-signed sidecar cookie `ts_persona_override` (`server/utils/persona-override-cookie.ts`), separate from the OIDC cookie; minted only when the gate is on (i.e. only in a demo-capable env). Wire format `base64url(payload).hex(HMAC-SHA256(payload))`, signed with `NUXT_SESSION_SECRET`; `httpOnly`, `sameSite=lax`, path `/`, `secure` on every deployed env.
- Behind the floor the gate keys on `NUXT_OIDC_AUTH_DEV_MODE` (true → sidecar is *primary* identity, no Entra) and `NUXT_ALLOW_PERSONA_OVERRIDE` (true + Entra `admin`/`platform-admin`). The env classification keys on `NUXT_DEPLOY_ENV` (falling back to `NODE_ENV` only to fail closed), **not `NODE_ENV`** alone (which is always `'production'` on deployed containers).
- Two hardening guards: override honoured only when its `impersonatorOid` matches the live OIDC identity (stale cookie can't elevate another user), and target must be a `DEMO_PERSONAS` member (leaked HMAC secret still can't impersonate an arbitrary teammate). Cleared by `POST /api/v1/auth/stop-impersonating` and logout.

## RBAC — roles & scoping

| Role | Label (`ROLE_LABELS`) | Scope |
|---|---|---|
| `developer` | Developer | Own data |
| `manager` | Manager | Own org subtree (allocations within the org path) |
| `admin` | **Region admin (retired)** | **Can no longer be granted**: there is one admin role, Admin. `canAssignRole` refuses it and it is not in `SELECTABLE_ROLES`. A remaining holder administers a single home region (region-scoped). |
| `finance` | **Finance (retired)** | **Unassignable** — in the `ROLES` enum only for exhaustiveness and old rows; **excluded from `SELECTABLE_ROLES`**, never offered in role dropdowns and assigned to no one. Region-scoped finance is served by `admin`; org-wide finance by `platform-admin`. |
| `global-finops` | **Global finance (retired)** | **Unassignable.** In **no** capability set; in the enum for old rows only. Company-wide report access is a per-teammate `report_access_grant` (mig 0129) and needs no role. |
| `platform-admin` | **Admin** | The one admin role. Cross-region; satisfies every gate. The **only** org-wide role. |

> **Two vocabularies, one spelling.** The string `global-finops` also appears as
> the value of the `app.user_role` GUC (`server/db/rls.ts`, `worker-db.ts`, and
> the scope predicates below). That is a **scope value**, not this role:
> `platform-admin` maps *onto* it (`rlsRoleFor`) and the worker lane runs *as*
> it. Removing that value would break platform-admin's own data scope and
> every worker.

Canonical human-facing labels come from `ROLE_LABELS` (`shared/auth/roles.ts`) —
`platform-admin` = "Admin". The roles that can no longer be granted label
themselves as such — `admin` = "Region admin (retired)", `finance` = "Finance
(retired)", `global-finops` = "Global finance (retired)" — so an old row never
reads as a live role.

- `requireRole(event, ...allowed)` — variadic; permits if role ∈ `allowed`. `platform-admin` short-circuits every check. `403` RFC-9457 on denial.
- `requireRegionScope(event, regionId)` — binds an `admin` to their home region; `platform-admin` are region-unbounded.

Per-resource scope helpers — the data-scope boundary:

| Helper | Effect |
|---|---|
| `allocationScopePredicate(tableRef)` | SQL predicate: `global-finops` unbounded; otherwise the project must sit in the caller's region, and an `admin` is bound to that region while a `manager`/`developer` additionally needs the project's cost-owning unit inside their `app.user_org_path` subtree. The region clamp **wraps** the role split rather than sitting beside it. Used by every allocation read and the two allocation writes. |
| `assertProjectScope(event, project)` | Write-side mirror: `admin` bound to project region; `manager` needs the project in their **own region** *and* its cost-owning unit in their org subtree; `global-finops` unbounded. The region clamp **wraps** the subtree test here too — org-unit paths are unique only per region (`UNIQUE (region_id, code)`), so an ltree prefix match alone would accept a colliding path from another region. Both halves fail as one `403` — the refusal names neither. The org-role arm of `assertProjectScopeOrManager` (below), which gates the four project-assignment routes, `POST /allocations` and `/allocations/{id}/split`. |
| `assertProjectScopeOrManager(event, tx, project)` | `assertProjectScope`, **or** a current PM of this project (`server/auth/project-authority.ts`). Returns which arm admitted the caller (`scope` / `project-manager`) for the audit row. Gates the existing routes a PM may use on their own project. The allocation `GET {id}` / `PATCH` / `topups` routes apply the same two arms in SQL: `allocationScopePredicate` or a current `manager` assignment on the allocation's project. |
| `assertProjectManagerOrAdmin(event, tx, project)` | A current PM of this project, `platform-admin`, or the region admin of the project's region. An org-role `manager` who is not the project's PM is refused (`403`). Gates the end-date route and budget-request decisions. |
| `placedBelowRegionRootPredicate()` | The org-placement clamp, ANDed onto every subtree arm above. See below. |
| `requireReportScope(event, tx, scope)` | The `/reports/*` read gate. Resolves caller + active cost-centre ownership + active **report-access grants**, evaluates `effectiveReportGrants`, and throws the same RFC-9457 `403` as `requireRole`. `requireAuth`-based (identity + an in-query/JS-computed scope) rather than a fixed-role gate — a documented exception to "every gate is `requireRole`". See [Report access grants](#report-access-grants). |

Admin mutations (`server/auth/admin-guards.ts`): `evaluateRoleChange` blocks self-role-change and same-role no-ops (the former last-admin-per-region protection went with Region admin: the role can no longer be granted, so a stray holder must be demotable; the last platform-admin needs no guard because only a platform-admin may modify one and self-change is refused); `evaluateRevokeSessions` is always positive (revoking just forces re-sign-in).

### Project managers

Two relationships, neither of them an org role, give project powers. The org
role `manager` is a people manager and is neither.

| Relationship | Held as | Grants |
|---|---|---|
| **On the Project managers list** | a live `project_manager_grant` row; only `platform-admin` adds or revokes one | Create a project without approval (`POST /api/v1/projects`) and become its PM, or name another teammate as PM. In any region, unless the platform switch `projects.pm_own_region_only` is 1: then only in the region the holder is placed in now. Checked by `canCreateProjects` (`server/auth/org-roles.ts`), which only that route calls. |
| **PM of a project** | a `project_assignment` row on that project with `role = 'manager'` in force now | On that project only: read its consumption, create and edit its baseline and caps, top it up, change its end date, add members who are already teammates, remove members, make a member PM, and decide its budget requests. |

Everyone else asks: any teammate may request a project
(`POST /api/v1/me/project-requests`, decided by an admin of the request's
region), and a current member may request more budget on a project
(`POST /api/v1/projects/{id}/budget-requests`, decided by its PM or an admin in
scope).

What a PM does **not** get: the admin project PATCH (names, type, Business
Unit, WBS code, authorisation) and DELETE, adding a person from the directory
(`oid`) or adopting a `bill:` / `provisional:` placeholder, and leaving the
project without a PM. Removing or demoting the last current, open-ended PM is
409 for anyone but `platform-admin` and the region admin of the project's
region; every assignment write locks the project row first, so concurrent
changes are judged one after the other.

Revoking a list grant leaves the projects the holder created, and their PM
assignments, as they are. A PM assignment ends only when someone ends it or its
range runs out.

### The org-placement clamp

A `manager`'s and a `developer`'s only least-privilege boundary is
`path <@ current_setting('app.user_org_path')` — their placement's ltree subtree.
That boundary is worth exactly as much as the placement it is anchored on: a
teammate homed on a region's **root** org unit sits at a bare label whose subtree
is *every unit in the region*, so the `<@` test is true for all of them and the
clamp degenerates into "the whole region".

Two halves prevent that:

- **Default placement is the holding node, not the region root.** Every no-signal
  placement path — first-SSO JIT, directory provisioning, emit-on-install
  enrolment, and the admin region reassign — homes the teammate on the region's
  **`__UNPLACED__` holding node** (`server/auth/placement-home.ts`,
  create-on-demand and idempotent) rather than the region's `default` BU. A
  holding node has no children, so the subtree it spans is that node alone — and
  the predicate below refuses a holding-node placement outright, so an unplaced
  teammate gets no subtree grant at all.
- **The predicate refuses a region-root subtree grant.** `placedBelowRegionRootPredicate()`
  (`server/auth/org-subtree-scope.ts`) is one exported clause, ANDed onto the
  dev/manager arm of `orgSubtreeScopePredicate`, `managerScopePredicate`,
  `allocationScopePredicate` and the project-consumption read. It asserts the
  caller's own placement is a genuine, non-root unit: `unit_type <> 'holding'`
  **and** `parent_id IS NOT NULL` **and** `code <> 'default'`. The **structural**
  `parent_id` test is the load-bearing one — a region root is parentless whatever
  it is named, and `code <> 'default'` alone fails open the moment a region's root
  is not literally called `default`, which is the case for any region created at
  runtime. The naming test is kept as defence-in-depth and made a real invariant
  from the other side: `regions.post.ts` plants a region's root org unit in the
  same transaction as the region, and `org-units.post.ts` reserves the `default`
  code.

> **Product-visible.** A developer or manager placed on a region root sees their
> Regional and Business Unit views limited to their own placement, not the whole
> region. That is the intended least-privilege outcome. `admin` (region-bounded)
> and `platform-admin` are unaffected. Separately, the teammate-axis driver CSV export is capped at 100 rows
> plus an explicit `(all other)` remainder row, so the totals still reconcile but a
> finance user exporting for every name will not get every name.

### Report access grants

The full RBAC above decides *what a role can ever see*, and the admin roles see
reports **by their role**: a region `admin` sees their own region, and
`platform-admin` sees the whole company (all regions, all
Business Units, the finance pack). On top of that, an admin can **widen** a named
teammate whose baseline lacks that scope — a region admin included — to
company-wide reporting — per-teammate, revocable, optionally-expiring rows
(`report_access_grant`, mig 0129), without touching anyone's platform role.
There is no per-person deny: admins are trusted and spend is not sensitive, so
the `revoke-all` lever mig 0130 added was removed by mig 0158 (owner ruling
2026-10-15).

**To grant report access** (requires Admin — the
roster is org-wide only): **Admin → Policies → Report access** → search the
teammate by name or email → pick the permission (*Operational reporting* or
*Finance reporting*, table below) → optionally set an expiry → confirm. It is enforced on the teammate's very next report request; the
*Reporting* entry appears (or disappears) in their navigation on their next page
load (the shell caches report metadata for up to an hour). Revoke a specific
grant row from the same roster — one click; an expired grant stays listed as
*Expired* until revoked or superseded by a re-grant. Actions are audited
(`report-access-granted` / `report-access-revoked`). On a fresh install the admin
roles already see reports by role, so an Admin needs no self-grant; the
grants are the per-person widenings on top.

- **Two positive permissions** (`shared/auth/report-visibility.ts`,
  `REPORT_ACCESS_PERMISSIONS`):

  | Value | Effect |
  |---|---|
  | `operational` | Widen to the whole-company reporting surface: cross-region access, every region, every Business Unit — including their billed-spend figures. |
  | `finance` | Widen to the whole-company finance pack (`/reporting?scope=finance`) alone. Names the PACK, not the retired `finance` role. |

  The two positive grants are independent — a caller can hold either, both, or
  neither, and a grant never implies its counterpart. Neither changes the
  holder's platform role.
- **Baseline + grant.** `effectiveReportGrants(role, ownsCostCentre,
  permissions)` is a role-shaped **baseline**
  (`developer`/`finance` own-region only, Business Unit tab via ownership;
  `manager`/`admin` own-region + subtree Business Units; `platform-admin` the
  WHOLE COMPANY — all regions, all Business Units, finance)
  widened **field-wise** by whichever positive permissions the caller's active
  grants buy. A static **WHO-SEES-WHAT
  matrix** export (baseline and fully-elevated, per persona) drives both the
  admin-pane preview and the tests, so the preview can never drift from the gate.
- **Admins see reports by role.** `platform-admin`
  sees the whole company by role — no grant needed — and a
  region `admin` sees their own region by role. There is no cross-region widening
  for a region admin (the anti-IDOR clamp stays): "all reports" is delivered to
  the ORG-WIDE roles. The org-wide baseline uses `costCentre: 'all'`, which the
  resolvers treat as the explicit unbounded path — a literal `TRUE` visibility
  predicate — never the `orgSubtreeScopePredicate` GUC arm, so the leak class
  that arm could open is designed out. A region admin is widened only by
  an explicit `operational` (cross-region) or `finance` grant.
- **Two further grant columns — the DRILL contract.** `ReportScopeGrants` also
  carries `teammate` (`'people-scope' | false`) and `project`
  (`'membership' | 'member-in-scope' | 'region-wide' | false`), in the same
  WHO-SEES-WHAT matrix and the same admin preview. `teammate: 'people-scope'`
  is CC-subtree/self today — a plain `regional: 'own-region'` width does NOT
  confer it, because a per-person governance view is not a reporting width, and
  region-leader-sees-whole-region is not expressible until owner decision E1.
  Both are LEVELS, never admissions: the per-teammate endpoint still requires
  in-window usage by a subject who sits inside the caller's own frame now, plus
  `teammate.is_active`, resolved per request.
- **Enforcement is `requireReportScope`** (the scope-helper row above), applied
  to the whole-company region width and the finance report routes; the
  `regional` and `cost-centre` resolvers take a grant-computed `crossRegion` /
  `unbounded` flag. `finance` is a plain **boolean** grant — `true` sees the
  whole-company `/reports/finance` pack (region-unbounded by design); it is held
  at BASELINE by the org-wide roles (`platform-admin`), and
  every other caller — a region `admin` included — reaches it only via an active
  `finance` grant.
- **Pure app gate.** `requireReportScope` is the boundary, like every scope
  helper. The grant is threaded as an explicit JS-computed scope argument, not
  a GUC change. For the ORG-WIDE roles the whole-company reach is explicit
  (`costCentre: 'all'` → the resolvers' unbounded arm, a literal `TRUE`
  visibility predicate, and the project path's own `return null`), so the
  `orgSubtreeScopePredicate` GUC arm is never on the path.
  A REGION `admin` stays region-scoped through the ORDINARY path, not a special
  seam: the `?ou=` drill, the Business Unit list and drill, and project
  reports-depth all resolve through `orgSubtreeScopePredicate`, which scopes a
  real org subtree correctly (plus the `regional: 'own-region'` clamp in
  `resolveRegionalScope`). Three `ownerOnly` / own-region seals in
  `costCentreScopeOpts` fire only for an org-wide role holding no grant
  ("manager / admin / developer callers: always `false`"). No such caller
  exists, because the org-wide baseline is `costCentre: 'all'` and
  `regional: 'all-regions'`, so the seals are unreachable; removing them is a
  tracked follow-up.
- **Read-only blast radius.** On the server the grant module is imported
  **only** by the reporting query layer, `/api/v1/reports/**` (+ `meta` and a
  read-only admin diagnostics preview), and the grant CRUD under
  `/api/v1/admin/report-access/**`; enforcement is pinned per LITERAL endpoint
  by the 200/403 integration suite rather than by an import scan. It never
  touches write endpoints, `rollups` mutation paths, `me/*`, or provisioning.
  Every deny on an unclamped scope (the whole-company region width +
  `/reports/finance`) is audited (`report-scope-denied`, payload carrying
  `permissions`) — those have no in-query backstop, so the audit *is* the
  record. Opening a NAMED individual's reports-depth page is audited on every
  request (`report-teammate-viewed`; its CSV export writes the distinct
  `report-teammate-export`), disclosed on the page itself, and served
  `Cache-Control: no-store` so a browser-cache hit can never absorb a view or a
  download. The reporting **client** also imports the two drill rules, to
  decide whether a name renders as a link or as plain text — a rendering
  decision only: the server re-resolves the same rules per request, so a
  client that guessed wrong gets a 403, never a door.
- **The cost-centre scope block is the grant's own output.** The cost-centre
  report returns the centres a caller may look at, and it is exactly the list
  `fetchVisibleCostCentres` produced: the org-subtree predicate OR an active
  `cou_owner` row (or every centre under an active `operational` grant). Each
  option reports `owned` — which arm admitted it — so the page can land the
  reader on the centre they OWN rather than on whichever sorts first, without
  the browser ever evaluating a grant.

  **Two consequences worth stating.** The filter runs BEFORE the list is
  returned, so a caller cannot distinguish "this centre does not exist" from
  "you cannot see it" — deliberate, the same anti-IDOR posture as the drill's
  single 403, and it means any client-side inference about an ABSENT centre is
  unsound. And the selector cannot offer a width the endpoint would refuse,
  because it is rendered from the grant's own list rather than from a role.

- **Which projects a cost-centre owner sees, and against what.** These are two
  different questions and the page answers both rather than picking:
  - the **allocation denominator** is homing-derived — `project.cost_owning_unit_id`,
    the centre that LEADS the project. That is what a budget roll-up must be
    clamped on, and it stays that way;
  - the **row** therefore carries BOTH operands: the project's own total (the
    right figure against its own budget, wherever the spend came from) and
    *this* centre's share of it (clamped on the usage row's
    `cost_owning_unit_id`, like every other burn figure on the page).

  **Not yet built, and named so it is not assumed:** the evidence annex's
  membership-derived VISIBILITY rule — a cost-centre owner seeing every project
  with ≥1 member in their centre, including projects another centre leads. The
  shipped listing is homing-derived. Widening it is a denominator decision, not
  a filter change, and it is open.

- **Admin surface — org-wide only, end to end.** `GET/POST
  /api/v1/admin/report-access` + `DELETE .../{id}` — every one is
  `requireRole('platform-admin')` (`platform-admin` passes any `requireRole`
  gate) with **no region-admin read access at all**: a per-teammate grant
  roster is company-wide PII. POST is CSRF-protected, requires
  an active non-provisional target, and 409s on a live duplicate; DELETE is a
  soft revoke (history preserved). Editable at Admin → Policies → Report
  access; `/admin/policies/report-visibility` redirects there. A role demotion does **not** retract an already-active grant
  (designed persistence — a grant is keyed on teammate id alone); the roster
  shows each holder's current role so a stale grant is visible, and
  revocation is one click.

## Request transaction lanes (RLS context)

Every authenticated request does its DB work inside a transaction opened by
`withRequestRls(event, fn)`. It resolves the session via `requireAuth` and
`SET LOCAL`s four session variables — `app.user_region_id`, `app.user_org_path`,
`app.user_role`, `app.user_teammate_id` — mapping `platform-admin` onto the
unbounded `global-finops` scope value (`rlsRoleFor`). `SET LOCAL` is what makes this safe on a pooled
connection: the settings vanish when the transaction returns, so the next
checkout cannot inherit the previous caller's identity. Device-credential
routes use the machine lane: `withMachineRls` on `/bearer`, `/health`, `/end`
and `/project-resolve`, `withDeferredMachineRls` on `/setup/redeem`. Workers run on their own pool (`server/db/worker-db.ts`), whose
every connection carries `app.user_role=global-finops` as a startup parameter.

`scripts/check-handler-rls-context.mjs` enforces it in CI — every `server/api/**`
handler carries a lane, with 16 explicitly-reasoned exceptions: the anonymous
health probe, the auth-bootstrap paths that resolve an identity and so cannot
already have one, two cross-identity paths over a shadow teammate's rows, the
estate-wide attribution-stall signal, and two GitHub probes that interleave
reads with HTTP.

The schema also carries row-level-security policies that read these variables.
They do not execute: the app connects as the table owner, and owners bypass RLS.
Authorization is the app gate described above.

## MCP/CLI auth + telemetry (OAuth 2.1)

![The model only ever sees a five-minute handoff code; the durable emit credential moves between a local helper and the server](images/authentication-and-security-mcp-provisioning.svg)

1. The client calls the MCP endpoint without a token.
2. The server answers 401 with a `WWW-Authenticate` header that points at the protected-resource metadata.
3. The client opens the consent page with a PKCE challenge.
4. The teammate approves. `POST /oauth/authorize` uses the Entra cookie and the same-origin check, and returns the callback URL.
5. The code reaches the client through its loopback callback, or through the page's Copy URL paste-back. The page warns that this URL works like a password: paste it only into the session that asked.
6. The client posts the code and its PKCE verifier to `/oauth/token`.
7. It receives an access token and a refresh token for the scopes it requested, `tokenscope.read` and `tokenscope.tag`. The MCP tools now work.
8. The `tokenscope-setup` prompt calls the read-scoped `provision_emit` tool, which locates or creates the device's `instance_attestation`.
9. It returns only a handoff code that expires in 5 minutes and works once. The durable credential never enters the chat.
10. The client runs the local redeem helper with that code.
11. The helper posts the code to `/api/v1/setup/redeem`. The code is the authentication; a replayed or concurrent redeem gets 401.
12. The server returns the durable `tokenscope.emit` refresh token, bound to that device, and the OTel configuration.
13. The helper writes them to `~/.claude/settings.json` with mode 0600. Claude reads OTel settings at startup, so it must be restarted.
14. In every session Claude calls the `otelHeadersHelper` script, about every 29 minutes.
15. When its cached access token is missing or near expiry, the helper refreshes it with the refresh token.
16. It calls `/api/v1/instances/{instanceId}/bearer` with the emit access token. A credential bound to a different instance is refused.
17. The server returns the app's managed-identity token for `https://monitor.azure.com/.default` and records the mint as a heartbeat.
18. The helper hands Claude the `Authorization` header.
19. Claude sends OTLP log events straight to Azure Monitor.

*Steps 11 and 12 are the only place the durable emit credential travels, and they run outside the model.*

### OAuth 2.1 consent (read + tag)

- The MCP client runs a client-initiated PKCE (S256) authorization-code flow against `/api/v1/oauth/{authorize,token,register,revoke}`. The **GET `/oauth/authorize`** gates the Entra session and validates `client_id`/`redirect_uri`, then 302s to the consent page (`app/pages/oauth/authorize.vue`); **POST `/oauth/authorize`** is the grant — the one cookie-bearing OAuth endpoint, so it **requires `assertSameOrigin`** (the cookieless token/register/revoke endpoints deliberately skip CSRF). It reuses `issueAuthCode` (teammate-bound, PKCE-carried).
- **Callback delivery.** The POST returns the callback URL as data. On Approve with a loopback `http:` callback (RFC 8252 native apps — e.g. the GitHub Copilot App) the page opens a small popup window in the click handler and navigates it to the callback (a navigation, which Chrome's Local Network Access does not block); the consent page itself never navigates away and stays in view behind the popup. It then polls `POST /api/v1/oauth/code-status` (session + same-origin; reads the caller's own `oauth_auth_code.token_issued_at` — set only when `/oauth/token` issues a token, unlike `consumed_at`, which a failed exchange also sets) — redeemed → the popup is closed and the page shows "Connected"; not confirmed within 8 s (the loopback is unreachable, e.g. a client in a container or over SSH, or the popup was blocked or closed) → the popup, which would be showing a browser connection error, is closed and the page leads with the paste-back steps: copy the URL and paste it where the client asks for the URL from the browser's address bar (Claude Code's `URL >` prompt). It still flips to Connected if the pasted code is later exchanged. Before Approve, a loopback client's consent page says that a client in a container or over SSH will ask for a URL to be pasted back. Polling is ~35 requests over 2 min in the per-IP limiter the whole app shares; a failed poll (429, error, timeout) waits the slow 5 s interval. The grant request itself times out after 15 s and is cancelled if the page is left, and Approve/Deny are offered again. Closing the popup needs the page's handle to survive the popup's cross-origin navigation, which COOP `same-origin` severs, so `/oauth/authorize` alone is served with COOP `same-origin-allow-popups` (`nuxt.config.ts` routeRules). The page clears the popup's `opener` before navigating it, so the loopback page gets no reference back to the consent page, and `same-origin-allow-popups` still isolates the consent page from any cross-origin page that opens it. A loopback Deny / error callback is handed to the client the same way (so it stops waiting), without polling. Nothing can confirm a client received a deny/error (there is no code to poll), so the page always keeps **Copy URL** for it, plus **Open in a new tab** when it could not be sent (popup blocked, tab closed, or an `https:` callback, which is never auto-delivered). Nothing failing the `https:`/loopback scheme guard (`shared/oauth-callback.ts`) is ever opened.
- Tokens are stored as HMAC hashes only (`oauth_token`); the raw value is returned once. Refresh is **non-rotating** — revoke (not rotation) is the control ([ADR-0005](Design-Decisions.md#adr-0005--durable-emission-credentials-and-revocation)). `requireOAuthBearer` joins `teammate.revoked_at` (`emit_revoked_at` for a device-bound emit token) for the E2 revocation cascade and `teammate.is_active` for deactivation ([Revocation and deactivation](#revocation-and-deactivation)).
- The granted scopes are `tokenscope.read` + `tokenscope.tag` (MCP tools). The separate `tokenscope.emit` credential is provisioned via the handoff below, never granted directly to the consent.
- **Consent is refused on an assumed identity.** `POST /oauth/authorize` returns a JSON `403 access_denied` when the session carries a persona override, before the client/`redirect_uri` lookup, so the refusal cannot become a redirect and no code is issued. An OAuth consent mints a teammate-bound code that becomes a durable access/refresh token; granting one while acting as someone else would leave a credential outliving the impersonation and carrying the impersonated teammate's identity. (Persona override is confined to the demo-capable envs `local` and `sandbox` — see [Persona override](#persona-override-non-production-demo-impersonation--sidecar-path) — so no environment that authenticates against Entra reaches this refusal; it is what holds the property if impersonation is ever enabled on one that does.)

### Device emit provisioning (secret-isolating handoff)

The everyday self-service connect path (sequence above). The read-scoped `provision_emit` MCP tool locates-or-creates the device's `instance_attestation` and mints a **short-TTL (~5 min) one-time handoff code** in `emit_handoff` — it does **not** return the durable emit credential, so the broadly-readable secret never enters the LLM's context. A local helper redeems the handoff at **`POST /api/v1/setup/redeem`** (handoff-is-auth, no cookie/CSRF, like `/bearer`), single-use enforced atomically via `consumeEmitHandoff`'s conditional `UPDATE … RETURNING`. Redeem mints the durable `tokenscope.emit` credential (scope never widened) bound to the instance — rotating out any prior live emit credential for that device — and returns the OTel bundle. This read→emit crossing is the single audited exception to the read/emit wall ([ADR-0005](Design-Decisions.md#adr-0005--durable-emission-credentials-and-revocation) E1).

### Azure Monitor ingest bearer

- `GET /api/v1/instances/[instanceId]/bearer` (`server/auth/obo.ts`) returns an Azure Entra token scoped to `https://monitor.azure.com/.default`. Despite the filename this is **not** a per-developer On-Behalf-Of flow — it is an **app-level Managed Identity token** (same token every session), from the container app's user-assigned MI holding *Monitoring Metrics Publisher* on the Data Collection Rule.
- Gates issuance on the OAuth `tokenscope.emit` access token (the bound teammate must own the instance), then returns the MI-minted token; refreshed within Claude's ~29-min headers-helper window. Each mint doubles as an authenticated heartbeat for the heartbeat-coverage check. Cached app-wide with a 5-min refresh skew + single-flight guard (racing `/bearer` requests collapse onto one `getToken`).
- **The emit credential is bound to its device at USE, not only at mint.** `oauth_token.instance_id` is written when the credential is minted, and on the four instance-scoped routes (`/bearer`, `/health`, `/end`, `/project-resolve`) `requireOAuthBearer` takes the target instance and rejects a **mismatched** binding with a `401 invalid_token`, so one of a teammate's emit credentials cannot drive another of that teammate's instances. A **NULL** binding stays permissive and logs: read/tag grants are never instance-bound, and legacy emit credentials predate the binding. This check is what makes [ADR-0008](Design-Decisions.md#adr-0008--emission-spoof-detection-by-heartbeat-coverage) §2's anti-spoof claim — *"a cross-instance spoofer cannot mint a bearer for a victim's instance"* — true.
- **Ending a device revokes its credentials.** A trigger on `instance_attestation` (mig 0141) revokes every `oauth_token` bound to a device the moment it is ended (`ts_actual_end`), purged (`ts_purged`) or deleted (before the FK de-binds it), whichever code path does it, and invalidates its outstanding provisioning handoffs. A token minted before the end is refused everywhere from then on, and a live credential can only be bound to a live device of the same teammate: `/setup/redeem` and `/setup/enroll` check it under the device row lock, and a trigger on `oauth_token` (mig 0143) refuses any other bind at the database. Every path that touches them takes the locks in one order (device, then `emit_handoff`, then `oauth_token`), so a concurrent end, redeem, re-provision or grant revoke resolves in one order or the other, never a deadlock. `/bearer` still tells the owner why (`401 Session ended`); any other caller gets the uniform 401.
- **A device lives while it is used.** Its `instance_attestation.ts_expected_end` is an idle window of 90 days, renewed by every `/bearer` mint and by re-provisioning; `session-gc` ends a device only once both that window and its last mint + 90 days have passed. A credential bound to a device (`oauth_token.instance_id`) has its `refresh_expires_at` renewed on every refresh, and refreshes **only while that device is live, unpurged and owned by the same teammate** (`invalid_grant` otherwise). Unbound credentials (read/tag) keep a fixed 90-day lifetime. `/bearer` and re-provisioning hold the device row lock from the lifecycle check through the renewal, so a concurrent close either lands first or re-checks the renewed window.
- Rationale (inline STRIDE note): token is **write-only, narrow-scope** — ingests to one DCR only, so leakage caps at ingest noise, not exfiltration; per-developer Azure RBAC is unnecessary for telemetry.
- `NUXT_AZURE_MONITOR_AUTH` mode: `'mi'` (real `ManagedIdentityCredential`, optional `NUXT_AZURE_MI_CLIENT_ID`; needs Azure IMDS), `'static'` (`NUXT_AZURE_MONITOR_STATIC_BEARER` verbatim — local/test seam), else deterministic mock. **Static mode is guarded in production** — throws unless `NUXT_ALLOW_STATIC_BEARER=1`, so a copy-pasted non-production config can't ship a live operator credential.

## The emit channel is untrusted — spoof detection, quarantine, and the read→emit wall

The `tokenscope.emit` credential is the **most broadly-readable secret in the
system**: it lives in `~/.claude/settings.json` on every host (and every CW
sharing that host), so anyone with read access to that file/host holds it. The
OTLP records it writes land in an **Azure Monitor / Log Analytics Workspace
(LAW)** that is **effectively public-write within the org**. The emit channel is
therefore **UNTRUSTED**: anyone holding an emit token (or LAW write access) can
hand-write **spoofed** `attribution_record` rows claiming a victim's
`tokenscope.instance_id`, `project.code_hash`, and email — rows that land
*provisionally* "assigned to you."

We **deliberately do not** defend this by trusting the wire or signing per record
— emitted telemetry is transitionary, reconciled data, not budget truth, and a
signing collector / proof-of-possession was rejected as over-engineering
([ADR-0005](Design-Decisions.md#adr-0005--durable-emission-credentials-and-revocation),
[ADR-0008](Design-Decisions.md#adr-0008--emission-spoof-detection-by-heartbeat-coverage)). The
defense is **revoke + detect + reconcile**, behind strict **emit-credential
isolation**.

### Emit-credential isolation — the read→emit one-way wall (HARD INVARIANT)

The broadly-readable emit credential is strictly walled from **every** privileged
surface. The wall is the **per-token-row scope** (`requireOAuthBearer` returns the
row's scope): an `tokenscope.emit`-only bearer is **rejected** by every MCP tool,
every `/api/v1/me/*` read, and every `/api/v1/admin/*` route (`insufficient_scope`
/ 401/403). Consent (`POST /oauth/authorize`) runs on the Entra browser session,
not a bearer, so an emit bearer **cannot authenticate a user** either.

- **The only sanctioned crossing is one-way `read → emit`:** a logged-in user's
  read token provisioning *their own* device via the audited `provision_emit`
  tool. `emit → read/tag/session` is **never** possible — a leaked emit token
  cannot read data, tag a session, or bootstrap privilege, and cannot even
  provision *another* emit credential (`provision_emit` requires read).
- **No privileged surface derives authority from any emitted field.** Budget,
  membership, identity, and authz come from the **authenticated** paths (session /
  read+tag user token, ownership-checked `tag_session`, the consent flow) and the
  **authenticated instance attestation** (the stored binding; the instance id
  on an event is a claim, see R7 in [Security Overview](Security-Overview.md)) — never from a `project` / `email` /
  `activity` value that arrived over OTel.

A leaked emit token can therefore **spoof telemetry** (handled below) but can
**never** read, tag, or act.

### Detection — authenticated-heartbeat coverage + quarantine

Each successful `/bearer` mint stamps `instance_attestation.last_bearer_at` — an
**authenticated heartbeat**: evidence that a valid emit credential for that
instance was presented at time T (the owner's, unless it was stolen). The mint requires the owner's OAuth
`tokenscope.emit` token *bound to that instance* — checked at use, not merely
recorded at mint (see the bearer section above) — so a **cross-instance spoofer
cannot mint a bearer for a victim's instance.**

A background worker (`server/workers/heartbeat-coverage.ts`, table
`session_quarantine`, migration `0032`) computes per session whether the emitted
spend window `[MIN(ts_event), MAX(ts_event)]` is **covered** by the owner's
authenticated-live window `[ts_start, COALESCE(ts_actual_end, last_bearer_at) +
grace]` (grace ~35 min, comfortably over the ~29-min refresh cadence). Spend with
**no covering heartbeat** is flagged **QUARANTINED / "unverified spend"** and
surfaced at `GET /api/v1/me/quarantined-spend` (teammate-scoped: `requireAuth` +
RLS + an explicit `teammate_id` filter) and to the reconciliation reviewer.

- **Catches:** the **cross-instance spoof** — records claiming a victim's
  `instance_id` written by someone who cannot mint that instance's bearer → no
  covering heartbeat → quarantined **early**, before reconciliation (which lags
  ~1h+).
- **Does NOT catch:** full emit-credential **theft** — if the attacker steals the
  victim's emit credential, *their* `/bearer` mints stamp a heartbeat **as the
  victim**, so the spend looks covered. That residual stays on **revoke** (revoke
  the leaked grant) **+ reconcile** (theft-inflated spend far above real API
  usage is flagged for the owner's review; it never changes a billed total,
  though it can shift the project split of the victim's own billed cost; see
  [Attributed and Billed](Attributed-and-Billed.md)).
- **Quarantine is INFORMATIONAL ONLY** — it **never** auto-revokes or
  auto-deletes; it is early-warning + an audit trail (a `spend-quarantined` audit
  event on first detection, explicitly tagged non-enforcement). Nothing deletes
  attributed spend automatically: an owner's quarantine is what removes a session
  from attributed figures. A historical-data
  guard (`last_bearer_at IS NULL`) excludes instances that never minted a heartbeat
  so spend from an instance with no heartbeat history is never quarantined.

### Reconcile + revoke

**Reconcile** against the provider's per-person figures is the **truth /
backstop**: billed figures come from the provider alone, so the wire never
reaches what is charged, and attributed telemetry far above the provider figure
is flagged for review. It is not deleted. See
[Attributed and Billed](Attributed-and-Billed.md). **Revoke** ends an emit grant
(user self-service or admin); revoking it ends the instance's emission via the
revoke ↔ instance cascade (sets `ts_actual_end`). Detection (quarantine /
went-silent) **feeds** the revoke decision — it never performs it.

## Internal worker trigger (machine-to-machine HMAC)

![A worker trigger runs only with a fresh, valid HMAC signature over the exact request, and every authentication failure looks the same](images/authentication-and-security-worker-hmac.svg)

1. `scripts/cron-trigger.mjs` signs `{timestamp}\n{METHOD}\n{path}\n{sha256(body)}` with HMAC-SHA256. The body is `{}`, or `{"deepRescan":true}` when the job runs with `DEEP_RESCAN=true`.
2. It posts to `/api/v1/internal/run-worker/{name}` with `X-Internal-Timestamp` (unix seconds) and `X-Internal-Signature` (hex).
3. With `frontDoorId` set, `require-front-door` refuses a request without the matching `X-Azure-FDID` header (403), which is why the jobs then call the Front Door endpoint.
4. The request reaches the run-worker handler.
5. `verifyInternalRequest` accepts a timestamp within 60 seconds of the server clock and compares the signature in constant time.
6. Missing, malformed, stale and wrong signatures all get the same 401.
7. The handler looks the name up in the static worker registry.
8. An unknown name gets 404 before any worker code loads.
9. `dispatchWorker` allows one run per worker at a time. While a run is in progress, a second dispatch, a replay included, gets 409. A worker an admin has disabled is skipped.
10. The worker runs on the worker database pool.
11. It returns its result.
12. The handler responds with `{ worker, duration_ms, result }`.
13. The job exits 0 on success or on a 409 already-running, and 1 otherwise. It gives up after 200 seconds, below the job's 240-second replica timeout.

*The signature binds the method, path and body to a 300-second window; inside that window a replay is accepted, and the single-run lock only stops it running alongside the original.*

- `verifyInternalRequest` (`server/auth/internal-request.ts`). Key `NUXT_INTERNAL_WORKER_HMAC_KEY` is **deliberately separate** from `NUXT_HMAC_SESSION_KEY` — blast-radius separation (leaked worker key can't replay user sessions, vice-versa).
- Both keys require ≥32 chars and ≥3.5 bits/byte Shannon entropy (long-but-trivial keys rejected).

## CSRF protection

`assertSameOrigin` (`server/auth/csrf.ts`) on `POST`/`PUT`/`PATCH`/`DELETE`:

| Origin / Referer | Result |
|---|---|
| Present + mismatched | `403` |
| Present + matching | allowed |
| Both absent | allowed (server-to-server / CLI / curl don't ride a stolen browser cookie) |

- Matters because the OIDC cookie is `sameSite=lax` (blocks cross-site XHR, not top-level form POSTs).
- **Expected origin is the PUBLIC origin**, resolved through the single chokepoint `getPublicRequestURL` (`server/utils/public-url.ts`) — the same function CSRF, the bearer/OTLP endpoints, and the OAuth metadata all route through. Resolution order:
  1. **Pinned `appPublicOrigin`** (`APP_PUBLIC_ORIGIN`) — when an upstream WAF/proxy fronts the app under a fixed hostname, the app **pins its public origin from config**. This is deliberately independent of `Host`/`X-Forwarded-*`, so same-origin matching is correct **whether the proxy preserves or rewrites the `Host` header** — no reliance on the WAF forwarding the original Host.
  2. **`X-Forwarded-Host`** — honoured **only when `AZURE_FRONT_DOOR_ID` is set** (the same gate as `require-front-door`, inside which every request already carries a matching `X-Azure-FDID`, so the forwarded header is trustworthy). Trusting it otherwise would allow header-injection origin forgery. Even inside that gate the **last** hop is taken, never the first: each proxy *appends* its own value, so hop 1 is whatever the client sent and hop N is what Front Door itself set. (h3's own `xForwardedHost` option takes hop 1, which is why this is resolved by hand.)
  3. Otherwise the request's own Host (local dev / no proxy).
- **Scheme**: `X-Forwarded-Proto` is honoured **only when `AZURE_FRONT_DOOR_ID` is set** (off that chain the header is caller-supplied, and a spoofed `http` would downgrade the expected origin). Otherwise the scheme is `https`, because TLS always terminates upstream of this process (`connection.encrypted` is structurally false inside the container); only a loopback host keeps the request's own `http` scheme, for local dev. The two cacheable discovery documents (`/.well-known/oauth-authorization-server`, `/.well-known/oauth-protected-resource`) send `Vary: X-Forwarded-Host, X-Forwarded-Proto, Host` so a shared cache in front of them cannot serve one origin's issuer to another's client.
- **WAF-fronted deployments** (no Front Door): set `appPublicOrigin` to the public hostname the WAF exposes. Same-origin validation then uses the user-facing origin, not the internal Container Apps FQDN — with no dependency on the WAF's Host-forwarding behaviour. Without it, CSRF falls back to the request's own `Host`.
- **Emit credentials need a trusted origin.** The public origin is baked into every device's durable emit credential and the OAuth issuer, so `/setup/enroll`, `/setup/redeem` and the emit-bundle builder (`server/auth/emit-provision.ts`) call `assertTrustedPublicOrigin` (`server/utils/public-url.ts`). The origin counts as trusted only when `APP_PUBLIC_ORIGIN` is pinned, when `AZURE_FRONT_DOOR_ID` is set **and** the request carries `X-Forwarded-Host`, or when the host is loopback (local dev). Otherwise the app **refuses to issue the credential** (`500 Server Misconfigured`, "Set APP_PUBLIC_ORIGIN") rather than bake a host developers cannot reach.
- Token-is-auth endpoints (`/setup/redeem`, `/bearer`) and the cookieless OAuth endpoints (`/oauth/token`, `/oauth/register`, `/oauth/revoke`) have **no** CSRF check — they carry no cookie. (The cookie-bearing `POST /oauth/authorize` consent grant **does** assert same-origin.)

## Network — edge & ingress

TokenScope supports three edge shapes, selected by `enablePrivateNetworking`,
`enableFrontDoor` / `frontDoorSku`, and `frontDoorId` (→ `AZURE_FRONT_DOOR_ID`):

**Front Door Standard (sandbox).** The Container App ingress stays **public**
(Standard cannot reach an internal environment). The **header check** below is
the only thing keeping callers on Front Door, and it is not a network boundary:
the Front Door ID is not a secret, so a direct caller who has it skips the WAF.
App authentication still applies. Fine for an example deployment; use the VNet
posture for production.

**Front Door Premium (VNet-integrated, recommended for production).** The ACA
environment is **internal**; Front Door reaches it over **Private Link**, so the
app is not reachable from the internet except through Front Door's WAF. The
**header check** still applies once `frontDoorId` is set.

**Your own WAF (VNet-integrated, no Front Door).** The network perimeter (VNet +
your WAF/edge) is the edge control:

- The ACA environment is **internal** (private VIP), not publicly reachable. Your
  WAF is the public entrypoint; traffic reaches the app over the VNet, so the
  `*.azurecontainerapps.io` FQDN is not exposed to the internet.
- `require-front-door` middleware (`server/middleware/require-front-door.ts`) is
  **inert**: `AZURE_FRONT_DOOR_ID` is unset, so it is a deliberate no-op. The
  network perimeter (internal ingress + WAF), not a header check, is the edge
  control here.

**The header check** (`require-front-door`):

- When `AZURE_FRONT_DOOR_ID` is populated, the middleware rejects any request
  lacking a matching `X-Azure-FDID` header (the AFD instance ID injected by Front
  Door) with `403`.
- **Phased** via `AZURE_FRONT_DOOR_ID`: unset/empty (first applies, or no Front
  Door) → deliberate no-op; populated → enforces.
- `AZURE_FRONT_DOOR_REQUIRED=true` overrides the no-op: with the flag set and no
  FDID wired, the middleware **refuses every request** except `EXCLUDED_PATHS`.
  It lets an operator close the window before `frontDoorId` is known without the
  middleware ever *inferring* "this looks like production". No template sets
  it: it has to be set on the revision by hand, and the next apply drops it.
- `/api/health` is **exempt** — Container Apps' internal LB probes it directly (blocking it would loop-restart replicas).
- Plain equality compare (the AFD ID is not a secret: it is in deployment outputs, workflow inputs and parameter files); logs record only path + a coarse header-present signal, never the expected/received ID.
- With `frontDoorId` set, the rate limiter keys on Front Door's `X-Azure-SocketIP`
  (`NUXT_SECURITY_RATE_LIMITER_IP_HEADER`), the TCP peer Front Door saw, instead
  of the spoofable first `X-Forwarded-For` hop. Not `X-Azure-ClientIP`, which
  follows a caller's `X-Forwarded-For`.

## Audit logging

- All security-relevant actions go through `recordAuditEvent` (`server/db/audit.ts`), the single allocation point for the **append-only** `audit_event` table. A DB trigger blocks `UPDATE`/`DELETE` — written rows are immutable. Handlers must never insert directly.
- Events: `teammate-jit-created`, `session-attested`, `emit-handoff-minted`, `emit-provisioned`, `persona-impersonation`, `report-access-granted`, `report-access-revoked` (incl. an `expired-superseded` reason on an automatic re-grant supersede), `report-scope-denied` (payload carries `permissions`), `project-manager-granted` / `project-manager-revoked`, admin mutations (incl. grant revocation). Writes a PM makes on their own project record `via: 'project-manager'` in the payload. Each row carries actor (teammate id or system), subject, payload, optional IP / user-agent.

## Known gaps

Each of these has a disposition in the [Security Overview](Security-Overview.md)
risk register; this is the mechanism-level view of the same list.

- **CSP `style-src` allows `'unsafe-inline'`** (`nuxt.config.ts`) — baseline gap `@nuxt/ui` v4 requires for injected styles. Rest of CSP is tighter: `frame-ancestors 'none'` (clickjacking — never iframed by design), constrained `img-src`/`font-src`.
- **Origin enforcement depends on configuration.** The header check runs only once `frontDoorId` is set; until then (and in the own-WAF shape) the network perimeter is the control, and nuxt-security's global rate limiter stays keyed on the first `X-Forwarded-For` hop, which a caller can spoof. On the public sandbox posture with Front Door Standard there is no network perimeter: between the apply that adds Front Door and the one that sets `frontDoorId` the app is reachable directly, and afterwards a direct caller holding the (non-secret) Front Door ID still skips the WAF and chooses the `X-Azure-SocketIP` the limiter keys on. Accepted for the example deployment.
- **Postgres connections encrypt but do not authenticate the server.** The `verify-full` change and a single connection factory are in code and the pre-flight **warns**; it takes effect only on an apply of `main.bicep` that rewrites the `DATABASE_URL` secret.
- **The anonymous OAuth registration ceiling is per-process.** The per-source sliding window is an in-memory counter, so it is one ceiling per replica, not one per deployment. The global client cap and the 1-hour abandonment sweep are what actually bound it.
- **A live emit handoff code appears in the agent transcript** for its ~5-minute, single-use, instance-bound life. That is the accepted cost of keeping the *durable* credential out of the LLM channel entirely.
