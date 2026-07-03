# CLIP-RETENTION-PLAN.md — frequency-aware audio clip retention + long-term stability audit

*Investigated 2026-07-03. Status: **SHIPPED same day** — archive-at-ingest + recording fallback + coverage cache + DST fix deployed to the Worker (verified live: re-POSTed House Wren archived to `rare/`; expired Blue-gray Gnatcatcher + Veery play again via the fallback); all 103 rare clips backfilled (53 from `clips/`, 50 recovered from the Pi's `Extracted/By_Date`); `pi/prune-extracted.sh` + `avian-prune.timer` + exclude-file backstop shipped via `pi/update.sh`. Remaining follow-ups: recheck `rows_read_24h` on 07-04; SD-card spare (ops, audit #3).*

## Plain English Summary

Right now every bird recording is treated the same: it lives in cloud storage for exactly 7 days and then gets deleted, whether it's the 1,058th goldfinch clip this week or the only Veery ever heard at the house. That means the rarest, most interesting recordings — a one-time hawk flyover, the first Wood Thrush of the season — vanish just as fast as the everyday chatter. This plan changes that: common birds keep the same 7-day window (plenty for the website's playback features), but rare birds' recordings get copied into a permanent "keepsake" area so they survive forever. The first recording ever made of each species is also kept for good, like a scrapbook page per bird. Storage isn't a concern — the whole collection currently uses under 4% of the free allowance, and the keepsake area stays tiny by design. The same investigation also swept the system for anything else that could degrade over months of unattended operation; findings and fixes are listed at the end.

## Measured state (2026-07-03)

| Metric | Value |
|---|---|
| R2 `avian-clips` | 7,916 objects, 362 MB (3.6% of 10 GB free tier) |
| Clip size / rate | ~45 KB each, ~1,100–1,400/day |
| 7-day detections | 7,935 across 43 species |
| Skew | top 5 species = 49% of all clips |
| Rare tail | 14 species with ≤5 detections in 7 days (31 clips total) |
| Lifetime singletons | 10 species heard exactly once, ever (Veery, Broad-winged Hawk, Wood Thrush, …) — their clips are already gone or about to be |
| D1 | 2.7 MB, ~5.5k rows written/day |

**Conclusion:** this is not a storage problem (we could store ~5 months of everything before hitting the cap). It's a *value* problem — the flat TTL deletes irreplaceable rare recordings at the same speed as redundant common ones.

## Current mechanism (verified in code)

- Pi forwarder (`pi/detection-forwarder.py`) uploads the clip **before** POSTing the detection, so `detections.file` is never a dangling key. Key = BirdNET's mp3 basename, stored flat under `clips/`.
- TTL = an R2 bucket lifecycle rule `expire-clips-7d` (prefix `clips/`, set on the bucket, not in the repo). No Worker-side deletion code exists.
- `GET /api/recording` serves `clips/<file>` (by `?file=` or latest-for-`?sci=`); an expired object just 404s and the UI degrades ("no audio" / "!" flash).
- Precedent: Mojo's bark master lives at `master/mojo-bark.mp3` — **outside `clips/`, so the lifecycle never touches it**, and his cron re-copies it into `clips/` when it expires. Prefix-based exemption already works.
- No object metadata; species/rarity live only in D1. `SELECT COUNT(*) FROM detections WHERE sci=?` is a covering-index seek on `idx_detections_dedupe` (verified with `EXPLAIN QUERY PLAN --remote`) — safe to run per detection.

## Design: archive-at-ingest ("first N clips of every species live forever")

No cron, no batch job, no new lifecycle rules. One rule applied inline in the Worker's existing `ingest()` (which already runs once per detection and already knows `sci` + `file`):

> **If this species has ≤ `RARE_MAX` (25) lifetime detections, copy `clips/<file>` → `rare/<file>` right after the D1 insert.**

- `rare/` has **no lifecycle rule** → objects persist indefinitely.
- Because the counter is *lifetime*, every species automatically archives its **first 25 clips ever** — which includes the first-ever recording — then stops as it becomes common. A goldfinch archived its first 25 back in June and never archives again; a one-off Veery keeps its single clip forever.
- Upload ordering guarantees the clip exists in `clips/` at ingest time (forwarder uploads clip first).
- Cost per rare detection: one covering-index COUNT + one 45 KB R2 get/put. Cost per common detection: one COUNT only. Rows read impact: ≤25 rows per detection → ~35k rows/day, noise next to the poll traffic.

### Storage bound (why this can't grow out of control)

`rare/` ≤ 25 clips × 45 KB ≈ 1.1 MB **per species, ever**. Even if all 249 illustrated species eventually visit: ≤ ~280 MB lifetime ceiling. Realistically (~60 species) ≈ 67 MB. No pruning needed.

### Read path

