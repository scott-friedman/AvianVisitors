# Pi glue — detection forwarder (Phase 2)

`detection-forwarder.py` is the bridge from **BirdNET-Pi** (detection engine on
the Pi) to **avian-worker** (Cloudflare). It tails `~/BirdNET-Pi/BirdDB.txt` —
one line per detection — and POSTs each new detection to `/api/detection` with
the shared `X-Avian-Secret`. From there the public collage and the e-ink frame
pick it up.

**Why a tail-watcher and not a code hook:** BirdNET-Pi has no per-detection
script hook (only DB insert + BirdWeather + Apprise), and editing its source
would be clobbered on `git pull`. Tailing `BirdDB.txt` is fully decoupled and
survives BirdNET-Pi updates. The Pi stays outbound-only (no ports opened). The
worker dedupes by `(sci, ts)`, so a restart replaying a line is harmless.

## Install (on the Pi, after BirdNET-Pi is installed)

The forwarder runs **straight from the `~/BirdNET-Pi` clone** (where `newinstaller.sh`
put the fork), so a `git pull` updates it — no copied file to keep in sync. Run these
from that clone:

```sh
cd ~/BirdNET-Pi

# 1. shared ingest secret (same value as the worker's AVIAN_INGEST_SECRET)
mkdir -p ~/.avian && umask 077 && printf '%s' '<SECRET>' > ~/.avian/ingest-secret

# 2. systemd service (rewrite User/paths for this Pi; ExecStart runs the script
#    from this clone, so `git pull` + restart is the whole update — see below)
sed "s|REPLACE_USER|$USER|; s|REPLACE_HOME|$HOME|g" pi/systemd/avian-forwarder.service \
  | sudo tee /etc/systemd/system/avian-forwarder.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now avian-forwarder.service
```

The forwarder resumes from a persisted byte offset (`~/.avian/forwarder-state.json`),
so a restart or brief outage doesn't drop detections — only the first-ever run skips
the existing back-history. **Rotating the ingest secret needs `sudo systemctl restart
avian-forwarder`** (it reads the secret once at startup; without a restart every POST
401s and is dropped). The heartbeat re-reads the secret each run, so it needs no restart.

## Test without a mic

`/api/detection` and the whole downstream are live, so you can validate the
plumbing by hand-appending a BirdDB.txt line:

```sh
echo "$(date +%F);$(date +%T);Cardinalis cardinalis;Northern Cardinal;0.95;-1;-1;0.7;25;1.25;0.0" \
  >> ~/BirdNET-Pi/BirdDB.txt
journalctl -u avian-forwarder -n 5 --no-pager     # should show "posted ... -> 204"
curl -s "$AVIAN_WORKER/api/recent?hours=24" | grep -i cardinal
```

Remove test rows from the worker when done:
`wrangler d1 execute avian-detections --remote --command "DELETE FROM detections WHERE com='Northern Cardinal'"`

---

# Liveness heartbeat — `heartbeat.sh` (so silent failure isn't invisible)

`heartbeat.sh` pings `avian-worker`'s `/api/heartbeat` every ~15 min on a systemd
timer, **independent of bird activity** (a quiet night must not read as a dead box).
If the mic dies, BirdNET hangs, or wifi drops at Dad's, the pings stop and the
Worker's `GET /api/status` flips from **200** to **503** — so an uptime monitor can
alert you. Without it, the frame just freezes on its last image and nobody notices.

Install (reuses the same ingest secret as the forwarder; units run from the
`~/BirdNET-Pi` clone — see "Updating the Pi" below):

```sh
sed "s|REPLACE_USER|$USER|; s|REPLACE_HOME|$HOME|g" pi/systemd/avian-heartbeat.service \
  | sudo tee /etc/systemd/system/avian-heartbeat.service >/dev/null
sudo cp pi/systemd/avian-heartbeat.timer /etc/systemd/system/avian-heartbeat.timer
sudo systemctl daemon-reload
sudo systemctl enable --now avian-heartbeat.timer
sudo systemctl start avian-heartbeat.service       # fire one now
journalctl -u avian-heartbeat -n 3 --no-pager      # expect "heartbeat: ok (204)"
```

