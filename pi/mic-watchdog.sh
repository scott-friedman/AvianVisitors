#!/usr/bin/env bash
# avian mic-watchdog — self-heal a recorder that's capturing silence. Run by
# avian-mic-watchdog.timer every ~3 min (and 2 min after boot).
#
# The #1 failure mode for a bird box is "mic plugged in but recording nothing."
# It bit us once at the Sudbury move: after a power-cycle a PulseAudio boot-timing
# glitch left birdnet_recording capturing a dead input, so BirdNET analysed pure
# silence and no birds were ever detected. The reliable fix is simply to restart
# birdnet_recording (a fresh pulse re-detects the USB mic cleanly). This watches
# the recorder's ACTUAL output and applies that fix only when it's needed.
#
# IMPORTANT: diagnose by WAV RMS, NOT by pulse's "Default Source" label — the two
# are decoupled here (a fully detached mic still recorded fine in testing). Trust
# the bytes BirdNET is actually getting. See pi/README.md → "Mic watchdog".
#
# Runs as ROOT (the unit has no User=): it restarts a system service.
#
# Env (set by the systemd unit):
#   AVIAN_STREAMDATA  dir of BirdNET-Pi's rolling WAVs (default below)
#   AVIAN_RMS_FLOOR   below this = silence (a dead/null input is 0; a live mic >> 5)
set -uo pipefail

SD="${AVIAN_STREAMDATA:-/home/inky/BirdSongs/StreamData}"
FLOOR="${AVIAN_RMS_FLOOR:-5}"

# Newest two completed clips. Nothing yet (recorder still warming up) → nothing to do.
newest="$(ls -t "$SD"/*.wav 2>/dev/null | head -2)"
[ -n "$newest" ] || { echo "mic-watchdog: no recordings yet; skip"; exit 0; }

# Max RMS across them: a clip caught mid-write just lowers the max, so requiring
# BOTH to be ~0 avoids false alarms. audioop is fine on the Pi's Python 3.11.
maxrms="$(python3 -c '
import sys, wave, audioop
mx = 0
for f in sys.argv[1:]:
    try:
        w = wave.open(f, "rb"); n = w.getnframes()
        if n:
            mx = max(mx, audioop.rms(w.readframes(n), w.getsampwidth()))
        w.close()
    except Exception:
        pass
print(mx)
' $newest)"

if [ "${maxrms:-0}" -ge "$FLOOR" ]; then
  exit 0   # healthy: the mic is hearing the room
fi

echo "mic-watchdog: recordings SILENT (maxRMS=$maxrms < $FLOOR) -> restarting recorder" >&2
# Kill the stale pulse so the recorder's restart re-spawns a fresh one that
# re-detects the USB mic (a still-running pulse would be reused as-is).
pkill -x pulseaudio 2>/dev/null || true
sleep 1
systemctl restart birdnet_recording 2>/dev/null || true
echo "mic-watchdog: heal issued" >&2
