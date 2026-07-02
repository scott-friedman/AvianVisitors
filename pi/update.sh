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

# Render the units this repo owns from their templates (deterministic; picks up any
# template change in the pull) and reinstall. Forwarder + heartbeat run from the
# clone with no venv, so this is always safe.
USER_NAME="${SUDO_USER:-$USER}"
HOME_DIR="$(eval echo "~$USER_NAME")"

echo "==> re-syncing systemd units"
for svc in avian-forwarder.service avian-heartbeat.service avian-mic-watchdog.service avian-net-watchdog.service; do
  [ -f "$REPO/pi/systemd/$svc" ] || continue
  sed "s|REPLACE_USER|$USER_NAME|; s|REPLACE_HOME|$HOME_DIR|g" "$REPO/pi/systemd/$svc" \
    | sudo tee "/etc/systemd/system/$svc" >/dev/null
done
[ -f "$REPO/pi/systemd/avian-heartbeat.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-heartbeat.timer" /etc/systemd/system/avian-heartbeat.timer
[ -f "$REPO/pi/systemd/avian-mic-watchdog.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-mic-watchdog.timer" /etc/systemd/system/avian-mic-watchdog.timer
[ -f "$REPO/pi/systemd/avian-net-watchdog.timer" ] && \
  sudo cp "$REPO/pi/systemd/avian-net-watchdog.timer" /etc/systemd/system/avian-net-watchdog.timer

sudo systemctl daemon-reload

echo "==> restarting services"
# enable --now arms a newly-added unit (e.g. the heartbeat on an older box); the
# explicit restart picks up new code / a new schedule on an already-running one.
sudo systemctl enable --now avian-forwarder.service 2>/dev/null || true
sudo systemctl restart avian-forwarder.service 2>/dev/null || echo "   !! avian-forwarder not installed"
sudo systemctl enable --now avian-heartbeat.timer 2>/dev/null || true
sudo systemctl restart avian-heartbeat.timer 2>/dev/null || echo "   !! avian-heartbeat.timer not installed"
sudo systemctl enable --now avian-mic-watchdog.timer 2>/dev/null || true
sudo systemctl restart avian-mic-watchdog.timer 2>/dev/null || echo "   !! avian-mic-watchdog.timer not installed"
sudo systemctl enable --now avian-net-watchdog.timer 2>/dev/null || true
sudo systemctl restart avian-net-watchdog.timer 2>/dev/null || echo "   !! avian-net-watchdog.timer not installed"

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
