# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repo is **scott-friedman's fork of [AvianVisitors](https://github.com/Twarner491/AvianVisitors)**, checked out here as a **shallow (`--depth=1`) clone** (~1 GB; bulk is `avian/assets/` illustrations + `model/`). Remotes: `origin` → `scott-friedman/AvianVisitors` (the Pi pulls from here), `upstream` → `Twarner491/AvianVisitors`. Branch `avian-visitors` tracks `origin/avian-visitors`. Local work vs upstream includes this `CLAUDE.md`, **`PLAN.md`** (the ordered v1 build plan), the built `worker/` + `pi/`, the ported `frame/`, and `PI-RECOVERY.md` + `DEPLOY-SUDBURY.md`. **New session building this? Start with `PLAN.md`.** **Deploying the box to dad's in Sudbury? See `DEPLOY-SUDBURY.md`** (on-site checklist: wifi, mic, enable detection, verify remote access). **Hardening the box for unattended life (stability / remote-update / remote-access backlog from the 2026-06-19 code review)? See `REVIEW-TODO.md`** — two ⭐ items (liveness heartbeat, Pi update path) are best done before the box ships.

This directory is the **dev copy** (Mac). The **detection software runs on the Pi at `~/BirdNET-Pi`**; the **public site + e-ink rendering run on Cloudflare** (see "Decided architecture"). Don't conflate the three.

## Overview (plain English)

This turns a Raspberry Pi into a "bird visitors" display. A USB mic listens 24/7; BirdNET (machine-learning audio ID) recognizes nearby birds, and they appear as a live, growing collage of illustrated birds — on a public web page **and** on an e-ink picture frame (the headline output). The Pi lives at Scott's dad's house in Sudbury, MA, so it does as little as possible: it just **listens, reports each bird to the cloud, and downloads a finished picture for the frame.** The website and the heavy image work run on Cloudflare, not the Pi.

## Decided architecture (THIS deployment — read first)

We do **not** run stock AvianVisitors (which serves the collage from the Pi via Caddy/PHP). Instead the Pi only detects, and everything public runs on **Cloudflare**, mirroring the patterns Scott already uses in the `foobos`/`sandbag` project (Pages + Worker + D1 + GitHub Actions) — but with **its own separate resources** (see "Cloudflare resources").

**Three lanes, different speeds:**

```
                 ┌─ 🟢 LIVE DATA (~5–10 s) ────────────────────────────────┐
 chirp → BirdNET │  on-detection hook → POST → avian-worker → D1            │
 (on the Pi,     │                                   └→ GET /api/recent ────┼→ page polls ~5–10 s
  several sec)   └─────────────────────────────────────────────────────────┘
                 ┌─ ⚪ STATIC SHELL (rare) ─────────────────────────────────┐
                 │  collage HTML/JS/CSS + 498 illustrations → Cloudflare    │
                 │  Pages, deployed only on design/code change (GH Action)  │
                 └─────────────────────────────────────────────────────────┘
                 ┌─ 🟣 E-INK (gentle, ~1–2 min) ───────────────────────────┐
                 │  avian-worker renders frame.png (800×480) ← Pi pulls it  │
                 └─────────────────────────────────────────────────────────┘
```

- **Pi's entire job:** run BirdNET detection (writes its own SQLite) → on each detection, a hook **POSTs** {species, time, confidence} to `avian-worker` → and **pulls** `frame.png` for the panel every minute or two. All **outbound** — no open ports, no public serving from the Pi.
- **Live data freshness:** the page polls the Worker every ~5–10 s. That matches BirdNET's own latency floor (it analyses multi-second audio windows; slower on a Zero 2 W → ~5–15 s chirp-to-ID), so polling is the bottleneck-free sweet spot. SSE/WebSocket push is possible later but is overkill given the ML floor.
- **Why this shape:** kills the Zero 2 W's blockers — no local browser needed (render off-Pi), no public traffic hitting the Pi (edge serves it), frees RAM (no Caddy/PHP), and nothing inbound at the relative's house. It also sidesteps upstream's public Worker, which **is not in this repo** (the frontend assumes one — see `apt.js` references to `caches.default` / "every CF DC").

