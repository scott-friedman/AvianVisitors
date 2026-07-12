#!/usr/bin/env bash
# pi/update.sh — pull the latest AvianVisitors glue onto the Pi and restart the
# services that run from the clone. One command instead of a remembered sequence,
# so the box can be improved later without Dad's involvement (REVIEW-TODO.md B-High).
#
# The Pi runs the avian glue (forwarder, heartbeat, frame client) straight from the
# ~/BirdNET-Pi clone of the AvianVisitors fork — newinstaller.sh clones the whole
# fork there, so the detection engine and the glue share this ONE repo. That means
# `git pull` + `systemctl restart` is the entire update; no re-copying files.
#
# Run ON THE PI (not sudo; it elevates internally for the /etc + systemctl bits):
#   bash ~/BirdNET-Pi/pi/update.sh
# Idempotent. A no-op when there's nothing new to pull.
set -uo pipefail

REPO="${AVIAN_REPO:-$HOME/BirdNET-Pi}"
[ -d "$REPO/.git" ] || { echo "ERROR: $REPO is not a git clone (set AVIAN_REPO)"; exit 1; }

if [ -n "${AVIAN_UPDATE_REEXEC:-}" ]; then
  # Second pass, running the freshly-pulled copy of this script (see below).
  echo "==> continuing with the updated update.sh ($(git -C "$REPO" rev-parse --short HEAD))"
else
  echo "==> git pull --ff-only in $REPO"
  before="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo none)"
  # Fail LOUD if the pull errors (diverged history from a hand-scp'd file, an
  # untracked-file collision, no network) — without this check the script fell
  # through to "already up to date" and exit 0, masking a silent no-update on the
  # box's only remote-update path (REVIEW-TODO B-Low).
  if ! git -C "$REPO" pull --ff-only; then
    echo "ERROR: git pull FAILED — the box did NOT update." >&2
    echo "       Inspect with: git -C $REPO status   (diverged/scp'd file? untracked collision?)" >&2
    exit 1
  fi
  after="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo none)"

  if [ "$before" = "$after" ]; then
    echo "==> already up to date ($after) — nothing to restart."
    exit 0
  fi
  echo "==> updated $before -> $after"
  # Re-exec the PULLED script before doing any unit sync: bash keeps reading a
  # replaced script through its original fd, so without this the OLD update.sh
  # finishes the run and any change to the sync steps themselves (a new unit,
  # a new backstop file) silently doesn't apply — bit us 2026-07-03 when the
  # freshly-added avian-prune units weren't installed by the very pull that
  # added them. The env guard prevents a re-exec loop.
  # AVIAN_UPDATE_PREV carries the pre-pull SHA across the re-exec for the
  # rollback hint in the failure trap below.
  AVIAN_UPDATE_REEXEC=1 AVIAN_UPDATE_PREV="$before" exec bash "$REPO/pi/update.sh"
fi

# From here on any failure must be FATAL and LOUD (set -e): a swallowed unit-render
# failure would let daemon-reload restart the OLD units while the run reads clean.
# (Deliberately NOT set above — the pull/re-exec block handles its errors explicitly,
# and the re-exec behaviour must be preserved exactly.)
set -e
trap 'st=$?; if [ "$st" -ne 0 ]; then
  echo "ERROR: update did NOT complete (exit $st)." >&2
  if [ -n "${AVIAN_UPDATE_PREV:-}" ] && [ "$AVIAN_UPDATE_PREV" != "none" ]; then
    echo "       To roll back: git -C $REPO reset --hard $AVIAN_UPDATE_PREV && bash $REPO/pi/update.sh" >&2
  fi
fi' EXIT

# Render the units this repo owns from their templates (deterministic; picks up any
# template change in the pull) and reinstall. Forwarder + heartbeat run from the
# clone with no venv, so this is always safe.
USER_NAME="${SUDO_USER:-$USER}"
HOME_DIR="$(eval echo "~$USER_NAME")"

echo "==> re-syncing systemd units"
for svc in avian-forwarder.service avian-heartbeat.service avian-mic-watchdog.service avian-net-watchdog.service avian-prune.service; do
  [ -f "$REPO/pi/systemd/$svc" ] || continue
  if ! sed "s|REPLACE_USER|$USER_NAME|g; s|REPLACE_HOME|$HOME_DIR|g" "$REPO/pi/systemd/$svc" \
    | sudo tee "/etc/systemd/system/$svc" >/dev/null; then
    echo "ERROR: failed to render/install $svc — aborting before daemon-reload." >&2
    exit 1
  fi
done
[ -f "$REPO/pi/systemd/avian-heartbeat.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-heartbeat.timer" /etc/systemd/system/avian-heartbeat.timer
[ -f "$REPO/pi/systemd/avian-mic-watchdog.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-mic-watchdog.timer" /etc/systemd/system/avian-mic-watchdog.timer
[ -f "$REPO/pi/systemd/avian-net-watchdog.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-net-watchdog.timer" /etc/systemd/system/avian-net-watchdog.timer
[ -f "$REPO/pi/systemd/avian-prune.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-prune.timer" /etc/systemd/system/avian-prune.timer

# BirdNET-Pi's stock 95%-disk purge (scripts/disk_check.sh, /etc/crontab) hard-
# exits unless this web-UI-created file exists — the lean box has no web UI, so
# ensure it here. Backstop only; avian-prune.timer keeps the disk far from 95%.
EXCL="$REPO/scripts/disk_check_exclude.txt"
[ -f "$EXCL" ] || printf '##start\n##end\n' > "$EXCL"

sudo systemctl daemon-reload

echo "==> restarting services"
# enable --now arms a newly-added unit (e.g. the heartbeat on an older box); the
# explicit restart picks up new code / a new schedule on an already-running one.
# "not installed" = no unit file (skip); a REAL restart failure prints systemctl's
# own error (stderr not suppressed) and fails the run — the two must not conflate
# on the box's only update path.
RESTART_FAILED=0
for unit in avian-forwarder.service avian-heartbeat.timer avian-mic-watchdog.timer avian-net-watchdog.timer avian-prune.timer; do
  if [ ! -f "/etc/systemd/system/$unit" ]; then
    echo "   !! $unit not installed (no unit file) — skipped"
    continue
  fi
  sudo systemctl enable --now "$unit" 2>/dev/null || true
  if ! sudo systemctl restart "$unit"; then
    echo "   !! $unit FAILED to restart (see error above)" >&2
    RESTART_FAILED=1
  fi
done
[ "$RESTART_FAILED" -eq 0 ] || { echo "ERROR: one or more units failed to restart." >&2; exit 1; }

# The frame unit owns its own venv + path (frame/install.sh), so update.sh doesn't
# re-render it — it just re-arms the timer to pick up a pulled display.py. That only
# works if the frame actually runs from this clone; warn if it doesn't.
if [ -f /etc/systemd/system/birdframe.service ]; then
  if grep -q "$REPO/frame" /etc/systemd/system/birdframe.service; then
    sudo systemctl restart birdframe.timer 2>/dev/null || true
    echo "   birdframe.timer re-armed (frame runs from the clone)"
  else
    echo "   !! birdframe.service does NOT run from $REPO/frame — git pull won't update the"
    echo "      frame code. Re-align once: cd $REPO/frame && ./install.sh"
  fi
fi

echo "==> done. Recent forwarder log:"
journalctl -u avian-forwarder -n 3 --no-pager 2>/dev/null || true
