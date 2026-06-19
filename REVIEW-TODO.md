# REVIEW-TODO.md — stability / remote-ops hardening backlog

**Created 2026-06-19** from a code review focused on **stability, remote updating, and
remote access** — the three things that matter for a box that lives **unattended at Dad's
in Sudbury**, that Scott manages **from home**, and that **Dad can't troubleshoot**.

**Plain English:** the software works. This is the "make it survive in the wild" list —
the failures that, once the box is 30 miles away, you'd have **no way to see or fix**. None
of these block first power-on, but the two marked ⭐ are far easier to do **now, on the
bench**, than after the box ships. Read this alongside [`DEPLOY-SUDBURY.md`](DEPLOY-SUDBURY.md).

**Legend:** severity `[High] / [Med] / [Low]` · ⭐ = do before the box leaves for Sudbury ·
`- [ ]` open / `- [x]` done.

---

## Session progress — RESUME HERE (updated 2026-06-19)

**Paused mid-backlog at Scott's request.** Done this session (checked + annotated inline below):
**A-High** (liveness heartbeat), **B-High** (Pi update path), **C-Med** (SSH-posture docs),
**A-Med** (forwarder offset). **All three ⭐ ship-blockers are complete.**

**Remaining — open `- [ ]` items, suggested order:**
1. `[Low]` A — frame render PNG sanity check → `worker/src/index.js` `frame()` (byte floor before cache)
2. `[Low]` A — clock/`systemd-timesyncd` → `pi/zero2w-tune.sh`
3. `[Low]` B — unattended security upgrades → `pi/zero2w-tune.sh`
4. `[Med]` C — tunnel logical-health recovery → new cloudflared reachability watchdog timer
5. `[Low]` C — standardize frame cadence docs to **hourly** (DECIDED; `frame/install.sh`,
   `CLAUDE.md`, `PLAN.md` still say "1–2 min" / "15 min" — just make them say hourly)
6. `[Low]` C — decouple frame signature window → drop the `hours` knob in `frame/display.py`
   (Worker `/frame.png` is hard-coded to 24 h)