## Cloudflare resources (separate from foobos, same account)

Reuse foobos **patterns**, not its **resources**. Create bird's own, with new names/IDs; the repo's `wrangler.toml` references only these:

| Resource | bird (new) | (foobos, do not touch) |
|---|---|---|
| Pages project | `barrysbirds` (renamed from `avianvisitors` 2026-06-19) | `foobos` |
| Worker | `avian-worker` | `foobos-worker` |
| D1 database | `avian-detections` | `foobos-users` |
| Host | `barrysbirds.pages.dev` (free) or own domain | `foobos.net` |

- Start on the free `*.pages.dev` / `*.workers.dev` hostnames — fully isolated, not even a shared DNS zone. Add a custom domain later.
- Give the bird GitHub Action a **Cloudflare API token scoped to bird's resources** so CI can't touch foobos.
- Caveat: same account ⇒ **free-tier quotas are pooled** (Workers req/day, D1, Browser Rendering). Bird's load is negligible; just know the meter is shared.

## What this project is (and isn't)

`bird` is **AvianVisitors** = a custom overlay (`avian/`) on **[BirdNET-Pi](https://github.com/Nachtzuster/BirdNET-Pi)** (Nachtzuster fork): realtime acoustic classification (BirdNET + TFLite), SQLite, and ~498 bundled illustrations (249 species × perched/flight). We use **BirdNET-Pi for detection** and the **`avian/` frontend + assets as the basis for the Cloudflare-hosted collage** — but NOT its on-Pi Caddy/PHP hosting path. Public reference deployment: `https://bird.onethreenine.net`. License: **CC-BY-NC-SA-4.0, non-commercial only**.

## Hardware (confirmed)

Probed `inky@inky.local` (2026-06-18): **Raspberry Pi Zero 2 W Rev 1.0**, **512 MB RAM**, **aarch64**, **Debian 12 Bookworm**, **Python 3.11.2**. Pimoroni Inky Impression **7.3" (800×480, 7-color)** on the 40-pin header (inky-web drives it today).

- **OS passes** the installer (aarch64 + Bookworm + Py ≥ 3.10) — **no reflash required**.
- **512 MB is the hard constraint.** The edge architecture offloads the website + render but **NOT BirdNET's own ~150 MB analyzer** — so *stripping services alone is not enough* (it saves only tens of MB; the full stack OOM-thrashed the box unreachable on 2026-06-19). A Zero 2 W runs detection-only **only after the 512 MB tuning** in `pi/zero2w-tune.sh` (zram swap, mono/30 s recording, `gpu_mem=16`, watchdog). **With** that tuning it is stable — measured steady-state: ~370 MB used / ~90 MB free, analyzer plateaus ~150 MB, keeps up with realtime (no Pi 4 needed). The real enabler is **swap (the required Zero-2-W step) + cache hygiene**, not stripping. See `PI-RECOVERY.md`.
- **USB mic** — attached + working 2026-06-19 (KTMicro UAC 1.0, ALSA card 1; `REC_CARD=default` so arecord records *through* PulseAudio — direct `plughw` collides with the pulse the recording script auto-starts → "Device or resource busy" crash-loop). The Zero 2 W's only data port is **micro-USB OTG** → needs a **micro-USB→USB-A OTG adapter**; USB audio is class-compliant.

## Repo layout (verified)

```
newinstaller.sh        # installs BirdNET-Pi to ~/BirdNET-Pi (use it for the detection engine)
avian/
  frontend/            # collage UI (apt.js etc.) — BASIS for the Cloudflare Pages static shell
  assets/              # illustrations/, cutouts/, sketches/ — served as static Pages assets
  api/                 # stock PHP shims (birdnet-api.php …) — reference for the Worker's /api logic
  scripts/             # Gemini illustration pipeline (generate→cutout→masks); see avian/scripts/README.md
  forwarding/          # cloudflared.yml etc. — repurpose only for SSH admin, not public web
frame/                 # e-ink: display.py, config.example.toml, systemd/, hardware/ (CAD is for 13.3")
homepage/  model/  templates/  docs/  tests/
```
Authoritative upstream docs: `README.md`, `frame/README.md`, `avian/forwarding/README.md`, `avian/scripts/README.md`.

## Pi setup (detection only)

> **⚠️ 512 MB tuning is MANDATORY** (learned 2026-06-19). After installing BirdNET-Pi, run `pi/lean-mode.sh` (strip to detection-only) then `pi/zero2w-tune.sh` (zram swap, mono/30 s recording, `gpu_mem=16`, watchdog) and reboot — otherwise the box OOM-thrashes itself unreachable. Also clear any `~/BirdSongs/StreamData/*.wav` backlog before going live. Full story + measured numbers: `PI-RECOVERY.md`.

1. Plug in the USB mic (via OTG adapter). Install BirdNET-Pi:
   `curl -s https://raw.githubusercontent.com/Twarner491/AvianVisitors/avian-visitors/newinstaller.sh | bash` (clones to `~/BirdNET-Pi`, reboots). Point origin at the fork: `git -C ~/BirdNET-Pi remote set-url origin https://github.com/scott-friedman/AvianVisitors.git`.
2. Configure BirdNET locally via its admin UI (`http://inky.local/index.php`): mic/sound card, region/Database Language, sensitivity. We use only the detection engine + SQLite; the on-Pi public collage/Caddy is unused.
3. Add the **on-detection hook** (BirdNET-Pi runs a script per new detection) that POSTs the detection to `avian-worker` with a shared secret. *(v1 build — not yet written.)*
4. **Remote admin (LIVE):** `ssh bird-pi` from any machine with `cloudflared` — Cloudflare Tunnel `avian-admin` → `bird-ssh.foobos.net` → the Pi's sshd, service enabled@boot. **Password-gated, no Access app** (Scott's choice — flexible across computers, not tied to one key/email; the tunnel hides SSH from internet port-scanning, so a strong `inky` password is the gate). Built via `pi/tunnel-setup.sh` (see `pi/README.md` for redo gotchas: headless login fails → run it on the Mac + scp the cert; use a single-level subdomain). Admin DNS uses the **foobos.net** zone (DNS-only; no shared Workers/D1). Updates: `bash ~/BirdNET-Pi/pi/update.sh` (git pull + re-sync units + restart; see `pi/README.md` → "Updating the Pi").

