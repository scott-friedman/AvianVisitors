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
code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 \
  -XPOST "$ENDPOINT" \
  -H "X-Avian-Secret: $SECRET" \
  -H 'User-Agent: avian-heartbeat/1.0')" || { echo "heartbeat: curl failed (offline?)" >&2; exit 1; }

if [ "$code" = "204" ]; then
  echo "heartbeat: ok ($code) -> $ENDPOINT"
else
  echo "heartbeat: unexpected HTTP $code from $ENDPOINT" >&2
  exit 1
fi
