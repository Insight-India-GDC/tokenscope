#!/usr/bin/env bash
# Wait for a running TokenScope deployment to finish, approving Azure Front
# Door Premium's Private Link request on the Container Apps environment when it
# appears.
#
# Front Door's origin does not finish provisioning until that request is
# approved, so approval has to happen WHILE the apply runs. Start the apply with
# --no-wait, then run this:
#
#   az deployment group create -g "$RG" --template-file infra/main.bicep \
#     --parameters "$PARAMS" --no-wait
#   infra/scripts/approve-front-door-private-link.sh "$RG"
#
# Exits 0 when the deployment succeeded, non-zero (with the error) when it did
# not, and 3 when the only failure is a never-started Container App's missing
# image (MANIFEST_UNKNOWN): the expected end of a first apply, before any image
# has been pushed. Resources that depend on the app were skipped, so the next
# apply after the image exists creates them. Exits 4 when every failed
# operation failed only with an Azure platform error (InternalError, a 5xx, a
# timeout, Conflict, AnotherOperationInProgress) and none names the template
# or its inputs: the same apply can simply be run again (the template is
# idempotent). Also 4 when the deployment succeeded but the Front Door
# endpoint still does not serve the app after 30 minutes: a new Private Link
# endpoint can answer Front Door's own 404 for longer than that (35 minutes
# once), and running the apply again re-approves the connection and waits
# again, with a fresh sign-in. With Private Link it then waits for the Front Door endpoint to serve the
# app, and fails if it never does. A deployment without Front Door Premium on a
# VNet just waits.
#
# Microsoft documents one Front Door private endpoint per Private Link origin
# (location, resource and group); changing any of them files another. The
# request message is not secret (the Front Door ID it hashes is a deployment
# output and often sits in a committed parameter file) and anyone can name a
# resource group eafd-*, so neither tells Front Door's request apart from one an
# outsider files against this environment. So a Pending request carrying this
# deployment's message from an eafd-* group is approved only when it is the
# only one, it was not already Pending when this script started, and no
# connection is Approved with this deployment's message (old or new). Anything
# else stops the script, listing every such connection with the command that
# approves one by hand and keeps the message, for an operator to decide. That
# narrows an outsider to a request filed during the apply, before Front Door's,
# and then the script still stops when Front Door's arrives. Re-approval touches
# only connections that are already Approved, never one an operator Rejected; it
# also accepts the message releases before 1.0.4 wrote. Uses the Container
# Apps API: the generic `az network private-endpoint-connection` commands report
# a stale status for this resource type.
set -euo pipefail

RG="${1:?usage: $0 <resource-group> [deployment-name]}"
DEPLOYMENT="${2:-main}"
API=2025-07-01
CDN_API=2024-02-01
# APPROVE_TIMEOUT_MIN shortens the wait, so that three attempts of an apply
# fit in one GitHub-hosted job (six hours).
TIMEOUT_MIN="${APPROVE_TIMEOUT_MIN:-90}"

# Deployment state; empty while it does not exist yet. Any other CLI error
# (expired login, throttling, missing permission) is shown, not swallowed.
state() {
  local out
  if out=$(az deployment group show -g "$RG" -n "$DEPLOYMENT" --query properties.provisioningState -o tsv 2>&1); then
    printf '%s' "$out"
  elif printf '%s' "$out" | grep -q 'DeploymentNotFound'; then
    printf ''
  else
    echo "az error reading deployment $DEPLOYMENT: $out" >&2
    printf 'Error'
  fi
}
param() { az deployment group show -g "$RG" -n "$DEPLOYMENT" --query "properties.parameters.$1.value" -o tsv 2>/dev/null || true; }

# The deployment exists moments after `create --no-wait` returns.
for _ in $(seq 1 30); do s0=$(state); [ -n "$s0" ] && [ "$s0" != Error ] && break; sleep 5; done
[ -n "$s0" ] && [ "$s0" != Error ] || { echo "Deployment '$DEPLOYMENT' not readable in $RG" >&2; exit 1; }

PRIVATE_LINK=0
if [ "$(param enableFrontDoor)" = "true" ] && [ "$(param frontDoorSku)" = "Premium" ] \
   && [ "$(param enablePrivateNetworking)" = "true" ]; then
  PRIVATE_LINK=1
  echo "Front Door Premium over Private Link: approving its request when it appears."