## Cloudflare side (public site + render)

- **Pages (`barrysbirds`, renamed from `avianvisitors` 2026-06-19)**: the static collage shell (adapted `avian/frontend/` + `avian/assets/`), built by `avian/build-site.sh` then `wrangler pages deploy _site --project-name barrysbirds --branch production` (run from `worker/` so the local wrangler resolves). Deploys only on design/code changes.
- **Worker (`avian-worker`)**: owns `POST /api/detection` (hook ingest → D1 insert, secret-gated), `GET /api/recent` (+ stats/lifelist/timeseries — reimplement `avian/api/*.php` logic against **D1**), and `GET /frame.png` (Browser Rendering → screenshot the Pages collage → output **800×480 7-color** for the 7.3" panel).
- **D1 (`avian-detections`)**: detection rows. Use **D1, not KV** — KV's free tier is ~1k writes/day, too few for per-detection writes; D1's write limits are generous.

## Driving the e-ink display (`frame/`) — primary output

The panel is the headline output. **`frame/display.py` is hardcoded for a 13.3" Spectra 6 (1200×1600, 6-ink); our panel is 7.3" 7-color (800×480)** — the layout geometry/palette/matting must be **ported to 800×480**. In the edge design the heavy lifting moves to the Worker: it renders/dithers an 800×480 PNG, and the Pi's frame client just fetches and pushes it (no local browser — the Zero 2 W can't run one). Keep the cadence gentle (~1–2 min, only on change) to protect the panel. Reference for driving this exact panel: inky's `display.py`/`image_processor.py` (7-color dither at 800×480) at `/Users/scott/inky`. Iterate off-Pi with `frame/display.py --preview out.png`.

