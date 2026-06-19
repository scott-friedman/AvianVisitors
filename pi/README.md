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

```sh
# 1. script
mkdir -p ~/avian && cp pi/detection-forwarder.py ~/avian/

# 2. shared ingest secret (same value as the worker's AVIAN_INGEST_SECRET)
mkdir -p ~/.avian && umask 077 && printf '%s' '<SECRET>' > ~/.avian/ingest-secret

# 3. systemd service (rewrite User/paths for this Pi)
sed "s|REPLACE_USER|$USER|; s|REPLACE_HOME|$HOME|g" pi/systemd/avian-forwarder.service \
  | sudo tee /etc/systemd/system/avian-forwarder.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now avian-forwarder.service
```

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

# Remote admin (Phase 5) — SSH over Cloudflare Tunnel

How you manage the Pi from home once it lives at your dad's. The Pi dials out to
Cloudflare and exposes **only its local sshd** through an Access-gated hostname —
**no ports opened** at the house, nothing public. This is the back door that lets
you improve things later without your dad's involvement.

**Already done (this repo / on the Pi):** `cloudflared` installed; `sshd` enabled
at boot; `tunnel-setup.sh` + `cloudflared-config.example.yml` ready; `cloudflared`
installed on the Mac (`brew install cloudflared`).

**You still need:** a hostname on a **zone in your Cloudflare account**
(e.g. `ssh.bird.onethreenine.net`). This needs only a one-time browser login —
**not** the scoped CI API token (that token is only for the GitHub Actions deploys).

## One-time setup

```sh
# On the Pi (NOT sudo) — prints a URL; open it on your laptop, pick the zone:
cloudflared tunnel login

# Then, from the repo's pi/ dir on the Pi:
bash tunnel-setup.sh ssh.bird.<your-zone> avian-admin
```

The script creates the tunnel, routes DNS, writes `/etc/cloudflared/config.yml`,
and installs the boot service, then prints the final two steps:

1. **Access policy** (dashboard, no token): Zero Trust → Access → Applications →
   Add → Self-hosted → domain = your hostname → Allow `friedmannn2@gmail.com`.
2. **Mac `~/.ssh/config`:**
   ```
   Host bird-pi
     HostName ssh.bird.<your-zone>
     User inky
     ProxyCommand cloudflared access ssh --hostname %h
   ```
   Then `ssh bird-pi` (first connect opens a browser to authenticate).

## Why this is the critical pre-move step

Once the Pi is on your dad's wifi, `inky.local` / `192.168.0.29` no longer reach
it — the tunnel is your only way in. **Verify `ssh bird-pi` works from a network
that is NOT your dad's (tether to your phone) before you leave his house.**