fi

# Every private endpoint connection on the environment, one per line:
# name, status, private endpoint id, description (tab-separated; description
# last because it is free text). Tab is whitespace to `read`, so an empty field
# would shift the rest: nulls become "-".
connections() {
  az rest --method get \
    --url "https://management.azure.com$ENV_ID/privateEndpointConnections?api-version=$API" \
    --query "value[].[name, properties.privateLinkServiceConnectionState.status, properties.privateEndpoint.id || '-', properties.privateLinkServiceConnectionState.description || '-']" \
    -o tsv 2>/dev/null || true
}

# Front Door's own private endpoints live in Microsoft-managed resource groups
# named eafd-<...>.
front_door_endpoint() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    */resourcegroups/eafd-*) return 0 ;;
    *) return 1 ;;
  esac
}

# Our message, or the one releases before 1.0.4 wrote on approval.
ours() {
  [ "$1" = "$MESSAGE" ] || [ "$1" = "$LEGACY_MESSAGE" ]
}

# The hand-approval command for one connection. It sets this deployment's
# message as the description: a portal or `az network` approval replaces it,
# and this script would no longer recognise the connection.
approve_command() {
  printf "az rest --method put --url 'https://management.azure.com%s/privateEndpointConnections/%s?api-version=%s' --body '{\"properties\":{\"privateLinkServiceConnectionState\":{\"status\":\"Approved\",\"description\":\"%s\",\"actionsRequired\":\"None\"}}}'" "$ENV_ID" "$1" "$API" "$MESSAGE"
}

approve() {
  az rest --method put \
    --url "https://management.azure.com$ENV_ID/privateEndpointConnections/$1?api-version=$API" \
    --body "{\"properties\":{\"privateLinkServiceConnectionState\":{\"status\":\"Approved\",\"description\":\"$MESSAGE\",\"actionsRequired\":\"None\"}}}" \
    -o none
}

# Re-approve every connection already Approved with our message. Idempotent; a
# new endpoint has been seen to keep answering 404 until the connection was
# approved again. A Rejected connection is left alone.
reapprove() {
  local name status pe desc
  while IFS=$'\t' read -r name status pe desc; do
    [ -n "$name" ] && [ "$status" = Approved ] && ours "$desc" || continue
    approve "$name" || true
  done < <(connections)
}

# Front Door answers its own 404 until the new configuration reaches its edge.
# Wait for the app to answer through it; fail if it has not after 30 minutes.
wait_for_endpoint() {
  local host code i
  host=$(az deployment group show -g "$RG" -n "$DEPLOYMENT" \
    --query properties.outputs.frontDoorEndpointFqdn.value -o tsv 2>/dev/null || true)
  [ -n "$host" ] || return 0
  reapprove
  for i in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w "%{http_code}" --max-time 15 "https://$host/api/health" || true)
    if [ "$code" = "200" ]; then echo "Front Door serves the app: https://$host"; return 0; fi
    [ $((i % 10)) -eq 0 ] && reapprove
    echo "Front Door endpoint: HTTP ${code:-none}; waiting for it to start routing..."
    sleep 30
  done
  echo "https://$host/api/health still does not answer 200 after 30 minutes: the deployment succeeded but Front Door is not serving the app yet. Running the same apply again re-approves the connection and waits again; if it never serves, check the route and origin." >&2
  return 1
}

# Every failed operation below the deployment, recursing into modules, as
# "<resource type>\t<resource name>\t<status message>". A failed module with
# no failed operation of its own is reported as itself, and an unreadable
# operation list as "unreadable", so neither can pass for a missing image.
# az's stderr is kept apart: a warning on a successful read is not a row.
failed_leaves() {
  local out err type name msg found=0
  err=$(mktemp)
  if ! out=$(az deployment operation group list -g "$RG" -n "$1" \
      --query "[?properties.provisioningState=='Failed'].[properties.targetResource.resourceType, properties.targetResource.resourceName, to_string(properties.statusMessage)]" \
      -o tsv 2>"$err"); then
    printf 'unreadable\t%s\t%s\n' "$1" "$(cat "$err")"; rm -f "$err"; return
  fi
  rm -f "$err"
  while IFS=$'\t' read -r type name msg; do
    [ -n "$type$name" ] || continue
    found=1
    if [ "$type" = Microsoft.Resources/deployments ]; then failed_leaves "$name"
    else printf '%s\t%s\t%s\n' "$type" "$name" "$msg"; fi
  done <<< "$out"
  [ "$found" = 1 ] || printf 'deployment\t%s\tfailed with no failed operation\n' "$1"
}