## Local development (Mac)

- **Collage shell** (`avian/frontend/`): preview in a browser against a sample `/api/recent` JSON.
- **Worker**: `wrangler dev` with a local D1.
- **Pipeline** (`avian/scripts/`): Python; runs locally (needs `GEMINI_API_KEY` to generate).
- **Frame look**: `python3 frame/display.py --preview out.png` (no panel needed).
- No full on-Mac run of detection (BirdNET/audio is Pi-only).

## Relationship to inky

The Pi currently runs **inky-web** (separate Flask project at `/Users/scott/inky`, systemd `inky-web`, gunicorn :5000) which owns the panel. inky is the **prior occupant, not a template**:
- **Display contention:** only one process owns the SPI/GPIO panel — **disable inky-web** (`sudo systemctl disable --now inky-web`) so the frame client owns it.
- **OS already qualifies** (Bookworm 64-bit) — installing BirdNET-Pi alongside needs no reflash.
- **One useful reuse:** inky's `display.py`/`image_processor.py` as the reference for driving the 7.3" 7-color panel when porting `frame/`.

## v1 build scope (not yet written)

1. **Pi on-detection hook** → `POST /api/detection` (shared secret).
2. **`avian-worker`** with `/api/detection`, `/api/recent`, `/frame.png`, backed by **D1 (`avian-detections`)**.
3. **`apt.js` data-source swap**: from `./avian/api/*.php` → the Worker's `/api/*` (audio playback via `recording.php` is the one piece still needing the Pi — defer or publish clips).
4. **Pages deploy workflow** (clone foobos `cf-deploy-pages.yml`, new `avianvisitors` project).
5. **Frame port** to 800×480 7-color + the Worker render at that geometry.
6. **`wrangler.toml`** with bird's own resource IDs; scoped CI token.

## Conventions & gotchas

- **License CC-BY-NC-SA-4.0 (non-commercial)** — don't propose commercial use.
- **No mic ⇒ no detections** — the #1 failure mode.
- **Detected ≠ shown** — the collage renders only species that have illustration art (`avian/assets/illustrations/<sci>.png`). A detected bird with **no art** still logs to D1 and appears in stats/lifelist, but is **invisible in the collage**. The bundled 249-species set skews boreal and **misses common eastern-MA backyard birds** (Cardinal, Blue Jay, Chickadee, Titmouse, Red-bellied Woodpecker, Grackle, Carolina Wren, Catbird, E. Bluebird, WT Sparrow). Add art via the `avian/scripts/` Gemini pipeline → rebuild → redeploy Pages — fully decoupled from the Pi (past detections render retroactively). Gotcha: Cloudflare Pages serves a **200 HTML fallback** for a missing `.png`, so probe art by `content-type`/local file, not HTTP status.
- **512 MB tuning is mandatory** — even *detection-only* untuned OOM-thrashes the Zero 2 W unreachable (RAM, not CPU, is the bottleneck). The real fixes are **swap (zram) + numba cache hygiene + clearing the StreamData backlog**, not stripping services. Applied by `pi/zero2w-tune.sh`; see `PI-RECOVERY.md`.
- **D1, not KV**, for detection writes (KV free tier ≈ 1k writes/day).
- **Separate from foobos** — never reference foobos resource IDs in this repo's `wrangler.toml`; same account, but pooled free-tier quotas.
- **BirdNET latency floor** (~5–15 s on a Zero 2 W) is why ~5–10 s polling is sufficient — don't over-engineer push.
- **Frame geometry is hardcoded for 13.3"** — must port before `frame/` works on the 7.3" panel.
- **Pi is outbound-only** — it pushes detections and pulls `frame.png`; it must not be made to serve the public site.
