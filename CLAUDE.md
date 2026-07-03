# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

This repo is **scott-friedman's fork of [AvianVisitors](https://github.com/Twarner491/AvianVisitors)**, checked out here as a **shallow (`--depth=1`) clone** (~1 GB; bulk is `avian/assets/` illustrations + `model/`). Remotes: `origin` → `scott-friedman/AvianVisitors` (the Pi pulls from here), `upstream` → `Twarner491/AvianVisitors`. Branch `avian-visitors` tracks `origin/avian-visitors`. Local work vs upstream includes this `CLAUDE.md`, **`PLAN.md`** (the ordered v1 build plan), the built `worker/` + `pi/`, the ported `frame/`, and `PI-RECOVERY.md` + `DEPLOY-SUDBURY.md`. **New session building this? Start with `PLAN.md`.** **Deploying the box to dad's in Sudbury? See `DEPLOY-SUDBURY.md`** (on-site checklist: wifi, mic, enable detection, verify remote access). **Hardening the box for unattended life (stability / remote-update / remote-access backlog from the 2026-06-19 code review)? See `REVIEW-TODO.md`** — two ⭐ items (liveness heartbeat, Pi update path) are best done before the box ships. **Sizing the screenshots to the matted picture-frame opening (the mat hides the panel's outer edge)? See `FRAME-MATTING-PLAN.md`** (cold-start runbook: push a ruler card, read the visible window, apply per-edge insets; needs the human in front of the panel).

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
                 ┌─ 🟣 E-INK (gentle, ~5 min) ─────────────────────────────┐
                 │  avian-worker renders frame.png (800×480) ← Pi pulls it  │
                 └─────────────────────────────────────────────────────────┘
```

- **Pi's entire job:** run BirdNET detection (writes its own SQLite) → on each detection, a hook **POSTs** {species, time, confidence} to `avian-worker` → and **pulls** `frame.png` for the panel every 5 minutes (the panel redraws only on change). All **outbound** — no open ports, no public serving from the Pi.
- **Live data freshness:** the page polls the Worker every ~5–10 s. That matches BirdNET's own latency floor (it analyses multi-second audio windows; slower on a Zero 2 W → ~5–15 s chirp-to-ID), so polling is the bottleneck-free sweet spot. SSE/WebSocket push is possible later but is overkill given the ML floor.
- **Why this shape:** kills the Zero 2 W's blockers — no local browser needed (render off-Pi), no public traffic hitting the Pi (edge serves it), frees RAM (no Caddy/PHP), and nothing inbound at the relative's house. It also sidesteps upstream's public Worker, which **is not in this repo** (the frontend assumes one — see `apt.js` references to `caches.default` / "every CF DC").

## Cloudflare resources (separate from foobos, same account)

Reuse foobos **patterns**, not its **resources**. Create bird's own, with new names/IDs; the repo's `wrangler.toml` references only these:

| Resource | bird (new) | (foobos, do not touch) |
|---|---|---|
| Pages project | `barrysbirds` (renamed from `avianvisitors` 2026-06-19) | `foobos` |
| Worker | `avian-worker` | `foobos-worker` |
| D1 database | `avian-detections` | `foobos-users` |
| R2 bucket | `avian-clips` (bird-call mp3s, 7-day TTL) | — |
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

- **Pages — TWO projects since 2026-07-02**: the site lives on **`avianvisitors`** (`wrangler pages deploy _site --project-name avianvisitors --branch avian-visitors`), served publicly ONLY via `indianridgeroad.com/birds/` (the ridge worker proxies `birds-origin.indianridgeroad.com`, this project's custom domain; `FRAME_URL`/`PAGES_BASE` in `worker/wrangler.toml` point there too). The old **`barrysbirds`** project is now a static 301 stub (`avian/legacy-stub/`, `--branch production`) redirecting legacy `barrysbirds.pages.dev` links → `indianridgeroad.com/birds/` — never deploy the real site there (the proxy would chase the stub's redirect in a loop). Deploys only on design/code changes.
- **Worker (`avian-worker`)**: owns `POST /api/detection` (hook ingest → D1 insert, secret-gated), `GET /api/recent` (+ stats/lifelist/timeseries — reimplement `avian/api/*.php` logic against **D1**), `POST /api/clip` (secret-gated → R2 clip upload) + `GET /api/recording` (R2 clip playback, Range/CORS), and `GET /frame.png` (Browser Rendering → screenshot the Pages collage → output **800×480 7-color** for the 7.3" panel).
- **Clip retention is two-tier (since 2026-07-03; `CLIP-RETENTION-PLAN.md`)**: `clips/<basename>` expires via the bucket's 7-day lifecycle rule (prefix-scoped, set in the dashboard not the repo), but `ingest()` copies each species' **first 25 lifetime clips** to `rare/<basename>` — no lifecycle rule, kept forever (≤1.1 MB/species ceiling). `/api/recording` reads `clips/` then falls back to `rare/` (and, for `?sci=`, to the species' oldest clip). A once-ever Veery keeps its recording; the 5000th wren doesn't pile up. Mojo is excluded (his cron self-heals from `master/`). Never put a lifecycle rule on `rare/` or `master/`.
- **Worker timezone is DST-correct via `TZ_NAME = "America/New_York"`** (computed per-hour with `Intl` in `tzOffsetHours()`; `TZ_OFFSET_HOURS` is only the fallback) — don't reintroduce fixed-offset math; the old static `-4` would have skewed every displayed time by 1 h each November.
- **D1 (`avian-detections`)**: detection rows. Use **D1, not KV** — KV's free tier is ~1k writes/day, too few for per-detection writes; D1's write limits are generous.

## Driving the e-ink display (`frame/`) — primary output

The panel is the headline output. **`frame/display.py` is hardcoded for a 13.3" Spectra 6 (1200×1600, 6-ink); our panel is 7.3" 7-color (800×480)** — the layout geometry/palette/matting must be **ported to 800×480**. In the edge design the heavy lifting moves to the Worker: it renders/dithers an 800×480 PNG, and the Pi's frame client just fetches and pushes it (no local browser — the Zero 2 W can't run one). Keep the cadence gentle (5-min poll, panel redraws only on change — `frame/systemd/birdframe.timer`) to protect the panel. Reference for driving this exact panel: inky's `display.py`/`image_processor.py` (7-color dither at 800×480) at `/Users/scott/inky`. Iterate off-Pi with `frame/display.py --preview out.png`.

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
3. **`apt.js` data-source swap**: from `./avian/api/*.php` → the Worker's `/api/*`. (Audio: **DONE 2026-06-20** — the Pi uploads each detection's mp3 to **R2 `avian-clips`** (7-day TTL) and `apt.js` plays it via `GET /api/recording`; no Pi serving. See `AUDIO-FIX-PLAN.md`.)
4. **Pages deploy workflow** (clone foobos `cf-deploy-pages.yml`, new `avianvisitors` project).
5. **Frame port** to 800×480 7-color + the Worker render at that geometry.
6. **`wrangler.toml`** with bird's own resource IDs; scoped CI token.

## Conventions & gotchas

- **License CC-BY-NC-SA-4.0 (non-commercial)** — don't propose commercial use.
- **No mic ⇒ no detections** — the #1 failure mode.
- **Detected ≠ shown** — the collage renders only species that have illustration art (`avian/assets/illustrations/<sci>.png`). A detected bird with **no art** still logs to D1 and appears in stats/lifelist, but is **invisible in the collage**. The bundled 249-species set skews boreal and **misses common eastern-MA backyard birds** (Cardinal, Blue Jay, Chickadee, Titmouse, Red-bellied Woodpecker, Grackle, Carolina Wren, Catbird, E. Bluebird, WT Sparrow). **The exact gap (46 land species, ranked by Sudbury detection frequency) + per-bird progress is tracked in `SUDBURY-ART-TODO.md`** (derived from the BirdNET range model; pipeline `pregen.py` → `avian/scripts/keycut.py` (NOT `cutout.py` — its onnxruntime hangs on this Mac) → rebuild → redeploy). Add art via the `avian/scripts/` Gemini pipeline → rebuild → redeploy Pages — fully decoupled from the Pi (past detections render retroactively). Gotcha: Cloudflare Pages serves a **200 HTML fallback** for a missing `.png`, so probe art by `content-type`/local file, not HTTP status.
- **Song signatures are a build-time Pages artifact** — the modal "song signature" bloom is a *canonical* per-species fingerprint precomputed from a clean **xeno-canto** song by `avian/scripts/build-signatures.mjs` (Node+ffmpeg) → `avian/assets/signatures.json` + bundled `avian/assets/songs/<slug>.mp3` (tap-to-play). NOT extracted from our noisy R2 clips. Re-run to expand coverage (incremental; `--force`/`--only`). The shared STFT lives in `avian/frontend/spectral-core.js` (browser + the build script both use it). Needs the xeno-canto v3 key at `~/.config/avian/xeno-canto-key` (600). **DSP rule learned 2026-06-21: compute energy/pitch from LINEAR POWER, never the dB grid** (dB summed over a linear-frequency band pins every dominant near the ceiling). Full story: `SPECTRO-CONCEPTS-PLAN.md`.
- **512 MB tuning is mandatory** — even *detection-only* untuned OOM-thrashes the Zero 2 W unreachable (RAM, not CPU, is the bottleneck). The real fixes are **swap (zram) + numba cache hygiene + clearing the StreamData backlog**, not stripping services. Applied by `pi/zero2w-tune.sh`; see `PI-RECOVERY.md`.
- **BirdNET-Pi's stock 95%-disk purge silently no-ops on the lean box** (found 2026-07-03): `scripts/disk_check.sh` hard-exits unless the web-UI-created `scripts/disk_check_exclude.txt` exists — and lean-mode stripped the web UI. Meanwhile `~/BirdSongs/Extracted` grows ~420 MB/day (mp3 + spectrogram PNG per detection) → SD full in ~8 months with the heartbeat still green. Fixed: `pi/prune-extracted.sh` + `avian-prune.timer` (daily, deletes `By_Date` day-dirs >30 days by NAME) and `pi/update.sh` creates the exclude file as a backstop. See `pi/README.md` → "Disk prune".
- **D1, not KV**, for detection writes (KV free tier ≈ 1k writes/day).
- **Separate from foobos** — never reference foobos resource IDs in this repo's `wrangler.toml`; same account, but pooled free-tier quotas.
- **BirdNET latency floor** (~5–15 s on a Zero 2 W) is why ~5–10 s polling is sufficient — don't over-engineer push.
- **Frame geometry is hardcoded for 13.3"** — must port before `frame/` works on the 7.3" panel.
- **Pi is outbound-only** — it pushes detections and pulls `frame.png`; it must not be made to serve the public site.
- **D1 planner full-scan trap (bit us 2026-07-03)** — windowed `GROUP BY sci` / `COUNT(DISTINCT sci)` queries choose `idx_detections_dedupe` and scan the WHOLE detections table unless pinned with `INDEXED BY idx_detections_ts`; at 16k rows + the 30-s `refreshAll()` poll that hit ~108M D1 rows read/day and reset-looped D1's storage object (multi-minute 500 bursts on every endpoint → dropped detections, heartbeat flaps). Fixes live in `worker/src/index.js`: index pins on the mis-planned queries, an isolate-memory **poll micro-cache** for the 9 polled read endpoints (keyed on params + `MAX(ts)` + 5-min bucket; a new detection busts it instantly; `X-Poll-Cache: hit` header for probing), and dispatch-level retries on transient `D1_ERROR …reset` (all routes idempotent; `/frame.png` excluded — a retry would double-bill Browser Rendering). Health check: `wrangler d1 info avian-detections` → `rows_read_24h` should sit in the low millions; 9 digits means some query is full-scanning again. New windowed aggregate queries must verify their plan (`EXPLAIN QUERY PLAN … --remote`) and join the cache set if polled.
- **Cloudflare 403's the default Python-`urllib` User-Agent** — any ad-hoc script that GETs `avian-worker` (a diagnostic, a monitor polling `/api/status` + `/api/recent`) must set a `User-Agent` header or it silently gets `403 Forbidden` (curl is unaffected; the shipped `pi/detection-forwarder.py` + `frame/display.py` already set one). Cost a debug cycle 2026-06-19.
- **A Pages deploy is NOT immediately visible** (learned 2026-07-03): both `birds-origin.indianridgeroad.com` (a zone custom domain) and the ridge `/birds/` proxy edge-cache assets for **24 h**, and a Pages deploy purges neither. Symptom: a new species renders in the atlas/modal but **not the collage** (its DIMS/MASKS live inside the stale `apt.js`). Fix shipped: `avian/build-site.sh` stamps `?v=<content-hash>` onto the shell asset URLs in `index.html` (apt.js, styles.css, spectral-core.js, config.js), so changed files get fresh cache keys automatically; the HTML itself propagates in ≤5 min (origin `must-revalidate`; proxy TTL 300 s).
- **Mojo (`Canis volaticus`, com "Mojo") is FAKE ON PURPOSE** — the family-dog easter egg, live 2026-07-03. Art `canis-volaticus[-2].png` (flight forced on the collage via `FORCE_POSE`, perched in the modal via `MODAL_POSE`, both in `apt.js`); a Worker **cron** (`[triggers]` in `worker/wrangler.toml`) inserts daytime "detections" so he's always within the 1-h frame window, and self-heals his bark clip in R2 (`master/mojo-bark.mp3` → `clips/…`); `/api/wiki` special-cases his description. Do NOT "fix", dedupe, or delete him; full removal steps are in the `MOJO` block in `worker/src/index.js`.
- **This site is reverse-proxied at `indianridgeroad.com/birds/`** (separate repo `~/indianridge`, Worker `ridge`, live 2026-07-02 — see its `PLAN.md`). Two constraints on THIS repo: (1) **keep frontend URLs relative** — any new root-absolute `href="/..."`/`src="/..."` in `avian/frontend/` breaks under the `/birds/` prefix (the single existing `href="/"` at `index.html:39` is patched in-flight by the ridge worker's HTMLRewriter; don't add more); (2) `avian/assets/sketches/` is no longer orphaned — indianridge copied 6 flight sketches as its sky birds + style refs (CC BY-NC-SA attribution in its `ATTRIBUTION.md`). The proxy points at `birds-origin.indianridgeroad.com` (custom domain on the `avianvisitors` Pages project) via a `[vars]` entry — moving that domain or renaming the project means updating `~/indianridge/wrangler.toml` too.
