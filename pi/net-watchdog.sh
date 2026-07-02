#!/usr/bin/env bash
# avian net-watchdog — self-heal the network path (wifi -> tunnel -> Cloudflare).
# Run by avian-net-watchdog.timer every ~5 min.
#
# The heartbeat makes a dead network VISIBLE (UptimeRobot alerts), but nothing
# FIXES it — and with the box 30 miles away behind an outbound-only tunnel, a
# wedged wifi association / wpa_supplicant / DNS was the one failure that still
# meant "call Dad". The hardware watchdog doesn't cover it (the kernel is healthy).
#
# Probe: curl TWO independent HTTPS endpoints (our Worker on the Cloudflare edge
# + Google's connectivity check). ANY success = online, so a single-vendor cloud
# outage can't false-alarm; both failing means it's almost certainly our net.
# Full HTTPS-by-hostname on purpose: a broken-DNS wedge must count as down.
#
# Escalation (state in /var/lib/avian, survives reboot):
#   down >= 15 min -> restart NetworkManager + cloudflared        (stage 1)
#   down >= 45 min -> reboot — at most once per 6 h, and never inside the first
#                     15 min of uptime, so a long ISP outage can't reboot-loop
#                     the box. While the cooldown blocks, cycle back to stage 1.
# Any successful probe clears the state. If a stage-1 heal ever makes things
# worse, the escalation still converges: the eventual reboot re-runs NM
# autoconnect from a clean slate.
#
# Runs as ROOT (restarts system services / reboots). Env knobs (optional; the
# short ones exist so the escalation can be tested without a real outage):
#   AVIAN_NET_URLS             space-separated probe URLs
#   AVIAN_NET_HEAL_SECS        stage-1 threshold in seconds   (default 900)
#   AVIAN_NET_REBOOT_SECS      stage-2 threshold in seconds   (default 2700)
#   AVIAN_NET_REBOOT_COOLDOWN  min gap between reboots        (default 21600)
#   AVIAN_NET_DRYRUN=1         log what would be done instead of doing it
set -uo pipefail

URLS="${AVIAN_NET_URLS:-https://avian-worker.s-friedman.workers.dev/health https://www.gstatic.com/generate_204}"
HEAL_SECS="${AVIAN_NET_HEAL_SECS:-900}"
REBOOT_SECS="${AVIAN_NET_REBOOT_SECS:-2700}"
COOLDOWN="${AVIAN_NET_REBOOT_COOLDOWN:-21600}"
STATE_DIR=/var/lib/avian
STATE="$STATE_DIR/net-watchdog.state"          # "<first_fail_epoch> <stage>"
REBOOT_MARK="$STATE_DIR/net-watchdog.last-reboot"
mkdir -p "$STATE_DIR"

run() {  # every system mutation goes through here so DRYRUN covers them all
  if [ "${AVIAN_NET_DRYRUN:-0}" = "1" ]; then echo "net-watchdog: DRYRUN: $*"; else "$@"; fi
}

for url in $URLS; do
  # curl exit 0 for ANY http response (even a 5xx) — that still proves our
  # net is up; nonzero covers DNS/TCP/TLS/timeout, which is what we watch for.
  if curl -s -o /dev/null --max-time 15 -H 'User-Agent: avian-net-watchdog/1.0' "$url"; then
    [ -f "$STATE" ] && { echo "net-watchdog: back online (via $url)"; rm -f "$STATE"; }
    exit 0
  fi
done

now=$(date +%s)
if [ ! -f "$STATE" ]; then
  echo "$now 0" > "$STATE"
  echo "net-watchdog: all probes failed — outage clock started" >&2
  exit 0
fi
read -r first stage < "$STATE" || { first=$now; stage=0; }
[[ "$first" =~ ^[0-9]+$ ]] || first=$now
[[ "$stage" =~ ^[0-9]+$ ]] || stage=0
elapsed=$(( now - first ))

if [ "$stage" -lt 1 ] && [ "$elapsed" -ge "$HEAL_SECS" ]; then
  echo "net-watchdog: down ${elapsed}s -> restarting NetworkManager + cloudflared" >&2
  run systemctl restart NetworkManager
  sleep 20   # give wifi time to re-associate before cloudflared re-resolves
  run systemctl restart cloudflared
  echo "$first 1" > "$STATE"
  exit 0
fi

if [ "$stage" -ge 1 ] && [ "$elapsed" -ge "$REBOOT_SECS" ]; then
  up_s=$(cut -d. -f1 /proc/uptime)
  last_reboot=0
  [ -f "$REBOOT_MARK" ] && last_reboot=$(stat -c %Y "$REBOOT_MARK" 2>/dev/null || echo 0)
  if [ "$up_s" -lt 900 ]; then
    echo "net-watchdog: down ${elapsed}s but uptime ${up_s}s < 900 — holding off" >&2
  elif [ $(( now - last_reboot )) -lt "$COOLDOWN" ]; then
    echo "net-watchdog: down ${elapsed}s; reboot on cooldown — cycling back to heal stage" >&2
    echo "$now 0" > "$STATE"
  else
    echo "net-watchdog: down ${elapsed}s after a heal attempt -> REBOOTING (last resort)" >&2
    run touch "$REBOOT_MARK"
    sync
    run systemctl reboot
  fi
  exit 0
fi

echo "net-watchdog: still down (${elapsed}s, stage $stage)" >&2
