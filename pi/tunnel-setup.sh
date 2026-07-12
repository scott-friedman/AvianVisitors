#!/usr/bin/env bash
# bird — remote-admin Cloudflare Tunnel (SSH only). Phase 5.
#
# Run ON THE PI, NOT with sudo (it elevates internally for the /etc + service bits).
# Prereqs:
#   1. cloudflared installed            ->  cloudflared --version
#   2. one-time browser auth (no sudo)  ->  cloudflared tunnel login
#      Opens a URL; open it on your laptop, pick the ZONE that will own the
#      hostname below. Writes ~/.cloudflared/cert.pem. This does NOT need the
#      scoped CI API token — that token is only for GitHub Actions deploys.
#
# Usage:
#   bash tunnel-setup.sh <hostname> [tunnel-name]
#   e.g. bash tunnel-setup.sh bird-ssh.foobos.net avian-admin   # single-level subdomain (free SSL covers *.zone only)
#
# Idempotent: re-running reuses an existing tunnel of the same name.
set -euo pipefail

HOSTNAME="${1:?usage: bash tunnel-setup.sh <hostname> [tunnel-name]}"
TUNNEL_NAME="${2:-avian-admin}"
HERE="$(cd "$(dirname "$0")" && pwd)"
CFDIR="$HOME/.cloudflared"
ETC=/etc/cloudflared

command -v cloudflared >/dev/null || { echo "ERROR: cloudflared not installed."; exit 1; }
command -v jq >/dev/null || { echo "ERROR: jq not installed (sudo apt install jq)."; exit 1; }
[ -f "$CFDIR/cert.pem" ] || { echo "ERROR: run first (no sudo):  cloudflared tunnel login"; exit 1; }

name_to_uuid() {
  # jq --arg, not string-splicing into an inline script (a quote in the tunnel
  # name would break out of the literal).
  cloudflared tunnel list --output json \
    | jq -r --arg n "$TUNNEL_NAME" '[.[] | select(.name == $n)][0].id // empty'
}

# 1. tunnel (idempotent)
UUID="$(name_to_uuid)"
if [ -z "$UUID" ]; then
  echo "==> creating tunnel '$TUNNEL_NAME'"
  cloudflared tunnel create "$TUNNEL_NAME"
  UUID="$(name_to_uuid)"
else
  echo "==> reusing tunnel '$TUNNEL_NAME' ($UUID)"
fi
[ -n "$UUID" ] || { echo "ERROR: could not determine tunnel UUID"; exit 1; }
CREDS="$CFDIR/$UUID.json"
[ -f "$CREDS" ] || { echo "ERROR: credentials $CREDS missing"; exit 1; }

# 2. DNS route — REQUIRES the hostname's zone to exist in your Cloudflare account.
echo "==> routing DNS: $HOSTNAME -> $TUNNEL_NAME"
cloudflared tunnel route dns "$TUNNEL_NAME" "$HOSTNAME"

# 3. system config + credentials (root-owned, so the service finds them)
echo "==> installing $ETC/config.yml + credentials (root)"
sudo mkdir -p "$ETC"
sudo cp "$CREDS" "$ETC/$UUID.json"
sed -e "s|__TUNNEL_UUID__|$UUID|g" -e "s|__TUNNEL_HOSTNAME__|$HOSTNAME|g" \
  "$HERE/cloudflared-config.example.yml" | sudo tee "$ETC/config.yml" >/dev/null

# 4. service (boot-persistent)
echo "==> installing + starting the cloudflared service"
sudo cloudflared service install 2>/dev/null || true
sudo systemctl enable --now cloudflared
sleep 2
systemctl --no-pager status cloudflared | head -n 10 || true

cat <<NEXT

==> Pi side done (tunnel UUID $UUID). Final step (no API token, no dashboard):

Add to ~/.ssh/config on any computer you'll manage from:
   Host bird-pi
     HostName $HOSTNAME
     User inky
     ProxyCommand cloudflared access ssh --hostname %h
   Then:  ssh bird-pi   (prompts for the inky password)

Security posture: PASSWORD-GATED, no Cloudflare Access app (deliberate — usable
from any machine with cloudflared, not tied to one key/email). The tunnel hides
SSH from internet port-scanning, so the gate is a STRONG, UNIQUE inky password —
make sure it is one. (Want it tighter? Add an Access app, or switch to key auth.)
NEXT