# The expected end of a first apply: the ONLY failure is the Container App
# not finding its image, and that app has never had a ready revision. An app
# that has served before and now cannot find its image is a real failure.
first_apply_without_image() {
  local leaves app ready
  leaves=$(failed_leaves "$DEPLOYMENT")
  [ "$(printf '%s\n' "$leaves" | grep -c .)" = 1 ] || return 1
  IFS=$'\t' read -r type app msg <<< "$leaves"
  [ "$type" = Microsoft.App/containerApps ] && [[ "$msg" == *MANIFEST_UNKNOWN* ]] || return 1
  ready=$(az containerapp show -g "$RG" -n "$app" --query properties.latestReadyRevisionName -o tsv) || return 1
  [ -z "$ready" ]
}

# Azure error codes that say the platform failed, not the request. Anything
# else (InvalidTemplate, BadRequest, a missing or invalid parameter, quota)
# names the template or its inputs, and running it again would fail the same
# way. The generic wrappers around a resource's own error are ignored.
PLATFORM_CODES='InternalError|InternalServerError|ServiceUnavailable|BadGateway|GatewayTimeout|Timeout|OperationTimedOut|RequestTimeout|Conflict|AnotherOperationInProgress|TooManyRequests|RetryableError'
WRAPPER_CODES='DeploymentFailed|ResourceDeploymentFailure'
# $1 = a status message; prints each "code" in it, wrappers dropped. Also
# reads codes nested in an escaped string ({\"code\":\"X\"}), which is how a
# resource's own error often arrives inside a generic one, with escaped
# whitespace (\n) around the colon. A code it cannot read (null, a number,
# empty) prints "?", which is never a platform code, so it fails closed.
error_codes() {
  printf '%s' "$1" \
    | grep -oE '\\*"code\\*"( |\\[nrt])*:( |\\[nrt])*(\\*"[^"\\]*|[^,}]*)' \
    | sed -E 's/^\\*"code\\*"( |\\[nrt])*:( |\\[nrt])*//' \
    | sed -E 's/^\\*"([^"\\]*)\\*"?$/\1/; t; s/.*/?/' | sed -E 's/^$/?/' \
    | grep -vxE "$WRAPPER_CODES" || true
}
# True when there is at least one failed operation and every one of them
# carries only platform codes. An unreadable operation list, a failed module
# with no failed operation, or a message with no code is not.
platform_errors_only() {
  local type name msg codes n=0
  while IFS=$'\t' read -r type name msg; do
    [ -n "$type$name" ] || continue
    case "$type" in unreadable|deployment) return 1 ;; esac
    codes=$(error_codes "$msg")
    [ -n "$codes" ] || return 1
    printf '%s\n' "$codes" | grep -qvxE "$PLATFORM_CODES" && return 1
    n=$((n + 1))
  done <<< "$1"
  [ "$n" -gt 0 ]
}
platform_codes() {  # $1 = failed_leaves output; the distinct codes, comma-separated
  local type name msg
  while IFS=$'\t' read -r type name msg; do error_codes "$msg"; done <<< "$1" | sort -u | paste -sd, - | sed 's/,/, /g'
}

