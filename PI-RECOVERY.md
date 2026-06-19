# Pi Memory Crisis — Recovery & Next Steps (Session Handoff)

> **Written mid-incident on 2026-06-19 to hand off to a fresh Claude Code session.**
> Read `CLAUDE.md` (architecture) and `PLAN.md` (v1 build plan) too, but **this file
> supersedes the rosy "Phase 2 done" status** — BirdNET-Pi hit a wall tonight. Start here.

---

## Plain English summary (for a non-technical reader)

The little computer that listens for birds (a Raspberry Pi) **kept freezing and crashing
tonight.** The cause: the bird-detection software (BirdNET-Pi) is **too heavy for the Pi's
small memory (512 MB)** when it runs *all* its extra parts — a web dashboard, stats charts,
audio streaming, a browser terminal — **none of which we actually use**, because our public
website lives on Cloudflare instead. With all that running, the Pi ran out of memory, started
shoving data onto its slow memory card to cope, and ground to a halt — so badly we couldn't
even log in.

**The rescue:** since we couldn't log in while it was frozen, we pulled its memory card,
plugged it into the Mac, edited **one line on it** so the Pi would boot up *without* the heavy
parts, and put it back. Now it boots cleanly, stays responsive, and we can log in.

**Where we are:** the Pi is alive and stable **right now**, but in a *temporary* rescued state
that won't survive a normal reboot yet. The next session needs to make the lightweight setup
**permanent**, then **measure** whether the bird-listening part *by itself* fits comfortably in
memory.

**The open question:** can we keep BirdNET-Pi (stripped down to just the listening), or should
we switch to a lighter version called **BirdNET-Go**? Encouraging evidence — a blogger running
the *identical* Pi — suggests stripped BirdNET-Pi will probably work, so we try that first.

**Nothing public broke.** The website and e-ink frame (both on Cloudflare) ran fine the entire
time. This whole saga is only about the Pi.

---

## ⚠️ CRITICAL — current fragile state (READ before touching the Pi)

The Pi boots light **only because of a temporary kernel hack** in its boot file. The heavy
services are **still "enabled"** — they would auto-start again on a normal boot.

- **DO NOT restore `cmdline.txt` to its original until the heavy services are `systemctl disable`d**
  (Step 1 below), or the Pi will thrash itself to death again.
- The temporary hack lives in **`/boot/firmware/cmdline.txt`** as appended `systemd.mask=...`
  parameters (masks `birdnet_analysis`, `birdnet_recording`, `birdnet_log`, `caddy`, `php8.2-fpm`).
- **Backup of the original** is at **`/boot/firmware/cmdline.txt.orig`** (made on the SD card during
  recovery). If it's missing, the verbatim original single line is:
  ```
  console=serial0,115200 console=tty1 root=PARTUUID=f045343d-02 rootfstype=ext4 fsck.repair=yes rootwait cfg80211.ieee80211_regdom=UM
  ```

---

## Connection facts

- **Pi:** `inky@192.168.0.29` (MAC `2c:cf:67:b2:c3:78`), Raspberry Pi **Zero 2 W, 512 MB**, Bookworm, passwordless sudo.
- **mDNS (`inky.local`) is FLAKY** — frequently won't resolve. **Use the IP `192.168.0.29`.** Host key already accepted.
- There is a **DIFFERENT Pi at `192.168.0.64`** (also a `2c:cf:67` MAC) — **do not confuse it with inky.**
- Connect: `ssh -o ConnectTimeout=10 inky@192.168.0.29`

---

## What happened tonight (diagnosis, confirmed by data)

- BirdNET-Pi (installed a prior session) was running the **full stack**. On the 512 MB Pi it
  overcommitted memory and thrashed to swap until unreachable — twice — to the point SSH/TCP
  wouldn't even complete a handshake.
- Hard evidence at `up 1 minute`, full stack: **247 MB RAM used + 365 MB swap** → working set
  ~600 MB against only **~416 MB usable RAM**. Classic sustained thrash.
