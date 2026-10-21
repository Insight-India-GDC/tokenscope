#!/usr/bin/env bash
# Temporarily lets this runner's public IP reach a private ACR for docker push.
# Usage: acr-network-window.sh open|close <resource-group> <acr-name>
# open:  public access on, default action Deny, allow only this runner's IP.
# close: remove the IP rule and disable public access (always run this).
set -euo pipefail

ACTION="${1:?open|close}"
RG="${2:?resource group}"
ACR="${3:?registry name}"

IP=$(curl -fsS --max-time 10 https://api.ipify.org)
[[ "$IP" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "Could not determine runner IP" >&2; exit 1; }

case "$ACTION" in
  open)
    az acr update -g "$RG" -n "$ACR" --public-network-enabled true --default-action Deny --output none
    az acr network-rule add -g "$RG" -n "$ACR" --ip-address "$IP" --output none
    # Firewall changes take a short while to apply.
    for i in $(seq 1 20); do
      if az acr login --name "$ACR" >/dev/null 2>&1 && \
         az acr repository list -n "$ACR" --output none 2>/dev/null; then
        echo "ACR $ACR reachable from $IP"; exit 0
      fi
      echo "Attempt $i: waiting for ACR firewall to admit $IP"; sleep 15
    done
    echo "ACR $ACR not reachable from $IP" >&2; exit 1 ;;
  close)
    az acr network-rule remove -g "$RG" -n "$ACR" --ip-address "$IP" --output none 2>/dev/null || true
    az acr update -g "$RG" -n "$ACR" --public-network-enabled false --output none
    echo "ACR $ACR public access disabled" ;;
  *)
    echo "Unknown action '$ACTION'" >&2; exit 2 ;;
esac
