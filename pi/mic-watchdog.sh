#!/usr/bin/env bash
# avian mic-watchdog — self-heal a recorder that's capturing silence (or has
# stopped writing WAVs entirely). Run by avian-mic-watchdog.timer every ~3 min
# (and 2 min after boot).
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

# Default derives the INVOKING user's home (the unit sets AVIAN_STREAMDATA
# explicitly; this fallback serves manual `sudo bash` runs, where $HOME is root's)
# so a rebuild under a different username still works.
SD="${AVIAN_STREAMDATA:-$(eval echo "~${SUDO_USER:-$(id -un)}")/BirdSongs/StreamData}"
FLOOR="${AVIAN_RMS_FLOOR:-5}"

# Newest two completed clips, into an ARRAY (whitespace-safe — no ls word-splitting).
# Nothing yet (recorder still warming up) → nothing to do.
newest=()
while IFS= read -r f; do newest+=("$f"); done < <(
  find "$SD" -maxdepth 1 -name '*.wav' -printf '%T@ %p\n' 2>/dev/null \
    | sort -rn | head -2 | cut -d' ' -f2-)
[ "${#newest[@]}" -gt 0 ] || { echo "mic-watchdog: no recordings yet; skip"; exit 0; }

reason=""

# Freshness first: the recorder writes a new WAV every 30 s, so nothing newer than
# 3 min (~6 periods, one full watchdog interval) means it has WEDGED — without this
# check, stale-but-loud clips would read healthy forever.
if ! find "$SD" -maxdepth 1 -name '*.wav' -mmin -3 | grep -q .; then
  reason="STALE (no new wav in 3 min; recorder wedged)"
else
  # Max RMS across them: a clip caught mid-write just lowers the max, so requiring
  # BOTH to be ~0 avoids false alarms. audioop is fine on the Pi's Python 3.11 but
  # is removed in 3.13 — the inline python falls back to a pure wave+struct RMS
  # (16-bit; any other width is unmeasurable there → report healthy, never restart-loop).
  # $FLOOR rides along as argv[1] so "unmeasurable" can print a healthy value.
  if maxrms="$(python3 -c '
import sys, wave
floor = int(sys.argv[1])

def rms(frames, width):
    try:
        import audioop  # removed in Python 3.13
        return audioop.rms(frames, width)
    except ImportError:
        pass
    if width != 2:  # fallback only understands 16-bit; do not fake a "silent" verdict
        print("mic-watchdog: no audioop and sample width %d unsupported -> assuming healthy" % width, file=sys.stderr)
        return None
    import struct
    n = len(frames) // 2
    if not n:
        return 0
    s = struct.unpack("<%dh" % n, frames[: 2 * n])
    return int((sum(v * v for v in s) / n) ** 0.5)

mx, unmeasured = 0, False
for f in sys.argv[2:]:
    try:
        w = wave.open(f, "rb"); n = w.getnframes()
        if n:
            r = rms(w.readframes(n), w.getsampwidth())
            if r is None:
                unmeasured = True
            else:
                mx = max(mx, r)
        w.close()
    except Exception:
        pass
print(max(mx, floor) if unmeasured else mx)
' "$FLOOR" "${newest[@]}")" && [ "$maxrms" -eq "$maxrms" ] 2>/dev/null; then
    [ "$maxrms" -ge "$FLOOR" ] || reason="SILENT (maxRMS=$maxrms < $FLOOR)"
  else
    # A python failure must never read as "silent mic" (it would restart the
    # recorder every 3 min forever). Log and leave the recorder alone.
    echo "mic-watchdog: RMS probe failed (python error, got '${maxrms:-}') — skipping silence check" >&2
  fi
fi

if [ -z "$reason" ]; then
  exit 0   # healthy: fresh recordings and the mic is hearing the room
fi

echo "mic-watchdog: recordings $reason -> restarting recorder" >&2
# Kill the stale pulse so the recorder's restart re-spawns a fresh one that
# re-detects the USB mic (a still-running pulse would be reused as-is).
pkill -x pulseaudio 2>/dev/null || true
sleep 1
systemctl restart birdnet_recording 2>/dev/null || true
echo "mic-watchdog: heal issued" >&2
