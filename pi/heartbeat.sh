#!/usr/bin/env bash
# avian heartbeat — liveness ping to avian-worker. Run by avian-heartbeat.timer
# every ~15 min, INDEPENDENT of bird activity, so a quiet night never reads as a
# dead box. POSTs to /api/heartbeat; an uptime monitor watching /api/status (e.g.
# UptimeRobot) alerts if these pings stop. Outbound-only, like everything on the Pi.
#
# Env (set by the systemd unit, same as the forwarder):
#   AVIAN_WORKER       base URL of avian-worker (no trailing /api)
#   AVIAN_SECRET_FILE  file holding the shared ingest secret (mode 600)
set -uo pipefail

WORKER="${AVIAN_WORKER:-https://avian-worker.s-friedman.workers.dev}"
SECRET_FILE="${AVIAN_SECRET_FILE:-$HOME/.avian/ingest-secret}"
ENDPOINT="${WORKER%/}/api/heartbeat"

[ -r "$SECRET_FILE" ] || { echo "heartbeat: secret file $SECRET_FILE not readable" >&2; exit 1; }
SECRET="$(<"$SECRET_FILE")"   # $(<file) strips the trailing newline, matching the forwarder

# The secret rides in a header (same value the forwarder POSTs continuously). On a
# single-user Pi behind the tunnel, brief argv exposure to `ps` is a non-threat.
# Two attempts 20 s apart so a transient worker/D1 blip (2026-07-03: D1 storage
# resets 500'd single pings) doesn't flap the unit red; keep the response body —
# the worker puts the real error detail there, and discarding it cost a debug cycle.
body="$(mktemp)"
trap 'rm -f "$body"' EXIT
for attempt in 1 2; do
  code="$(curl -sS -o "$body" -w '%{http_code}' --max-time 20 \
    -XPOST "$ENDPOINT" \
    -H "X-Avian-Secret: $SECRET" \
    -H 'User-Agent: avian-heartbeat/1.0')" || code="000 (curl failed — offline?)"
  if [ "$code" = "204" ]; then
    echo "heartbeat: ok ($code) -> $ENDPOINT"
    exit 0
  fi
  echo "heartbeat: HTTP $code from $ENDPOINT: $(head -c 300 "$body")" >&2
  [ "$attempt" = 1 ] && sleep 20
done
exit 1