`recording()` gains a two-step lookup: try `clips/<key>`, on miss try `rare/<key>`, else 404 (same as today). For `?sci=` mode, if the *latest* file misses both prefixes, fall back to the species' **oldest** detection with a file (that's the one most likely archived) before giving up — fixes the atlas "no audio" case for rare birds whose only clip has expired from `clips/`.

### Changes checklist

1. **`worker/src/index.js`**
   - `RARE_MAX = 25` const near the MOJO block.
   - In `ingest()`, after the insert: count lifetime `sci` detections; if ≤ RARE_MAX and `file` set, `CLIPS.get('clips/'+file)` → `CLIPS.put('rare/'+file, …)`. Wrap in try/catch — archival failure must never fail the ingest (fire-and-forget via `ctx.waitUntil` is fine).
   - `recording()`: `clips/` → `rare/` fallback; `?sci=` oldest-file fallback on double miss.
   - Skip `sci === MOJO.sci` (his cron already self-heals; no need to archive barks).
2. **No D1 schema change.** Prefix probing at read time replaces any `archived` flag. (Optional later: an `archived` column if we ever want the UI to badge "kept forever".)
3. **No new lifecycle rules.** `expire-clips-7d` stays exactly as-is; `rare/` simply isn't covered by it (verify the rule's prefix is `clips/` — it is, per `wrangler r2 bucket lifecycle list`).
4. **Backfill (one-time, right after deploying):** for every species currently ≤ RARE_MAX lifetime, copy its clips to `rare/`. **Nothing is lost yet** — verified 2026-07-03 that the Pi still holds every extracted clip since 06-20 (`~/BirdSongs/Extracted/By_Date/…`, 16,150 mp3s, incl. the Veery and the 06-20 Blue-gray Gnatcatcher whose R2 copies expired). Backfill = `wrangler d1 execute` for the ≤25-count species' `file` names → fetch from `clips/` where still present, else `scp` from the Pi → `wrangler r2 object put rare/<file>`. ~80–120 objects. Do this before the Pi prune (audit fix #1) ships.
5. **Docs:** update `worker/wrangler.toml` comment block + `AUDIO-FIX-PLAN.md` + CLAUDE.md gotchas ("clips: 7-day TTL under `clips/`, first-25-per-species forever under `rare/`").

### Options considered and rejected

- **Per-tier prefixes chosen at upload time** (`clips-rare/` vs `clips-common/` lifecycle rules): the Pi/upload path doesn't know rarity, and re-classifying means moves. Ingest-time copy is strictly simpler.
- **Daily retention cron**: works, but adds a batch job + reconciliation state for something the ingest path can do inline in 5 lines. (The cron slot stays free for real needs.)
- **Trimming common species harder** (e.g. keep only last 50 wren clips): saves ~200 MB we don't need to save, and would break the modal's per-detection playback within the 7-day window. Not worth it now; trivial to add later as a lifecycle-rule tweak or key-prefix scheme **if** clip rate ever grows ~10×.
- **Longer flat TTL for everything** (e.g. 30 days): still deletes the rare stuff eventually, quadruples storage churn, solves nothing Scott asked for.

### Gotchas to respect while implementing

- **D1 full-scan trap**: the new COUNT is verified index-seek; any *other* new aggregate must get `EXPLAIN QUERY PLAN --remote` before shipping (CLAUDE.md 2026-07-03 incident).
- `/api/recording` sets `Cache-Control: max-age=604800` — an expired-then-archived clip may serve stale 404s from edge cache up to 7 days on the same URL. Acceptable (URL param differs per file; sci-mode picks a new latest file as detections arrive).
- Don't retry-wrap the R2 copy into the D1 dispatch-retry path — it's already idempotent, but keep it in `waitUntil` so ingest latency stays flat.
- Mojo (`Canis volaticus`) is fake on purpose — exclude from archival, never "fix".

## Long-term stability audit findings (2026-07-03)

Ranked by likelihood × impact for months of unattended operation. Live-state claims verified over SSH / wrangler / curl on 2026-07-03, not just from code.

### 1. [HIGH — near-certain within ~8 months] Pi disk fills; BirdNET-Pi's purge silently no-ops

