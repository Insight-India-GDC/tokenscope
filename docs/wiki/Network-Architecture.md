# Network Architecture

The network model for a **VNet-integrated** TokenScope deployment — the topology,
ingress/egress paths, and the Bicep switches that produce it. Everything here is
sourced from `infra/` Bicep and `server/`. Sandbox runs a simpler public shape;
this page documents the private, VNet-integrated mode.

> Siblings: [Architecture](Architecture.md) · [Security Overview](Security-Overview.md) · [Deployment & Operations](Deployment-and-Operations.md)

**At a glance**
- Deploys into a **single region** and resource group. Child resources follow
  `{kind}-tokenscope-{env}-{regionShort}` (`regionShort` derived from `location`
  in `main.bicep`).
- One **IPAM-sized VNet**: `snet-container-apps` **/27** (INTERNAL ACA env) +
  `snet-private-endpoints` **/28** (data-plane PEs) + optional `snet-ampls`
  **/28** (Azure Monitor private-query PE) + optional `snet-build` (image builds
  for a private registry). A /26 holds exactly the first three; the example
  parameter file uses a /24 so `snet-build` fits too.
- **Ingress:** the only public entrypoint is either **(a) your own WAF / App
  Gateway / reverse proxy**, routing over the VNet (or hub peering) to the
  **internal ACA private VIP**, or **(b) Azure Front Door Premium over Private
  Link** (`enableFrontDoor=true`, `frontDoorSku='Premium'`), the recommended
  production shape. Front Door Standard cannot reach an internal environment and
  the template refuses it with `enablePrivateNetworking`.
- **Data plane** (Key Vault, PostgreSQL, Redis, ACR, **and Log Analytics QUERY**):
  private endpoints, `publicNetworkAccess: Disabled`, Managed-Identity auth.
- **Telemetry INGESTION** stays Azure-Monitor-side (public DCE
  `*.ingest.monitor.azure.com`, **by design** — clients emit from outside the
  zone), **not** into the VNet. **Telemetry QUERY** (Log Analytics KQL read) is
  RBAC-protected over the public endpoint by default; `monitorQueryPrivateOnly`
  makes it **private** (AMPLS + private endpoint,
  `publicNetworkAccessForQuery: Disabled`), after the Azure Monitor privatelink
  DNS zones exist.
