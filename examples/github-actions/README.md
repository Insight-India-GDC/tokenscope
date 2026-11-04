# Deploying TokenScope with GitHub Actions

Two example workflows automate [DEPLOY-AZURE.md](../../docs/DEPLOY-AZURE.md):

| Workflow | Does |
|---|---|
| `tokenscope-infra.yml` | Compiles your parameter file, previews (`what-if`) and applies `infra/main.bicep` |
| `tokenscope-deploy.yml` | Builds the image under the commit tag, rolls the Container App, waits until that commit is serving and healthy, then moves `latest`; on failure rolls back to the previous image |

They live here, not in `.github/workflows/`, so they never run in this repository.
Copy both into `.github/workflows/` in your fork.

Read DEPLOY-AZURE.md §1 first: the Azure, Entra and secrets prerequisites are the
same. This page covers only what GitHub adds.

## 1. Commit your parameter file

Copy an example and commit it, for example as
<!-- docs-check: ignore (a file you create) -->
`infra/parameters/sandbox.bicepparam` (names starting `my` are gitignored). It
holds no secrets: the example files read those from environment variables.

## 2. A deployment identity with a federated credential

The workflows sign in to Azure with OIDC; no Azure secret is stored in GitHub.

1. **Entra ID → App registrations → New registration** (a second registration,
   separate from the sign-in one), single tenant, no redirect URI.