- **Recovery:** edited the SD card's `cmdline.txt` on the Mac to mask the 5 heaviest services
  via `systemd.mask=`. Pi now boots light.
- **Post-recovery (light boot), measured:** `177 MB used / 238 MB available`, **SSH instant, no
  thrash.** Healthy.

---

## Current Pi service state (as of handoff)

| State | Services |
|---|---|
| **Masked this-boot (off, but still `enabled`)** | `birdnet_analysis`, `birdnet_recording`, `birdnet_log`, `caddy`, `php8.2-fpm` |
| **STILL RUNNING — cruft to shed** | `birdnet_stats` (the 77 MB Streamlit hog: `daily_plot.py` + `plotly_streamlit.py`), `chart_viewer`, `spectrogram_viewer`, `icecast2`, `livestream`, `web_terminal` |
| **Running & wanted — KEEP** | `avian-forwarder`, `birdframe.timer`, `ssh` |
| **Already disabled** | `inky-web`, `caddy-api` |

---

## The decision: stripped BirdNET-Pi  vs  BirdNET-Go

**Lean toward: finish stripping BirdNET-Pi and measure first. Switch to Go only if it still won't fit.**

- **Evidence for keeping stripped BirdNET-Pi:** `https://hannahilea.com/blog/birdnet-setup/` — **same
  Pi (Zero 2 W), same Nachtzuster installer.** They get working detection while *also* running the
  full (slow) web UI. Their #1 complaint: the Stats service is *"unusably slow on the Raspberry Pi
  Zero"* → they disable it. **That is exactly our 77 MB `birdnet_stats`.** Since we need **zero** web
  UI, we can strip far more than they did → more headroom than they have.
- **BirdNET-Go = the lighter fallback.** Same underlying BirdNET model (identical detection accuracy),
  single Go binary, built-in light web UI, MQTT, BirdWeather, clip saving. **Cost of switching:** rewrite
  the forwarder (Go stores detections differently — SQLite/MQTT/webhook instead of `BirdDB.txt`).
  Scientific names are preserved, so the illustration mapping is unaffected.

---

## NEXT STEPS (ordered, executable)

### Step 1 — Finish stripping the Pi (make the light state complete & permanent)
```sh
ssh inky@192.168.0.29
# shed all non-essential BirdNET-Pi UI/stream services:
sudo systemctl disable --now birdnet_stats chart_viewer spectrogram_viewer icecast2 livestream web_terminal
# persist-disable the 5 currently only runtime-masked, so they STAY off after we remove the kernel hack:
sudo systemctl disable birdnet_analysis birdnet_recording birdnet_log caddy php8.2-fpm
# sanity: only avian-forwarder, birdframe.timer, ssh + core OS should remain
systemctl list-units --type=service --state=running
```

### Step 2 — Remove the temporary kernel hack (SAFE only after Step 1)
```sh
# verify the backup is the clean original, then restore it:
sudo cp /boot/firmware/cmdline.txt.orig /boot/firmware/cmdline.txt
# confirm it's ONE line and has NO systemd.mask= left:
cat /boot/firmware/cmdline.txt        # (or wc -l → must be 1, grep -c systemd.mask → must be 0)
```

### Step 3 — Reboot and confirm a clean light boot (no hack, services stay off via disable)
```sh
sudo reboot
# wait ~60s, reconnect to 192.168.0.29:
free -m                               # expect low swap, healthy 'available'
for s in birdnet_analysis birdnet_stats caddy php8.2-fpm; do systemctl is-active $s; done   # all inactive
for s in avian-forwarder birdframe.timer; do systemctl is-active $s; done                   # active
```