- **Platform logs** (Container Apps console/system logs, diagnostic settings,
  log alert rules) share the telemetry workspace by default. With
  `monitorQueryPrivateOnly` on they move to a second workspace, `log-ops-<name>`
  (`separateOpsWorkspace`, which defaults to the same value): query privacy is
  workspace-wide, and operators must be able to read crash logs from the portal.
  That workspace's query path is public and governed by Entra RBAC. The full
  picture, with the alerts that read it, is
  [Deployment and Operations § Logs and monitoring](Deployment-and-Operations.md#logs-and-monitoring).

---

## 1. Topology

![Only the edge is public: the app sits on an internal VIP and reaches its data plane through private endpoints, while devices send telemetry straight to Azure Monitor](images/network-architecture-topology.svg)

1. Users and plugins reach the edge on 443: Front Door Premium (`enableFrontDoor`, `frontDoorSku='Premium'`) or your own WAF. This is the only public entrypoint.
2. The edge forwards to the internal VIP of `cae-<name>` (`internal: true`). Front Door Premium arrives over Private Link, whose request is approved during the apply; your own WAF arrives over the VNet or a hub peering. Once `frontDoorId` is set, the app refuses requests without Front Door's `X-Azure-FDID` header.
3. The app reaches Key Vault, PostgreSQL and the Premium registry through private endpoints in `snet-private-endpoints`. Secrets resolve as Key Vault references and images pull with the user-assigned identity `id-<name>`; PostgreSQL and Redis credentials come from Key Vault. Redis is provisioned with a private endpoint, but the app has no Redis client.
4. A private registry refuses outside builds, so images are built from `snet-build` (`buildSubnetPrefix`) by a self-hosted runner or an ACR Tasks agent pool, and pushed through the registry's private endpoint.
5. The app runs its KQL against `log-<name>`. With `monitorQueryPrivateOnly` the query goes through the Azure Monitor Private Link Scope endpoint in `snet-ampls`; otherwise it uses the public query endpoint under Log Analytics Reader.
6. The environment's console and system logs go to `log-ops-<name>` by diagnostic setting when `separateOpsWorkspace` is on (it defaults to `monitorQueryPrivateOnly`). Without it they share `log-<name>`.
7. Key Vault, PostgreSQL, registry and Front Door diagnostic settings write to the same ops workspace. Redis has none.
8. Developer devices send OTLP to the public data collection endpoint, and the data collection rule writes `OTelLogs`. Telemetry never enters the VNet.

*The edge is the only public resource. Every other path stays inside the VNet or behind a private endpoint, except telemetry ingestion, which is Azure Monitor's public endpoint by design.*

The template creates the four data-plane `privatelink` zones and links them to the
VNet, or consumes them from a central hub when `centralDnsZonesSubscriptionId` and
`centralDnsZonesResourceGroup` are set. It does not create the Azure Monitor
`privatelink` zones: the AMPLS endpoint carries no DNS zone group, so whoever owns
those zones registers its records.

The network perimeter is the ingress control; the app still enforces Entra OIDC +
RBAC, per-request scope checks in the queries and CSRF on every request.
Postgres row-level security does not execute: the app connects as the table
owner ([ADR-0013](Design-Decisions.md#adr-0013--authorization-is-enforced-in-the-application); see Authentication and Security).

---

## 2. Ingress / egress / ingestion paths

| # | Source | Destination | Port / proto | Public / private | Auth / control |
|---|--------|-------------|--------------|------------------|----------------|
| I1 | Browser, plugins | (a) your WAF / edge, or (b) Front Door Premium endpoint | 443 / HTTPS | **Public** | WAF + TLS; the only public entrypoint |
| I2a | Your WAF | Internal ACA VIP | 443 / HTTPS | Private (VNet / hub) | ACA env is `internal=true`; reachable only over the VNet |
| I2b | Front Door Premium | Internal ACA VIP | 443 / HTTPS | Private (Private Link to the managed environment) | Private endpoint request approved during the apply; with `frontDoorId` set the app rejects requests without Front Door's `X-Azure-FDID` |
| E1 | App | Key Vault | 443 / HTTPS | Private (PE) | User-assigned MI, *Key Vault Secrets User*; `publicNetworkAccess: Disabled` |
| E2 | App | PostgreSQL Flexible Server | 5432 / TLS | Private (PE) | DB credentials from KV (`database-url`); `publicNetworkAccess: Disabled` |
| E3 | App | Redis | 6380 / TLS | Private (PE) | Provisioned and wired as `REDIS_URL` from KV (`redis-url`), but the app has no Redis client today; `publicNetworkAccess: Disabled` |
| E4 | App | Azure Monitor / Log Analytics (KQL read) | 443 / HTTPS | Private (PE) — AMPLS, `queryAccessMode=PrivateOnly` | MI bearer (`monitor.azure.com`), *Log Analytics Reader*; query reachable only from inside the VNet |
| P1 | ACA env | ACR image pull | 443 / HTTPS | Private (PE) | User-assigned MI, *AcrPull*; admin user disabled |
| B1 | Build in `snet-build` (self-hosted runner or ACR Tasks agent pool) | ACR push | 443 / HTTPS | Private (PE) | Builds from inside the VNet; a private registry refuses outside builds |
| G1 | Claude Code / Copilot plugin (dev laptops) | Azure Monitor DCE ingest (DCE → DCR) | 443 / HTTPS | **Public — Azure-Monitor-side, NOT into the VNet** | MI-minted Entra bearer (`monitor.azure.com/.default`), *Monitoring Metrics Publisher* on the DCR; `application/x-protobuf` |

**Telemetry note (G1):** token-usage telemetry is ingested at the **Azure Monitor
data plane (DCE/DCR), not into TokenScope's VNet**. Claude Code and the Copilot
plugin's usage extension on developer machines POST OTLP/HTTP to a Microsoft-managed public DCE. The app never
receives raw telemetry on its ingress; it *reads* it back from Log Analytics via
KQL (E4). The private VNet does not change this path.

---

## 3. Public-facing surfaces

### Public-facing endpoints (VNet-integrated mode)

The public surface is **exactly two**:

1. **App URL** — your **WAF/edge** or the **Front Door Premium** endpoint
   (inbound, public), fronting the **internal** Container App. The CA ingress
   itself is **internal-only**, not public (`vnetConfiguration.internal=true`).
2. **OTLP telemetry ingest** — the Data Collection Endpoint
   (`*.ingest.monitor.azure.com`, `publicNetworkAccess: Enabled`) — public on the
   **Azure-Monitor side**, so developer clients can emit telemetry from
   **outside** the zone. Auth = Entra MI bearer, **publish-only**
   (`Monitoring Metrics Publisher`).

Everything else — **PostgreSQL, Key Vault, Redis, ACR, AND Log Analytics QUERY**
— is private-endpoint only (`publicNetworkAccess: Disabled`).

---

The detail behind those two surfaces:

- **Entrypoint (your WAF, or Front Door) — 443 / HTTPS.** The only
  internet-reachable surface for the app.

Everything else is private:
- **ACA ingress** is an **internal VIP** (`vnetConfiguration.internal=true`) — no
  public endpoint; reachable only over the VNet via your WAF, or over Front
  Door's Private Link. App `targetPort` is
  `3000`, internal to the env.
- **Key Vault, PostgreSQL, Redis, ACR, and Log Analytics QUERY** — private
  endpoints, `publicNetworkAccess: Disabled`. (Log Analytics QUERY is fronted by
  an AMPLS + private endpoint, `queryAccessMode=PrivateOnly`; ingestion stays
  public — row G1.)
- **OTel ingestion is NOT an inbound opening on our infrastructure** — the
  clients POST over 443 to **Azure Monitor's** public DCE (row G1), an outbound concern
  for the developer machine.

---

## 4. VNet design

`infra/modules/networking.bicep`, parameterised per-env via the bicepparam file.
The subnets are sized to the Azure minimums, so the VNet can be a small block
from your IPAM.

| Element | Value | Notes |
|---|---|---|
| Address space | **`/26`** minimum; **`/24`** in `example-vnetted` | `vnetAddressSpace`. A /26 (64 addr) holds exactly a /27 + two /28s (Container Apps, private endpoints, AMPLS) with no room for `snet-build`; the example's /24 leaves room. Replace the `10.0.0.0` base with your IPAM range. |
| `snet-container-apps` | **`/27`** | Delegated to `Microsoft.App/environments`. **`/27` is the minimum for a workload-profiles ACA env.** Env is **INTERNAL** (`internal=true`). |
| `snet-private-endpoints` | **`/28`** | `privateEndpointNetworkPolicies: Disabled`. **4 PEs** — KV / PG / Redis / **ACR**. /28 = 11 usable (Azure reserves 5 of 16) → 4 + 7 spare headroom. |
| `snet-ampls` (optional) | **`/28`** | `amplsSubnetPrefix`. Dedicated subnet for the Azure Monitor Private Link Scope PE — the `azuremonitor` PE allocates several IPs (one per Monitor data-plane endpoint), overflowing the shared PE subnet, so it gets its own /28. Empty ⇒ no AMPLS subnet / PE (public query). |
| Private DNS zones | `privatelink.vaultcore.azure.net`, `privatelink.postgres.database.azure.com`, `privatelink.redis.cache.windows.net`, `privatelink.azurecr.io` (+ the AMPLS `privatelink.monitor.azure.com` set when private query is on) | One per private data-plane type. **Self-created or consumed from central** — see §6. |
| `snet-build` (optional) | e.g. **`/27`** | `buildSubnetPrefix`. For a self-hosted runner or an ACR Tasks agent pool (preview) building into the private registry. Needs outbound internet (NAT gateway or firewall route). Declare it here: the next apply removes subnets the template does not list. |
| Hub peering (optional) | `hubVnetId`; one-way spoke→hub | `allowGatewayTransit: false` on the spoke; `useRemoteGateways` only when the hub owner confirms a gateway. **The hub owner creates the reverse peering.** Address spaces must not overlap. |

**AMPLS subnet + PE (private telemetry query).** When `monitorQueryPrivateOnly`
is on, Log Analytics QUERY is fronted by an Azure Monitor Private Link Scope +
private endpoint on `snet-ampls`, with `publicNetworkAccessForQuery: Disabled`.
The `azuremonitor` PE registers A records into the `privatelink.monitor.azure.com`
zone family; ingestion (DCE) stays public by design.

**Who owns the scope.** On self-owned zones we deploy the scope and the PE. On
central zones we must not: one zone holds one set of Monitor A records, so a
second scope's PE overwrites the first's and blackholes it. `useCentralAmpls=true`
then deploys neither — the platform team joins the
workspace to their scope as a scoped resource. `centralAmplsResourceId` is the
escape hatch for a central PE our VNet cannot reach: our PE, their scope, which
also needs a VNet-scoped zone from the platform team so the two PEs stop competing for the same
record names. Gated by `tests/unit/infra/ampls-ownership.test.ts`.

**ACR (private).** Premium SKU + private endpoint + `privatelink.azurecr.io`,
public access Disabled — the 4th data-plane PE. Pull is via the user-assigned MI
(*AcrPull*); admin user disabled. Because a private registry refuses builds from
outside the VNet, images are built from `snet-build`: a self-hosted runner
(`docker build` / `docker push`) or an ACR Tasks agent pool.

---

## 5. Ports to publish

### Inbound

| Port | Where | Exposure |
|---|---|---|
| **443 / HTTPS** | (a) your WAF endpoint, or (b) the Front Door Premium endpoint | **The only internet-published port** — the entire app ingress surface. With (b) nothing is published on your network at all: Front Door reaches the app over Private Link. |

Nothing else is internet-published:
- **PostgreSQL (5432)** and **Redis (6380, TLS)** are private-endpoint-only,
  `publicNetworkAccess: Disabled` — app→data-plane egress, never published
  inbound.
- The Container App `targetPort` **3000** is internal to the ACA env, reachable
  only through the internal VIP.
- **OTel ingest is outbound-to-Azure-Monitor**, not an inbound rule on our side
  (row G1).

### Outbound 443 allow-list (developer machines)

Corporate egress must allow **outbound 443 / HTTPS** from dev laptops to:
- the app hostname your WAF or Front Door exposes — web app + plugin API calls;
- the **Azure Monitor DCE ingest** endpoint (`*.ingest.monitor.azure.com` / the
  DCR's DCE FQDN) — OTLP telemetry;
- **`login.microsoftonline.com`** — Entra sign-in;
- the **plugin marketplace** source (GitHub) — one-time plugin install.

Everything the *app* reaches (KV, PG, Redis, ACR, Azure Monitor read) is
server-side egress via Managed Identity — not a developer-machine or
inbound-firewall concern.

---

## 6. Configurable options & network coordination

1. **Entrypoint ↔ ACA path.** The app's public origin must be known either way
   (`server/utils/public-url.ts`):
   - **(a) Your WAF.** How it reaches the internal ACA VIP (VNet route / hub
     peering / private link) is an environment-integration decision.
     `AZURE_FRONT_DOOR_ID` is empty, so the app does **not** trust
     `X-Forwarded-Host`; instead it **pins its public origin** via
     `appPublicOrigin` (→ `APP_PUBLIC_ORIGIN`), so CSRF and emit credentials are
     correct **whether the WAF preserves or rewrites the `Host` header**.
   - **(b) Front Door Premium.** Once `frontDoorId` is set (→
     `AZURE_FRONT_DOOR_ID`), the app rejects requests without Front Door's
     `X-Azure-FDID` header and trusts the last `X-Forwarded-Host` hop.
     `workerBaseUrl` must then be the Front Door endpoint, because the app
     refuses direct calls; the worker jobs reach it through the environment's
     outbound internet access. Setting `appPublicOrigin` to the Front Door
     endpoint (as the example does) pins it outright.
2. **Private DNS — two modes.** `networking.bicep` supports both:
   **self-owned** (default — the module creates the four `privatelink.*` zones and
   VNet-links them; correct for standalone environments), and **central** (set
   `centralDnsZonesSubscriptionId` + `centralDnsZonesResourceGroup` — zones/links
   are **not** created; the outputs compose resource IDs of the central zones and
   the zone owner creates the VNet links). Pick the mode that matches the target
   environment's DNS ownership.
3. **Build subnet ↔ registry line-of-sight.** Set `buildSubnetPrefix` so a
   self-hosted runner or ACR Tasks agent pool in `snet-build` can reach the ACR
   private endpoint (a VM there resolves `privatelink.azurecr.io` through the
   template's zone). A runner elsewhere needs a peered network and that zone
   linked to it.
4. **Hub peering (optional).** If your network team requires spoke→hub peering for on-prem
   connectivity / central security tooling, supply: (a) the hub VNet resource ID,
   (b) a non-overlapping IPAM-assigned /26 for `vnetAddressSpace`, (c) whether the
   hub gateway carries egress (`useRemoteGateways` / `allowGatewayTransit` on the
   reverse peering).
</content>