**Confirmed live.** `~/BirdSongs/Extracted` is 5.5 GB after 13 days (**~420 MB/day** — each detection saves an mp3 *and* a spectrogram PNG; 16,150 of each). 100 GB free → hits the 95% purge threshold in roughly 8 months. But the purge is broken on our lean box: `scripts/disk_check.sh` hard-exits unless `scripts/disk_check_exclude.txt` exists with `##start` — that file is created only by the web UI (`stats.php`/`play.php`) that `lean-mode.sh` stripped, and **it does not exist on the Pi** (verified). `MAX_FILES_SPECIES=0` disables the per-species cap too. Net: disk fills to 100%, recording/analysis die, **heartbeat stays green** (it doesn't touch disk).

**Fix:** add `pi/prune-extracted.sh` + a daily systemd timer that deletes `Extracted/By_Date/<date>` dirs older than 30 days (the on-Pi archive is only needed as the forwarder's upload source + rare-clip recovery buffer; R2 is the real store). Belt-and-suspenders: also create `disk_check_exclude.txt` (`##start`/`##end`) so the stock 95% purge works as backstop. Wire into `pi/update.sh` unit-sync. **Sequence after the clip-retention backfill** (§ above) so no rare clip is pruned before it's archived.

### 2. [MED — slow burn] D1 read-cost grows linearly forever; no pruning anywhere

~1,100–1,200 rows/day (~420k/yr; storage trivial at ~2.7 MB now). The poll micro-cache bounds recompute *frequency*, but a class of endpoints full-scans by design and each recompute's cost grows with the table: `stats` (all-time COUNT/DISTINCT), `facts` (~6 full passes), `lifelist`, `firstseen`, `coverage`, and `recent/hourly` with the ALL window. Two concrete issues:
- **`coverage` is NOT in `POLL_CACHE_ACTIONS`** (verified in `worker/src/index.js:595`) yet the HA dashboard polls it (~288 full GROUP-BY scans/day behind only a 300 s edge cache). **Fix: add `'coverage'` to the set** — one-line.
- The CLAUDE.md health heuristic ("9 digits of rows_read_24h = full-scan bug") will drift into false-alarm territory from organic growth alone in a year+. **Fix later:** precompute all-time aggregates (tiny `species_totals` table maintained at ingest) or just recalibrate the threshold annually. No urgency; free-tier cap is 25 B rows/day.

### 3. [MED — 1–2 yr horizon] SD card wear

Recorder writes ~8 GB/day of WAVs (~3 TB/yr) through a consumer microSD. Within spec for a good card for a year or two, but SD death = total remote-unfixable box loss. **Fix: ops item, not code** — keep a pre-imaged spare card at dad's house (or image the card on the next visit); optionally add SD health to the heartbeat payload later.

### 4. [WILL HAPPEN — Nov 2026] Fixed EDT offset skews all times by 1 h after DST ends

`TZ_OFFSET_HOURS = "-4"` in `worker/wrangler.toml` is static. From Nov 1: day buckets, "today" boundaries, dawn/peak facts, sunrise/sunset bands all shift 1 h until a manual redeploy. **Fix: compute the offset in the Worker from `America/New_York` via `Intl.DateTimeFormat`** (Workers support tz names) — removes the failure mode permanently instead of a twice-yearly redeploy ritual.

### 5. [RESOLVED by this investigation] Mojo master-clip vs lifecycle scope

Verified `wrangler r2 bucket lifecycle list avian-clips`: rule `expire-clips-7d` is **prefix-scoped to `clips/`** — `master/mojo-bark.mp3` (and the new `rare/` prefix) are safe. No action.

### 6. [LOW — documented, accept for now] Heartbeat blind spot for intermittent Worker 500s

Known (pi/README.md, commit 66aa4ec): worker 500 bursts under the 45-min tolerance drop detections while the monitor stays green. Optional future fix: forwarder counts consecutive POST failures and reports them in the heartbeat payload; `/api/status` flags a degraded state. Backlog, not urgent — the 07-03 D1 fixes removed the main 500 source.

### Verified healthy (no action)

- Worker fix deployed 07-03 (last deploy 18:41 UTC); poll micro-cache serving hits (`x-poll-cache: hit` probed live). `rows_read_24h` = 110 M still, but the 24 h window includes pre-fix hours — **recheck `wrangler d1 info avian-detections` on 07-04; expect low millions.**
- Pi live state: all 4 services active, load 0.4, 77 MB available, StreamData backlog = 5 files, 100 GB disk free, up 1.7 days.
- REVIEW-TODO backlog fully closed 07-01 (heartbeat + update path shipped and running); `/api/coverage` confirmed live (200).
- Forwarder is bounded by design (atomic offset state, rotation-safe, drops lines only after ~20 s of retries during a sustained outage — accepted trade-off). Gotcha: rotating `AVIAN_INGEST_SECRET` requires a forwarder restart.
- Auto-update cron is gated off (`AUTOMATIC_UPDATE=0`) — the box won't self-pull WIP.
- Mojo cron hours are fixed UTC → from November he barks 5:00–18:30 ET instead of 6:00–19:30. Cosmetic; fold into the DST fix (#4) if desired.

## Suggested implementation order

1. **Worker: archive-at-ingest + recording fallback** (the headline feature; small, self-contained).
2. **Backfill `rare/` from R2 + the Pi's Extracted archive** (before anything prunes the Pi).
3. **Pi: prune-extracted timer + exclude-file backstop** (closes the #1 stability risk).
4. **One-liner: add `coverage` to `POLL_CACHE_ACTIONS`.**
5. **DST-proof the Worker's tz handling** (any time before November).
6. Recheck `rows_read_24h` on 07-04 to confirm the 07-03 fix landed.