2. **Certificates & secrets → Federated credentials → Add credential**:
   scenario *GitHub Actions deploying Azure resources*, your organisation and
   repository, entity type **Environment**, environment name `sandbox` (one
   credential per GitHub environment). The form also asks for the numeric
   **Organization ID** (the repository owner's, a user or an organisation) and
   **Repository ID**:

   ```bash
   gh api repos/<owner>/<repo> --jq '"Organization ID: \(.owner.id)  Repository ID: \(.id)"'
   ```

   Keep the subject identifier it generates.
3. Give it **Owner** on the resource group (the template creates role
   assignments):

   ```bash
   az role assignment create --assignee <application-client-id> --role Owner \
     --scope "$(az group show -n <your-rg> --query id -o tsv)"
   ```

## 3. A GitHub environment

**Settings → Environments → New environment** `sandbox` (match the federated
credential), then add:

- **Secrets**
  - `AZURE_CLIENT_ID` (the deployment registration), `AZURE_TENANT_ID`,
    `AZURE_SUBSCRIPTION_ID`
  - every variable from your secrets file (DEPLOY-AZURE.md §Secrets):
    `PG_ADMIN_LOGIN`, `PG_ADMIN_PASSWORD`, `SESSION_SECRET`, `HMAC_SESSION_KEY`,
    `INTERNAL_WORKER_HMAC_KEY`, `OIDC_SESSION_SECRET`,
    `OIDC_AUTH_SESSION_SECRET`, `OIDC_TOKEN_KEY`, `ENTRA_CLIENT_SECRET`, and any
    optional provider credentials (`ANTHROPIC_API_KEY`, `GH_PAT_*`,
    `GH_APP_KEY_*`).

  From a secrets file:

  ```bash
  set -a; . ./.azure-sandbox-secrets.env; set +a
  for name in PG_ADMIN_LOGIN PG_ADMIN_PASSWORD SESSION_SECRET HMAC_SESSION_KEY \
              INTERNAL_WORKER_HMAC_KEY OIDC_SESSION_SECRET OIDC_AUTH_SESSION_SECRET \
              OIDC_TOKEN_KEY ENTRA_CLIENT_SECRET; do
    gh secret set "$name" --env sandbox --body "${!name}"
  done
  ```
- **Variables**
  - `AZURE_RESOURCE_GROUP`: the resource group
  <!-- docs-check: ignore -->
  - `TOKENSCOPE_PARAMS`: the parameter file path, e.g. `infra/parameters/sandbox.bicepparam`
  - VNet only: `TOKENSCOPE_ACR_AGENT_POOL` (for `acr-agent-pool` builds)
  - Optional: `TOKENSCOPE_HEALTH_URL`, to check deploys at an address other
    than the app's public origin

The environment grants an identity with **Owner** on the resource group, so
restrict who can use it: **Deployment branches and tags → Selected branches →
`main`**, and add required reviewers if applies should need approval. Without
the branch rule, anyone who can push a branch can run a modified workflow
against it.

## 4. Run them

The order matches DEPLOY-AZURE.md, because the first apply cannot start the app
before an image exists:

1. **TokenScope infra**, mode `apply`. Stops at the Container App, which
   waits for its image (`MANIFEST_UNKNOWN`); the resources that depend on it
   (alerts, worker jobs, Front Door) come with the next apply. The run
   succeeds with a notice saying so; any other failure fails it, except an
   Azure platform fault (an `InternalError`, a timeout, a conflict) or a Front
   Door endpoint that is not routing yet: then the run applies again, up to
   twice, each after a fresh sign-in, and its summary says so.
2. **TokenScope deploy**: build `acr-task` (sandbox), or `docker` /
   `acr-agent-pool` (VNet). Builds the image and rolls the app, which brings up
   the Container App from step 1. `prebuilt` skips the build, for an image your
   own pipeline has already pushed as `tokenscope:<first 12 characters of the
   commit SHA>`.
3. Sandbox: set `appPublicOrigin`, `entraIdRedirectUri` and `workerBaseUrl` in
   the parameter file (DEPLOY-AZURE.md §3 step 5), commit, and run
   **TokenScope infra** `apply` again.

   VNet with Front Door Premium: set `enableFrontDoor = true` and
   `frontDoorSku = 'Premium'`, commit, run **TokenScope infra** `apply` (it
   approves Front Door's Private Link request while the apply runs), then set
   `frontDoorId` and the three host values on the Front Door endpoint, commit,
   and apply again (DEPLOY-AZURE.md §4 steps 4 and 5). Set
   `TOKENSCOPE_HEALTH_URL` to the Front Door host.

   VNet with your own WAF: create the environment's DNS zone, set
   `workerBaseUrl`, commit, and apply again (DEPLOY-AZURE.md §4, "Steps (your
   own WAF)").

Both workflows can also be called from another workflow (`workflow_call`,
with the same inputs and `secrets: inherit`). The infra workflow takes an
optional `params` input to apply a different parameter file than the
environment's `TOKENSCOPE_PARAMS`.

After that, run **TokenScope deploy** for each new version and **TokenScope
infra** when the parameter file or the templates change. `what-if` mode
previews an apply without changing anything. The two workflows share a
concurrency group per environment, so they never overlap.

`latest` only moves once a deploy has verified its commit is serving, so the
worker jobs and the next infra apply always get a build that passed. A failed
deploy (a failed roll or a failed check) returns the app to the image it ran
before: pinned by digest where the runner can read the registry, otherwise by
its tag, which is safe because deploys use unique commit tags and `latest` only
moves after a verified deploy. The first deploy has nothing to return to.

Each deploy is checked through the app's public origin (`appPublicOrigin`: the
Front Door or WAF host), so it verifies what users reach. Set
`TOKENSCOPE_HEALTH_URL` to check a different address.

## Building for a private registry (VNet)

A VNet deployment's registry accepts no public traffic, so `acr-task` cannot
push to it. Both options below build from inside the VNet: set
`buildSubnetPrefix` in the parameter file (e.g. `10.0.0.64/27`) and the template
creates `snet-build` for them. Don't add a subnet by hand: the template lists the
VNet's subnets, so the next apply removes any it does not know. The build
subnet needs outbound internet (GitHub, base images, Azure services); Azure is
retiring default outbound access for new subnets, so give it a NAT gateway or a
route through your firewall.

- **`docker`**: a self-hosted runner inside the network (or a peered one) that
  resolves `privatelink.azurecr.io` (a VM in `snet-build` does, through the
  template's DNS zone), with the Azure CLI, Docker, git and curl installed
  and **at least 8 GB of RAM**: the build alone takes a 4 GB Node heap, and a
  4 GB machine dies mid-build. Pass its label as the workflow's `runner` input.
- **`acr-agent-pool`**: an ACR Tasks agent pool in a subnet of your VNet, so
  the build runs inside the network while the workflow stays on a
  GitHub-hosted runner. Agent pools are a **preview** feature, Linux only, and
  offered in a subset of regions (not every region the rest of TokenScope
  runs in); check the region list before choosing this. The pool goes in
  `snet-build` (not the Container Apps subnet, which is delegated) and needs
  outbound access to
  the `AzureKeyVault`, `Storage`, `EventHub`, `AzureActiveDirectory` and
  `AzureMonitor` service tags and to the base-image registries, and is billed
  per vCPU while it has nodes. Create it once:

  ```bash
  az acr agentpool create --registry <acr> --name tokenscope-builds --tier S1 \
    --subnet-id "$(az deployment group show -g <rg> -n main \
      --query properties.outputs.buildSubnetId.value -o tsv)"
  ```

  Set `TOKENSCOPE_ACR_AGENT_POOL` to the pool name.

The deploy workflow confirms a build through Azure's view of the revision
(it runs the new image, its health probes pass, it serves traffic), which needs
no network path to the app. On a VNet deployment, also set
`TOKENSCOPE_HEALTH_URL` to an address the runner can reach, such as the Front
Door endpoint, to add an end-to-end check.