**Decisions locked this session (don't re-ask on resume):**
- Liveness = **Worker `/api/heartbeat` + `/api/status` (503 when silent)**, alerted by **UptimeRobot** (Scott has an account).
- Frame cadence = **hourly** (e-ink wear + free Browser-Rendering budget; item 5 just aligns the docs).
- Pi layout = **one `~/BirdNET-Pi` clone**; the live-box re-align is **DONE 2026-06-19**
  (forwarder/heartbeat/mic-watchdog + frame all run from the clone; `~/avian`+`~/birdframe`
  deleted) — see `pi/README.md` → "Updating the Pi".

**Working tree is UNCOMMITTED** (nothing committed or pushed — awaiting Scott's OK). New files:
`worker/migrations/0003_heartbeat.sql`, `pi/heartbeat.sh`, `pi/update.sh`,
`pi/systemd/avian-heartbeat.{service,timer}`. Modified: `worker/{src/index.js,wrangler.toml,README.md}`,
`pi/{detection-forwarder.py,systemd/avian-forwarder.service,README.md,tunnel-setup.sh,cloudflared-config.example.yml}`,
`CLAUDE.md`, `PLAN.md`, `DEPLOY-SUDBURY.md`, `REVIEW-TODO.md`.

**Verified locally (no remote deploy / no Pi changes yet):** worker `wrangler deploy --dry-run`
bundles clean; heartbeat/status tested on local D1 (503→204→200); forwarder offset logic tested
(`/tmp/test_forwarder.py` — all pass). **Deploy-time steps still owed** when resuming/shipping:
`wrangler d1 migrations apply avian-detections --remote` (for `0003`), `wrangler deploy`, install
the heartbeat timer on the Pi, and create the UptimeRobot monitor on `<worker>/api/status`.

---

## What's already solid (don't re-do this work)

- **Secret hygiene is clean** — `worker/.gitignore` excludes `.dev.vars`, `.avian-ingest-secret`,
  `.avian-frame-key`; none are tracked. D1 id + `FRAME_URL` are non-secret, fine to commit.
- **Failure-resilience is real in places:** `frame/display.py` writes state atomically
  (`os.replace`), keeps the last panel image on a fetch failure, and preserves the old
  signature when `/api/recent` blips; the Worker falls back to the last-good frame on a render
  failure; the forwarder survives `BirdDB.txt` rotation/truncation.
- **512 MB tuning + watchdog are the right shape** — `pi/zero2w-tune.sh` uses `set -uo pipefail`
  (no `-e`) on purpose so a failed apt doesn't abort tuning; the hardware watchdog gives
  hang-recovery without a physical power-cycle.

---

## A. Stability & observability

- [x] ⭐ **[High] No liveness signal — silent failure is invisible.** Nothing tells you the box
  is alive. `/health` (`worker/src/index.js:77`) only proves the *Worker* is up, not the Pi. If
  the mic dies, BirdNET hangs, the forwarder crash-loops, or wifi drops, the frame just freezes
  on its last image and the site goes stale — and Dad won't notice.
  **Fix:** a dead-man's switch. Simplest = a [healthchecks.io](https://healthchecks.io)-style
  ping: a tiny systemd timer on the Pi `curl`s a unique URL every ~15 min; if pings stop you get
  a text/email. Zero Worker code. (Alt: add `POST /api/heartbeat` to the Worker + an external
  uptime check.) Make it independent of bird activity so quiet nights don't false-alarm.
  **DONE (2026-06-19):** chose the Worker-endpoint path (Scott has an UptimeRobot account). Worker
  `POST /api/heartbeat` (secret-gated) + `GET /api/status` (200 fresh / **503** after ~3 missed
  pings; `alive` is heartbeat-only, so quiet nights don't false-alarm) + migration `0003_heartbeat.sql`
  — verified locally (503→204→200). Pi `heartbeat.sh` + `avian-heartbeat.{service,timer}` (15-min,
  runs from the clone). Point UptimeRobot at `/api/status`. Install: `pi/README.md` → "Liveness heartbeat".

- [x] **[Med] Forwarder can drop detections on restart or Worker/internet outage.** `follow()`
  starts at end-of-file (`pi/detection-forwarder.py:91`) and a failed POST is logged and dropped
  (`pi/detection-forwarder.py:80-81`) with no spool or retry. Anything detected while the
  forwarder is down — or during an outage at Dad's — is gone. *Practical impact is low for a
  species collage* (common birds re-detect constantly; the Worker dedupes replays), so don't
  over-invest — but it matters if you ever care about exact counts/timeline.
  **Fix:** persist the last-forwarded byte offset to a state file (mirror what `display.py`
  already does) and resume from there; optionally spool failed POSTs for retry.
  **Related:** the forwarder reads the ingest secret once at startup, so **rotating the secret
  requires a forwarder restart** (otherwise it 401s and drops everything).
  **DONE (2026-06-19):** persist the read offset to `~/.avian/forwarder-state.json` (atomic
  `os.replace`, no fsync — re-posts are dedupe-safe), resume from it on restart, only the
  first-ever run seeks to EOF; rotation/truncation reset to the new file's start. Added a small
  3× retry to ride out transient blips (sustained outages still drop — accepted, no spool).
  Secret-rotation-needs-restart noted in `pi/README.md` + the forwarder docstring. Verified with
  `/tmp/test_forwarder.py` (round-trip, resume-and-catch-up, first-run-skips-history, truncation).

- [ ] **[Low] Frame render can cache a broken screenshot.** `frame()` caches whatever
  `renderFrame` returns (`worker/src/index.js:192-195`). If the Pages site serves a blank/error
  page that still screenshots at 200, that bad PNG is cached under the current signature and
  shown on the panel until the data changes.
  **Fix:** sanity-check the PNG (e.g. byte length above a floor) before `INSERT OR REPLACE`.

- [ ] **[Low] Clock dependency on an RTC-less Pi.** `parse_ts` reads `BirdDB.txt` wall-clock as
  Pi-local (`pi/detection-forwarder.py:43-48`). The Zero 2 W has no RTC, so a boot without
  network has a wrong clock until NTP syncs → off timestamps. Low risk (forwarder waits for
  `network-online`; detections need uptime anyway).
  **Fix:** confirm `systemd-timesyncd` is enabled; optionally skip posting until time is synced.

## B. Remote updating

- [x] ⭐ **[High] No clean way to push code updates to the Pi.** The forwarder runs from a *copy*
  — install does `cp pi/detection-forwarder.py ~/avian/` (`pi/README.md:19`) and the unit's
  `ExecStart` points at `~/avian/detection-forwarder.py`. So a `git pull` on the Pi does **not**
  update the running forwarder; you must remember to re-copy and restart, by hand, over SSH.
  Given the goal ("improve it later without Dad's involvement") this is the weakest link.
  **Fix (two parts):**
  1. Point `ExecStart` at the repo clone directly (like `frame/systemd/birdframe.service`
     already does via `$FRAME`), or symlink it — so `git pull` + `systemctl restart` suffices.
  2. Add `pi/update.sh`: `git pull` → re-sync units if changed → `daemon-reload` → restart
     `avian-forwarder` + `birdframe.timer`, idempotent. One command instead of a remembered
     sequence. (NOTE: `PLAN.md` Phase 5 currently documents the update flow as
     `git -C ~/BirdNET-Pi pull` — that's the **detection engine**, a different repo from the
     **avian glue**; the glue has no update path today. Reconcile when this lands.)
  **DONE (2026-06-19):** the premise that these are *two repos* was wrong — `newinstaller.sh`
  clones the whole fork to `~/BirdNET-Pi`, so the engine and the glue (`pi/`, `frame/`) are **one
  clone**. Fixed: forwarder + heartbeat units now `ExecStart` from `~/BirdNET-Pi/pi/`; added
  `pi/update.sh` (`git pull --ff-only` → re-render units → `daemon-reload` → restart forwarder +
  heartbeat + frame timers, idempotent, no-op when current); README "Updating the Pi" + reconciled
  `PLAN.md` Phase 5. **One-time re-align DONE 2026-06-19** for the live box (forwarder/heartbeat/
  mic-watchdog + frame now run from the clone; `~/avian`+`~/birdframe` deleted); `update.sh` warns
  if the frame isn't clone-based. (No runtime-tracked
  files, so `--ff-only` is safe; it fails loud rather than silently merging.)

- [ ] **[Low] `update.sh` can mask a failed pull as "up to date".** It runs `set -uo pipefail`
  (no `-e`), so if `git pull --ff-only` errors (untracked-file collision, diverged history), the
  script falls through with `before == after` and prints "already up to date — nothing to restart"
  & exits 0 — a silent no-update on the box's only remote-update path. Real bite avoided during the
  2026-06-19 re-align by pulling by hand and watching stdout (see `pi/README.md` → "One-time
  re-align" and memory `avian-pi-ops`).
  **Fix:** check the pull's exit status (or compare `HEAD` to `origin/avian-visitors` after fetch)
  and abort loudly on failure instead of falling through to the no-op path.

- [ ] **[Low] Enable unattended security upgrades.** Internet-connected box running for months
  unattended. **Fix:** `unattended-upgrades` for OS + `cloudflared` patches; fold into the
  tuning script.

## C. Remote access

- [x] ⭐ **[Med] Doc conflict on the SSH security posture — reconcile before deploy.**
  `pi/README.md:92-97` says the final decision is **password-gated, no Cloudflare Access app**.
  But `pi/tunnel-setup.sh:68-72` still *prints* "add a Cloudflare Access app → Emails →
  friedmannn2@gmail.com" as a required step, and `DEPLOY-SUDBURY.md:18` still lists it as a
  pending ⏳ "one step left." These contradict each other — you could ship thinking SSH is locked
  to your email when it's actually only password-gated.
  **Fix:** pick one and make all three agree. Password-only via the tunnel is *defensible* (the
  tunnel hides SSH from port-scanning); the more defensive option is keeping the Access app or
  switching to key auth (keys still work "from any machine" — the stated reason for password
  auth — since you can copy the key). At minimum: guarantee the `inky` password is strong + unique.
  **DONE (2026-06-19):** kept the locked decision (password-only) and made all sources agree —
  removed the Access-app step from `pi/tunnel-setup.sh`'s output, fixed `DEPLOY-SUDBURY.md:18`
  ("one step left" → "password-gated, no Access app"), and fixed the `cloudflared-config.example.yml`
  comment. Also fixed a stale broken `ssh.bird.<zone>` (2-level) example in the deploy quick-ref.
  Strong-password reminder added to `DEPLOY-SUDBURY.md`. (Tighter options — Access app / key auth —
  noted in the script output if you ever want them.)

- [ ] **[Med] The tunnel is the sole way in, with no logical-health recovery.** Once at Dad's,
  `inky.local` is gone and `cloudflared` is your only path (`pi/README.md:124`). Process crashes
  self-heal (the installed `cloudflared` unit restarts on failure — confirm with
  `systemctl cat cloudflared`) and the watchdog reboots a hung box, so this is belt-and-suspenders
  for the rare "tunnel up but not routing" case.
  **Fix:** a cron/timer that restarts `cloudflared` (or reboots) if an outbound reachability check
  has failed for N minutes.

- [ ] **[Low] Cadence docs disagree three ways.** `frame/systemd/birdframe.timer` fires hourly
  (`OnUnitActiveSec=1h`), but `frame/install.sh:38` tells the user "every 15 min" and `CLAUDE.md`
  / `PLAN.md` say "~1–2 min." Harmless but confusing on a future revisit.
  **Fix:** make the docs match the unit (or change the unit); note the panel can lag a new bird
  by up to an hour by design.

- [ ] **[Low] Frame signature window is coupled by convention, not enforced.** The Pi computes its
  change-signature over `hours` (config default 24, `frame/display.py:59`); the Worker's
  `/frame.png` is hard-coded to 24h (`worker/src/index.js:171`). Set `hours ≠ 24` in the Pi config
  and the two disagree about "changed" → the panel under- or over-refreshes.
  **Fix:** drop the `hours` knob for the frame path, or pass it through to the Worker.

---

## Suggested order

1. **A-High (heartbeat)** and **B-High (update path)** — most operational safety for the least
   code, and both are **best done before the box ships** (hard to retrofit remotely). ⭐
2. **C-Med (doc reconciliation)** — a 5-minute fix that prevents a real lockout mistake. ⭐
3. Everything `[Low]` — polish; do opportunistically or in one cleanup pass.

All changes target the **`avian-visitors`** branch. The two ⭐ stability items pair naturally with
the on-site checklist in `DEPLOY-SUDBURY.md`.