**Wire the alert (UptimeRobot, or any HTTP monitor):** add an HTTP(s) monitor for
`https://avian-worker.s-friedman.workers.dev/api/status`. It returns **503** once the
Pi has missed ~3 pings (45 min, tunable via the Worker's `HEARTBEAT_MAX_AGE_SECONDS`),
which the monitor treats as "down". The JSON body also reports `last_detection_age_seconds`
— a long gap there while `alive:true` means the box is fine but the **mic/analyzer**
has gone quiet.

---

# Mic watchdog — `mic-watchdog.sh` (auto-recover a silent recorder)

The heartbeat catches a *dead* box; this catches a *deaf* one. A USB mic can enumerate
fine yet feed silence — most often a PulseAudio boot-timing glitch after a power-cycle
that leaves `birdnet_recording` on a dead input (seen once at the Sudbury move). BirdNET
then analyses silence forever and the frame quietly freezes on its last image.

`mic-watchdog.sh` runs on a systemd timer (every ~3 min, and 2 min after boot): it reads
the RMS of the two newest `~/BirdSongs/StreamData` clips and, **only if both are silent
(RMS < 5)**, restarts `birdnet_recording` (a fresh pulse re-detects the mic) — the fix
that reliably clears it. It no-ops when the mic is healthy. **Diagnose by WAV RMS, not by
pulse's `Default Source` label** — they're decoupled here (a fully detached mic still
recorded fine in testing), so trust the bytes BirdNET actually gets. Runs as root because
it restarts a system service.

Install (units run from the `~/BirdNET-Pi` clone — see "Updating the Pi" below):

```sh
sed "s|REPLACE_HOME|$HOME|g" pi/systemd/avian-mic-watchdog.service \
  | sudo tee /etc/systemd/system/avian-mic-watchdog.service >/dev/null
sudo cp pi/systemd/avian-mic-watchdog.timer /etc/systemd/system/avian-mic-watchdog.timer
sudo systemctl daemon-reload
sudo systemctl enable --now avian-mic-watchdog.timer
sudo systemctl start avian-mic-watchdog.service     # dry-run now (no-op if healthy)
journalctl -u avian-mic-watchdog -n 3 --no-pager
```

---

# Pi 512 MB survival — `lean-mode.sh` + `zero2w-tune.sh`

The Zero 2 W has **512 MB RAM** and BirdNET's analyzer needs ~150 MB resident. The full
BirdNET-Pi stack (web UI, Streamlit Stats, spectrogram, Icecast/livestream, Caddy+PHP)
overcommits and **OOM-thrashes the box unreachable**; and even *detection-only* OOMs
untuned. Two committed scripts make it stable. Full incident + measured numbers:
[`../PI-RECOVERY.md`](../PI-RECOVERY.md).

## `lean-mode.sh` — strip to detection-only
`sudo bash pi/lean-mode.sh`. Disables/masks every service this Cloudflare-hosted
deployment never uses (Stats, chart/spectrogram viewers, Icecast, livestream, web
terminal, Caddy, PHP, `birdnet_log`), leaving only the detection engine, the forwarder,
the e-ink frame timer, and ssh. Idempotent; also removes the temporary `systemd.mask=`
boot hack if present. **Necessary but not sufficient** — stripping saves only tens of MB.

## `zero2w-tune.sh` — make 512 MB actually work
`sudo bash pi/zero2w-tune.sh`, **then reboot**. Idempotent. Applies:
- **zram** compressed-RAM swap as the primary lane (~50 % of RAM, lz4) + `vm.swappiness=100`
  — fast spike absorption, no SD wear. The stock 512 MB SD swapfile stays as a low-priority
  backstop (deliberately **not** grown to 2 GB — a big SD swapfile thrashes the card to death).
- **mono capture + 30 s recordings** (`birdnet.conf` `CHANNELS=1`, `RECORDING_LENGTH=30`) —
  less IO; lets the slow CPU keep pace so no backlog builds.
- **clears the corrupt numba JIT cache** (`*.nbi`/`*.nbc`) — the prior OOM crashes truncated
  it, breaking librosa with `EOFError: Ran out of input` on every analysis (numba never
  recompiles a *corrupt* entry, only a missing one).
- **`gpu_mem=16`** (headless; the Inky panel is SPI, not the GPU) — frees ~48 MB RAM.
- **hardware watchdog** (`RuntimeWatchdogSec=15`) — auto-reboots a hung box instead of a
  physical power-cycle. Plus Wi-Fi power-save off and `journald` capped at 200 MB.

Also clear any recording backlog before going live (a pile of unanalyzed clips drives
sustained memory pressure): `rm ~/BirdSongs/StreamData/*.wav`.

**Measured (2026-06-19, no mic):** steady-state ~370 MB used / ~90 MB free, analyzer
plateaus ~150 MB, backlog holds ~2 (keeps up with realtime), SSH responsive, no thrash.
**Verdict: stripped + tuned BirdNET-Pi is viable on a 512 MB Zero 2 W — no BirdNET-Go.**

---

# Remote admin (Phase 5) — SSH over Cloudflare Tunnel  ·  LIVE

Manage the Pi from anywhere once it lives at your dad's. It dials out to Cloudflare
and exposes **only its local sshd** through a tunnel hostname — **no ports opened**
at the house. This is the back door for improving it later without his involvement.

**Live (2026-06-19):** tunnel `avian-admin` → `bird-ssh.foobos.net` → `ssh://localhost:22`,
cloudflared service enabled@boot, `ssh bird-pi` verified. **Password-gated, no
Cloudflare Access app** (Scott's choice — usable from any machine with `cloudflared`,
not tied to one key/email). Safe because the tunnel hides SSH from internet
port-scanning; the gate is a strong `inky` password. Admin DNS uses the **foobos.net**
zone only (DNS record, no shared Workers/D1).

## Client setup (any computer)

Install `cloudflared` (`brew install cloudflared` / `winget install cloudflare.cloudflared` /
apt), add this to `~/.ssh/config`, then `ssh bird-pi` and enter the inky password:
```
Host bird-pi
    HostName bird-ssh.foobos.net
    User inky
    ProxyCommand cloudflared access ssh --hostname %h
```

## Redoing the tunnel on a fresh Pi / new hostname

Two gotchas learned the hard way:
- **`cloudflared tunnel login` fails headless on the Pi** ("Failed to fetch resource" —
  it can't pull the cert back). Run the login on a machine with a browser (the Mac),
  then copy the cert over: `cloudflared tunnel login` → `scp ~/.cloudflared/cert.pem
  inky@<pi>:~/.cloudflared/`.
- **Use a single-level subdomain** (`bird-ssh.<zone>`, NOT `ssh.bird.<zone>`) — free-plan
  universal SSL only covers `*.<zone>` one level deep, so a 2-level name breaks the cert.

Then on the Pi (cert in place): `bash tunnel-setup.sh bird-ssh.<your-zone> avian-admin`
(creates the tunnel, routes DNS, writes `/etc/cloudflared/config.yml`, installs the service).

## Critical pre-move check

Once the Pi is on your dad's wifi, `inky.local` / `192.168.0.29` no longer reach it —
the tunnel is your only way in. **Verify `ssh bird-pi` works from a network that is NOT
your dad's (phone tether) before you leave.**

---

# Updating the Pi — `update.sh`

The avian glue (forwarder, heartbeat, frame client) runs straight from the
`~/BirdNET-Pi` clone — `newinstaller.sh` clones the whole fork there, so the
detection engine **and** the glue are one repo. To ship a code change:

```sh
ssh bird-pi
bash ~/BirdNET-Pi/pi/update.sh     # git pull --ff-only → re-sync units → restart
```

`update.sh` is idempotent and a no-op when there's nothing new. It pulls, re-renders
the forwarder + heartbeat + mic-watchdog units (in case a template changed),
`daemon-reload`s, and restarts `avian-forwarder` + `avian-heartbeat.timer` +
`avian-mic-watchdog.timer` + `birdframe.timer`. The
detection engine (BirdNET-Pi) updates the same way it always did — its services are
unaffected by a glue-only change; a `git pull` simply also carries any base updates.

**One-time re-align for older boxes — DONE on Barry's box 2026-06-19.** Older boxes ran
the forwarder/heartbeat/mic-watchdog from `cp`'d copies in `~/avian/` and the frame from
`~/birdframe/`; for `git pull` to update them they must run from the clone. The sequence
that actually worked on a box ~16 commits behind:
1. **Move untracked junk aside first** (`*.bak`, a stray `.whl`, `requirements_custom.txt`,
   a dangling `model/labels_flickr.txt` symlink, etc.) so `--ff-only` can't abort, then
   **pull manually** — on a far-behind clone `update.sh` itself doesn't exist yet, so don't
   start with it: `git -C ~/BirdNET-Pi pull --ff-only`.
2. Re-render the glue units (the forwarder install block above) — re-points forwarder +
   heartbeat + mic-watchdog at `~/BirdNET-Pi/pi/…`.
3. **Frame:** either build a fresh venv (`cd ~/BirdNET-Pi/frame && ./install.sh`) **or**, to
   skip the venv build on a 512 MB box, reuse an existing interpreter by pointing the unit's
   `ExecStart` at it. Barry's box reuses `/home/inky/inky-venv/bin/python` running
   `~/BirdNET-Pi/frame/display.py` (validate first, no panel touch: `display.py --preview
   out.png`). Either way `update.sh`'s clone-check passes once `ExecStart` contains
   `…/BirdNET-Pi/frame`.
4. Verify by behaviour, then **remove the old `~/avian` + `~/birdframe` code dirs** — but
   **keep the `~/.avian` + `~/.birdframe` dot dirs** (units read the ingest secret, forwarder
   offset state, frame config + key, and render state from those).

`update.sh` warns if the frame isn't clone-based yet.