# Requests already Pending when this script started. On a first apply Front
# Door has not filed yet; on a re-apply its connection is already Approved. So
# none of these is approved automatically. An environment that does not exist
# yet has none; a read that fails is not "none", so it stops the script.
# One exception, for a retry after exit 4: with APPROVE_CARRY set to a file,
# an attempt that exits 4 writes there the one request it saw Front Door file
# during that attempt (Pending, from an eafd-* endpoint, this deployment's
# message, the only one, not pending before), and the next attempt does not
# count that exact request as pending before. Nothing else changes.
fresh=""
# The template's profile is fd-<project>-<env>-<region>; other Front Door or
# CDN profiles in the group are ignored. The request message is read from the
# origin the template created, which exists once Front Door has filed its
# request.
read_origin() {
  PROFILE_ID=$(az resource list -g "$RG" --resource-type Microsoft.Cdn/profiles --query "[?starts_with(name, 'fd-')] | [0].id" -o tsv 2>/dev/null || true)
  ENV_ID=$(az resource list -g "$RG" --resource-type Microsoft.App/managedEnvironments --query "[0].id" -o tsv 2>/dev/null || true)
  MESSAGE=""
  LEGACY_MESSAGE="TokenScope Front Door ${PROFILE_ID##*/}"
  if [ -n "$PROFILE_ID" ]; then
    MESSAGE=$(az rest --method get \
      --url "https://management.azure.com$PROFILE_ID/originGroups/og-tokenscope/origins/origin-tokenscope?api-version=$CDN_API" \
      --query properties.sharedPrivateLinkResource.requestMessage -o tsv 2>/dev/null || true)
  fi
}
carry() {
  [ -n "${APPROVE_CARRY:-}" ] || return 0
  # Front Door may have filed between the last poll and the failure: look once
  # more, by the same rules as an approval.
  [ -n "$fresh" ] || [ "${PRIVATE_LINK:-0}" != 1 ] || read_origin
  if [ -z "$fresh" ] && [ "${PRIVATE_LINK:-0}" = 1 ] && [ -n "${MESSAGE:-}" ] && [ -n "${ENV_ID:-}" ]; then
    local name status pe desc found=() mine=0
    while IFS=$'\t' read -r name status pe desc; do
      [ -n "$name" ] && ours "$desc" || continue
      [ "$status" = Approved ] && mine=1
      [ "$status" = Pending ] && [ "$desc" = "$MESSAGE" ] && [[ "$before" != *" $name "* ]] \
        && front_door_endpoint "$pe" && found+=("$name")
    done < <(connections)
    [ "$mine" = 0 ] && [ "${#found[@]}" -eq 1 ] && fresh="${found[0]}"
  fi
  if [ -n "$fresh" ]; then printf '%s\n' "$fresh" > "$APPROVE_CARRY"; else rm -f "$APPROVE_CARRY"; fi
}
before=" "
snapshot() {
  local env list name status
  env=$(az resource list -g "$RG" --resource-type Microsoft.App/managedEnvironments --query "[0].id" -o tsv 2>/dev/null) || return 1
  [ -n "$env" ] || return 0
  ENV_ID=$env
  list=$(az rest --method get \
    --url "https://management.azure.com$ENV_ID/privateEndpointConnections?api-version=$API" \
    --query "value[].[name, properties.privateLinkServiceConnectionState.status, properties.privateEndpoint.id || '-', properties.privateLinkServiceConnectionState.description || '-']" \
    -o tsv 2>/dev/null) || return 1
  while IFS=$'\t' read -r name status _; do
    [ "$status" = Pending ] && before="$before$name "
  done <<< "$list"
  return 0
}
if [ "$PRIVATE_LINK" = 1 ]; then
  ok=0
  for _ in 1 2 3; do snapshot && { ok=1; break; }; sleep 10; done
  if [ "$ok" != 1 ]; then
    echo "Could not read the environment's private endpoint connections, so requests already pending cannot be told from Front Door's. Nothing was approved; run this script again." >&2
    exit 1
  fi
  if [ -n "${APPROVE_CARRY:-}" ] && [ -s "$APPROVE_CARRY" ]; then
    carried=$(head -n1 "$APPROVE_CARRY")
    if [ -n "$carried" ] && [[ "$before" == *" $carried "* ]]; then
      before="${before/ $carried / }"
      # Kept, so that if this attempt also exits 4 first, the next keeps it too.
      fresh="$carried"
      echo "Retry: $carried was filed by Front Door during the previous attempt, so it may be approved."
    fi
  fi
  [ -z "${APPROVE_CARRY:-}" ] || rm -f "$APPROVE_CARRY"
fi

