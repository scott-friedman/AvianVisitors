# AvianVisitors (bird) — v1 Build Plan

> **For a fresh Claude Code session.** Read `CLAUDE.md` first — it holds the full decided architecture. This file is the **ordered, executable build plan**. It was written to hand off from a planning session without carrying its context. Everything here is decided unless marked "OPEN".
>
> **⚠️ 2026-06-19 — the Pi hit a memory crisis.** BirdNET-Pi's full stack is too heavy for the 512 MB Zero 2 W; it thrashed unreachable and was recovered via an SD-card boot edit. **If you're doing any Pi work, start with `PI-RECOVERY.md`, not the "Phase 2 done" status below.** The Cloudflare side (Worker/D1/Pages/frame) is unaffected.

---

## Plain English summary (for a non-technical reader)

We're turning a small Raspberry Pi at Scott's dad's house into a "bird visitors" display. A USB microphone listens all day; machine-learning software figures out which birds are singing, and they show up as a live collage of illustrated birds — both on a **web page** anyone can visit and on an **e-ink picture frame** on the wall (the main attraction).

To keep the tiny Pi happy, it does as little as possible: it just **listens, tells the cloud "I heard a robin," and downloads a finished picture for the frame.** All the website hosting and image-making happens on **Cloudflare** (Scott's existing account, but in its own separate space — nothing shared with his other project, "foobos"). When a bird is heard, the website updates within about **5–10 seconds**.

What Scott will notice when it's done: visit a web link → see birds appear live as they're heard; glance at the frame → see today's birds, refreshed every minute or two.

---

## How to start (new session)

1. Read `CLAUDE.md` (architecture, hardware facts, constraints).
2. Skim "Current state" and "Prerequisites" below.
3. **Phases 0/1/3 live; Phase 4 CLOUD done (`/frame` view + `/frame.png` deployed + verified).** Read "Current state (snapshot)" for the live resources + the exact remaining steps. The remaining work is **Phase 4 Pi install** (Pi is reachable; needs Scott's OK to take the panel from inky-web), **Phase 2** (needs USB mic), and **Phase 5** (needs Scott's scoped CF token).
4. Each phase has a **Goal → Steps → Done when → Needs Scott**. Stop and ask on anything marked OPEN or "Needs Scott".

---

## Current state (snapshot) — updated 2026-06-19 (Cloudflare side DONE & verified; **Pi BirdNET-Pi hit a 512 MB memory crisis → see `PI-RECOVERY.md`**; USB mic + Phase 5 token still remain)

**Deployed & verified on Cloudflare** (account `78b235c12ec2f4d437534392b48ed173`, via wrangler OAuth; isolated from foobos):

| Resource | Value |
|---|---|
| Worker | `avian-worker` → https://avian-worker.s-friedman.workers.dev |
| D1 | `avian-detections` id `9145557b-fbe3-43f5-baf8-ff0bb14c1a3f` (ENAM). Schema `detections(id,sci,com,conf,ts)`, ts=unix UTC. Migration `worker/migrations/0001_init.sql` applied `--remote`. |
| Pages | `avianvisitors` → https://avianvisitors.pages.dev (prod branch `avian-visitors`) |
| Ingest secret | `AVIAN_INGEST_SECRET` set on the worker; plaintext gitignored at `worker/.avian-ingest-secret` — the Pi needs the same value in the `X-Avian-Secret` header. |

- **Repo**: branch `avian-visitors` on `origin` (`scott-friedman/AvianVisitors`). Commits: plan · worker · worker-deploy · pages · frame-port · this status update.
- **Demo data**: 6 species seeded in prod D1 so the page isn't blank pre-Pi. Clear when the Pi goes live: `wrangler d1 execute avian-detections --remote --command "DELETE FROM detections"`.
- **Pi**: Zero 2 W at `inky@inky.local`. **BirdNET-Pi installed** (services up; admin UI http://inky.local/ → set sound card + region here; origin repointed to scott-friedman fork). **Frame client live on the panel** (`~/birdframe`, reuses `inky-web`'s venv; inky-web disabled; hourly timer). **Forwarder live** (`~/avian/detection-forwarder.py`, tails `BirdDB.txt` → worker; tested end-to-end). **No USB mic yet** ⇒ no real detections.
- **Local tooling**: `wrangler` authed (OAuth, account-wide — careful re foobos), `gh` (scott-friedman), Cloudflare MCP, **Google Chrome.app** (off-Pi frame previews), Pillow 11.3.

**Per-phase status:** 0 ✅ · 1 ✅ · 2 ✅ (BirdNET-Pi installed; forwarder live + tested end-to-end — real audio needs the mic) · 3 ✅ · 4 ✅ (frame rendering off-Pi + physically on the panel, hourly) · 5 ⛔ needs Scott's scoped CF token.

**Phase 4 cloud — DONE (2026-06-19):** (a) `?frame=1` strips chrome to a pure-white, animation-free collage (inline script+`<style>` in `avian/frontend/index.html`; apt.js untouched) — Pages deployed. (b) Worker `GET /frame.png` Browser-Renders that view at 800×480, signature-caches the PNG in D1 `frame_cache`, FRAME_KEY-gated — deployed + verified (401 w/o key, miss→hit, dithers to exactly 7 colours). **Browser Rendering confirmed available on the Workers FREE plan** (10 min/day) — the "may need Paid" worry is resolved. Deps: `@cloudflare/puppeteer`, `nodejs_compat` flag, `FRAME_URL` var, `FRAME_KEY` secret (gitignored `worker/.avian-frame-key`).

**Remaining work (cold-start pickup):**
1. **USB mic + OTG adapter** (hardware — the only thing gating real birds): plug in → `arecord -l` shows a capture device → set sound card + region at http://inky.local/ → real detections flow automatically (forwarder + frame already wired + tested). Then clear the demo data (`DELETE FROM detections`) and set the worker's `TZ_OFFSET_HOURS` to the Pi's offset (EDT = `-4`) for correct day-buckets.
2. **Phase 5** (needs Scott's scoped CF token): SSH-only Cloudflare Tunnel for admin; CI token → GitHub secrets `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` (workflows already written: `.github/workflows/cf-deploy-{pages,worker}.yml`).

**Deviation logged:** dithering runs on the Pi (Inky `set_image`), not the Worker as CLAUDE.md's diagram says — 7-colour dither in a Worker is impractical, so the Worker serves a clean 800×480 PNG and the Pi dithers. "No browser on the Pi" still honored (rendering is off-Pi).

## Decisions locked (do not re-litigate — see CLAUDE.md for rationale)

- All-Cloudflare, **separate resources** from foobos (same account). Reuse foobos *patterns* in `/Users/scott/sandbag` (`worker/wrangler.toml`, `.github/workflows/cf-deploy-pages.yml`, `cf-update-concerts.yml`) as templates.
- **Three lanes**: live data (Pi hook → `avian-worker` → D1 → page polls ~5–10 s) · static shell (Pages, rare deploys) · e-ink (rendered off-Pi, Pi pulls).
- **D1, not KV** for detections. **Pi is outbound-only.** **~5–10 s polling** (no SSE in v1). **Zero 2 W stays** (no Pi 4).
- New resource names: Pages `avianvisitors` · Worker `avian-worker` · D1 `avian-detections` · host `avianvisitors.pages.dev` (free) to start.

## Prerequisites (Needs Scott — gate the relevant phases)

- **Hardware**: USB lavalier mic + **micro-USB→USB-A OTG adapter** for the Pi (gates real detections in Phase 2).
- **Cloudflare**: a **scoped API token** (Workers + Pages + D1 edit, bird only) + account ID, added as GitHub secrets `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` on `scott-friedman/AvianVisitors`. Needed to deploy the Worker/Pages from CI. (D1 *creation* can be done now via the Cloudflare MCP tool with Scott's go-ahead.)
- **Shared secret** `AVIAN_INGEST_SECRET` (random string) — GitHub secret + stored on the Pi; gates `POST /api/detection`.

---

## Phase 0 — Save the plan (5 min)  ·  ✅ DONE

- **Goal**: the locked plan is committed so the handoff is durable.
- **Steps**: `git -C /Users/scott/bird add CLAUDE.md PLAN.md` → commit (message ends with the required Co-Authored-By / Claude-Session trailers). Push to `origin` **only if Scott confirms** (outward-facing, public fork).
- **Done when**: `git log` shows the commit; `git status` clean except ignored files.
- **Needs Scott**: confirm push.

## Phase 1 — Cloudflare spine  ·  ✅ DONE (live: avian-worker.s-friedman.workers.dev + D1 avian-detections)

- **Goal**: a deployed `avian-worker` + `avian-detections` D1 that ingests and serves detections, testable by curl.
- **Steps**:
  1. Create `worker/` in the repo: `wrangler.toml` (name `avian-worker`, **new** D1 binding — placeholder `database_id`), `src/index.js`, `migrations/0001_init.sql`, `package.json`. Model on `/Users/scott/sandbag/worker/` but with bird's own names/IDs.
  2. D1 schema (`migrations/0001_init.sql`):
     ```sql
     CREATE TABLE IF NOT EXISTS detections (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       sci TEXT NOT NULL,            -- scientific name
       com TEXT NOT NULL,            -- common name
       conf REAL NOT NULL,           -- confidence 0..1
       ts INTEGER NOT NULL           -- unix seconds (UTC)
     );
     CREATE INDEX IF NOT EXISTS idx_detections_ts ON detections(ts);
     ```
  3. Worker routes:
     - `POST /api/detection` — header `X-Avian-Secret` must equal `AVIAN_INGEST_SECRET`; body `{sci,com,conf,ts}` → insert into D1. Return 204.
     - `GET /api/recent?hours=N` — recent detections (species + counts + last-seen) as JSON. Also stub `?action=stats|lifelist|timeseries` to match what `apt.js` expects (reimplement `avian/api/birdnet-api.php` logic against D1; read that PHP as the spec).
     - CORS: allow GET from the Pages origin.
  4. Provision D1: via Cloudflare MCP `d1_database_create` (name `avian-detections`) **or** `wrangler d1 create avian-detections`; paste the real `database_id` into `wrangler.toml`; apply the migration (`wrangler d1 migrations apply avian-detections --remote` or MCP `d1_database_query`).
  5. Set the secret: `wrangler secret put AVIAN_INGEST_SECRET`. Deploy: `wrangler deploy`.
- **Done when**: `curl -X POST .../api/detection` with the secret inserts a row, and `GET /api/recent` returns it. Verify the row via MCP `d1_database_query`.
- **Needs Scott**: Cloudflare token/auth for deploy (D1 create can be MCP-driven with his ok).

## Phase 2 — Pi: detection engine + hook (needs Pi + mic)  ·  ⛔ BLOCKED (no mic)

- **Goal**: every real BirdNET detection POSTs to `/api/detection`.
- **Steps**:
  1. Scott attaches the mic (OTG adapter). Verify: `ssh inky@inky.local 'arecord -l'` shows a capture device.
  2. Install BirdNET-Pi: `ssh inky@inky.local` → `curl -s https://raw.githubusercontent.com/Twarner491/AvianVisitors/avian-visitors/newinstaller.sh | bash` (clones to `~/BirdNET-Pi`, reboots, ~20–40 min). Then `git -C ~/BirdNET-Pi remote set-url origin https://github.com/scott-friedman/AvianVisitors.git`.
  3. Configure via `http://inky.local/index.php`: sound card, region/Database Language, sensitivity.
  4. **Find the per-detection hook** (RESEARCH STEP — verify, don't assume): inspect `~/BirdNET-Pi/scripts/` and the analysis service; the Nachtzuster fork supports Apprise/notifications and post-detection scripts. Attach a small script that reads the new detection and `curl`s `POST /api/detection` with `X-Avian-Secret` (secret from a Pi-local file, not in git).
  5. Handle backfill/dedupe so restarts don't double-post (the Worker can also dedupe by `(sci, ts)`).
- **Done when**: a real (or hand-triggered) detection appears via `GET /api/recent` within seconds.
- **Needs Scott**: mic attached; confirm the BirdNET install reboot.
- **OPEN**: exact hook mechanism in the Nachtzuster fork — confirm during step 4.

## Phase 3 — Static collage on Cloudflare Pages  ·  ✅ DONE (live: avianvisitors.pages.dev)

- **Goal**: public collage at `avianvisitors.pages.dev` reading live data from `avian-worker`.
- **Steps**:
  1. Build the Pages site from `avian/frontend/` + `avian/assets/` (+ `homepage/` as needed). **Repoint `apt.js`** data calls from `./avian/api/*.php` → the Worker's `/api/*` (configurable base URL).
  2. Bird illustrations/cutouts ship as **static Pages assets** (they're pre-generated in `avian/assets/`); replace `cutout.php` image URLs with static paths.
  3. Create a GitHub Action cloned from `/Users/scott/sandbag/.github/workflows/cf-deploy-pages.yml`: assemble `_site/`, `wrangler pages deploy _site --project-name=avianvisitors`. Triggers on push to design/code paths only.
  4. Create the Pages project (`wrangler pages project create avianvisitors` or dashboard).
- **Done when**: visiting the Pages URL shows the collage; new detections appear within ~5–10 s (poll).
- **Needs Scott**: Cloudflare token in CI; confirm Pages project name/host.
- **DEFERRED**: per-bird **audio playback** (`recording.php`) needs the live Pi — defer to v2 (publish clips or add a narrow tunnel).

## Phase 4 — E-ink frame (primary output)  ·  🟢 CLOUD DONE (`/frame` view + `/frame.png` live + verified; Pi install remains — needs Scott's OK to take the panel from inky-web)

- **Goal**: the 7.3" panel shows today's birds, rendered off-Pi.
- **Steps**:
  1. Worker `GET /frame.png`: use **Cloudflare Browser Rendering** to screenshot the Pages collage → output **800×480** sized/dithered for the **7.3" 7-color** panel. Cache; only re-render on change.
  2. **Port `frame/display.py`** from 13.3" Spectra-6 (1200×1600, 6-ink) to **800×480 7-color**: geometry, palette, matting. Reference: inky's `/Users/scott/inky/src/inky_web/{display.py,image_processor.py}`. Iterate with `frame/display.py --preview out.png`.
  3. On the Pi: configure `~/.birdframe/config.toml` with `image_url = <worker>/frame.png`; install `frame/` via `frame/install.sh` (systemd timer; set cadence ~1–2 min). **`shoot=true` is NOT usable** (Zero 2 W has no browser).
  4. **Disable inky-web** so the frame client owns the panel: `sudo systemctl disable --now inky-web`.
- **Done when**: a detected bird appears on the physical panel within ~1–2 min; refresh only on change.
- **Needs Scott**: physical access to confirm the panel renders; ok to disable inky-web.

## Phase 5 — Remote admin + hardening  ·  ⛔ BLOCKED (needs Pi)

- **Goal**: Scott can manage/update the Pi remotely; bird is isolated from foobos.
- **Steps**:
  1. **SSH-only Cloudflare Tunnel + Access** for admin (repurpose `avian/forwarding/cloudflared.yml`; no public web ingress). Document the hostname + `~/.ssh/config` in CLAUDE.md.
  2. **Update flow**: `ssh pi 'git -C ~/BirdNET-Pi pull && <restart>'`; add `scripts/update-remote.sh` wrapper. BirdNET base updates via its web UI.
  3. **Scoped CI token** confirmed (bird resources only). Verify nothing in `worker/wrangler.toml` references foobos IDs.
- **Done when**: Scott can SSH in via Cloudflare and run an update; security review of isolation passes.

---

## Definition of done (v1)

A real detection on the Pi → appears on the public Pages collage within **~5–10 s** and on the e-ink panel within **~1–2 min**; the **Pi makes only outbound calls** (no open ports); **zero foobos resources touched**.

## Deferred to v2

SSE/WebSocket push · per-bird audio playback · custom domain · Gemini region-specific illustration restyle (`avian/scripts/`) · MQTT/Home-Assistant forwarding (`avian/forwarding/`) · edge caching tuning.

## Hard constraints (never violate)

- **Separate from foobos** — new Cloudflare resource IDs only; same account, pooled free-tier quotas.
- **D1, not KV** for detection writes. **Pi outbound-only.** **No browser on the Pi.**
- **License CC-BY-NC-SA-4.0** — non-commercial only.
- **Frame geometry must be ported** to 800×480 before `frame/` works.
- **No mic ⇒ no detections** — verify first when debugging "nothing shows up".