### Step 4 — MEASURE detection-only memory (the real go/no-go test)
```sh
sudo systemctl start birdnet_analysis birdnet_recording    # turn ON just the listening engine
# let it load its model + settle ~2-3 min, then watch a few times:
free -m
ps -eo rss,comm --sort=-rss | head
# WORST-CASE stress: trigger an e-ink render WHILE detection runs (this is the hourly spike):
sudo systemctl start birdframe.service ; free -m
```
**Decision rule (rough, 416 MB usable):**
- ✅ **Keep stripped BirdNET-Pi** if resting `used` stays well under ~340 MB, `available` > ~70 MB,
  and **swap is not steadily climbing**. (Note: no mic yet → this is the *resting* footprint; real
  inference with a mic adds ~30–80 MB, so leave margin.)
- ❌ **Switch to BirdNET-Go** (Step 7) if it thrashes (swap climbing, sluggish SSH).
- After measuring, **stop the engine again** (`sudo systemctl stop birdnet_analysis birdnet_recording`)
  to keep the box idle-light until the mic arrives — UNLESS keeping it on for soak-testing.

### Step 5 — Memory hardening (do regardless of Pi-vs-Go; adds safety margin)
- **zram** (compressed RAM swap): faster than the SD swapfile + far less card wear. (`sudo apt install zram-tools`, configure ~256 MB.)
- **`gpu_mem=16`** in `/boot/firmware/config.txt` (headless; the Inky panel is SPI not HDMI) → frees ~48 MB RAM. Needs a reboot.
- Consider `vm.swappiness` tuning.

### Step 6 — When the mic arrives (Scott to buy ~$24: USB lavalier mic + USB-to-micro-USB OTG adapter)
- Plug in via OTG adapter; confirm `arecord -l` lists it.
- Set location + tuning **over SSH** (no web UI needed): edit `~/BirdNET-Pi/birdnet.conf`
  (`LATITUDE`, `LONGITUDE`, `SENSITIVITY`, `CONFIDENCE`, `OVERLAP`, `DATABASE_LANG`), then
  `sudo systemctl restart birdnet_recording birdnet_analysis`.
- Ensure detection is enabled to survive reboots: `sudo systemctl enable --now birdnet_analysis birdnet_recording`.
- Verify end-to-end: a real chirp → `~/BirdNET-Pi/BirdDB.txt` line → `avian-forwarder` POST →
  worker `/api/detection` → appears in `/api/recent` → website.
- Set worker `TZ_OFFSET_HOURS = -4` (EDT) so day-buckets are correct.
- Clear demo data: `wrangler d1 execute avian-detections --remote --command "DELETE FROM detections"`.

### Step 7 — ONLY if Step 4 fails: migrate to BirdNET-Go
- Install BirdNET-Go (single binary); set `config.yaml` (lat/long, sensitivity, confidence).
- **Rewrite the forwarder**: read Go's detections (its SQLite, or MQTT, or a webhook/custom action)
  → POST `{sci, com, conf, ts}` + `X-Avian-Secret` to `/api/detection`. Scientific name preserved
  (illustrations keyed to it).
- Disable BirdNET-Pi services; verify the new path end-to-end.

---

## Repo deliverables to add (so this is reproducible, not one-off SSH)
- **`pi/lean-mode.sh`** — script that performs Steps 1–2 (disable cruft + restore cmdline). Committable.
- **Update `CLAUDE.md` / `PLAN.md`**: the "512 MB is sufficient / detection-only is supported" note was
  **over-optimistic** — the edge design offloads web/render but NOT BirdNET's own ~190 MB footprint.
  Document the required stripping (this file) as the truth.

## Gotchas
- mDNS flaky → **use IP `192.168.0.29`**, not `inky.local`.
- **Don't restore `cmdline.txt` before disabling services** (re-thrash).
- **Cloudflare side (Worker / D1 / Pages / `/frame.png`) is DONE and was unaffected** — do not rebuild it.
- Remote writes to the Pi may hit the auto-mode permission classifier — needs Scott's explicit OK or a
  Bash permission rule for `ssh inky@192.168.0.29`.
- Hard rules unchanged: separate from foobos; D1 not KV; Pi outbound-only; CC-BY-NC-SA.