approved=0
errors=0
sent=" "   # requests already approved; the listing can lag an approval by minutes
deadline=$(( $(date +%s) + TIMEOUT_MIN * 60 ))
while :; do
  if [ "$PRIVATE_LINK" = 1 ]; then
    read_origin
    if [ -n "$MESSAGE" ] && [ -n "$ENV_ID" ]; then
      candidates=()
      held=()   # connections Approved with this deployment's message, old or new
      while IFS=$'\t' read -r name status pe desc; do
        [ -n "$name" ] && ours "$desc" || continue
        if [ "$status" = "Approved" ]; then
          approved=1
          held+=("$name  $pe")
        elif [ "$status" = "Pending" ] && [ "$desc" = "$MESSAGE" ] && [[ "$sent" != *" $name "* ]]; then
          # The old message is guessable: a new request on it is never approved.
          if front_door_endpoint "$pe"; then
            candidates+=("$name  $pe")
          else
            echo "Not approving $name: it carries the request message but its private endpoint is not in a Front Door managed group ($pe). If it is Front Door's, approve it with: $(approve_command "$name")" >&2
          fi
        fi
      done < <(connections)
      name=""
      if [ "${#candidates[@]}" -gt 0 ]; then name="${candidates[0]%%  *}"; fi
      if [ "${#candidates[@]}" -eq 1 ] && [ "${#held[@]}" -eq 0 ] && [ "$sent" = " " ] \
         && [[ "$before" != *" $name "* ]]; then
        fresh="$name"
        # Retried on the next poll if Azure refuses it transiently (409/429).
        if approve "$name"; then
          echo "Approved Front Door's private endpoint request $name"
          sent="$sent$name "
          approved=1
        else
          echo "Approving $name failed; retrying on the next poll" >&2
        fi
      elif [ "${#candidates[@]}" -gt 0 ]; then
        {
          echo "Not approving: Front Door files one request for this origin, and this one is not the only candidate (another is pending or approved, or it was pending before this apply started). Something else may have filed a request against the environment, and the order they arrived in does not show which is Front Door's: its private endpoint is in a Microsoft-managed subscription, an outsider's is in their own. Check each, reject any that is not Front Door's, approve Front Door's with the command below, then run this script again."
          echo "Pending:"
          for c in "${candidates[@]}"; do
            printf '  %s\n    %s\n' "$c" "$(approve_command "${c%%  *}")"
          done
          if [ "${#held[@]}" -gt 0 ]; then
            echo "Already approved:"
            printf '  %s\n' "${held[@]}"
          fi
          echo "The deployment is still running."
        } >&2
        exit 1
      fi
    fi
  fi

  s=$(state)
  case "$s" in
    Succeeded)
      if [ "$PRIVATE_LINK" = 1 ] && [ "$approved" = 0 ]; then
        echo "Deployment succeeded but no approved Front Door Private Link was found" >&2; exit 1
      fi
      echo "Deployment $DEPLOYMENT succeeded."
      if [ "$PRIVATE_LINK" = 1 ]; then wait_for_endpoint || { carry; exit 4; }; fi
      exit 0 ;;
    Error)
      errors=$((errors + 1))
      [ "$errors" -lt 10 ] || { echo "Giving up after repeated errors reading the deployment" >&2; exit 1; } ;;
    Failed|Canceled)
      if [ "$s" = Failed ] && first_apply_without_image; then
        echo "Deployment $DEPLOYMENT stopped at the Container App: the registry has no image yet (MANIFEST_UNKNOWN). Expected on the first apply. Build and roll the image, then apply again: the resources that depend on the app (alerts, worker jobs, Front Door) are created by that apply." >&2
        exit 3
      fi
      echo "Deployment $DEPLOYMENT $s:" >&2
      az deployment group show -g "$RG" -n "$DEPLOYMENT" --query properties.error -o json >&2 || true
      # The error above names only the module that failed ("front-door ...
      # terminal provisioning state 'Failed'"). The resource inside it, and
      # Azure's reason, are in the deployment operations.
      leaves=$(failed_leaves "$DEPLOYMENT")
      echo "Failed operations (resource type, name, Azure's message):" >&2
      printf '%s\n' "$leaves" | sed 's/^/  /' >&2
      if [ "$s" = Failed ] && platform_errors_only "$leaves"; then
        echo "Only Azure platform errors ($(platform_codes "$leaves")): the same apply can be run again." >&2
        carry
        exit 4
      fi
      exit 1 ;;
  esac
  [ "$(date +%s)" -lt "$deadline" ] || { echo "Timed out waiting for deployment $DEPLOYMENT" >&2; exit 1; }
  sleep 20
done
