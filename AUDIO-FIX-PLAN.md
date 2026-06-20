# AUDIO-FIX-PLAN.md

**Status:** Ready to build. Written 2026-06-20 from a read-only investigation. No code changed in that session.
**Goal:** Make the website's "play" buttons (atlas cards + species detail modal) actually play bird-call audio.
**Decision locked:** Store clips in Cloudflare **R2**, **expire clips after 7 days**, keep **detection data forever**.

> Line numbers below are as of 2026-06-20 (`avian/frontend/apt.js` is 803 KB / unminified; `worker/src/index.js`). They may drift — search by the quoted snippet if a line doesn't match.

---

## Plain-English summary

Every "play" button on the site is broken because the bird-call recordings live only on the Raspberry Pi at Dad's house, and the public website (on Cloudflare) has no copy and no way to reach them. The fix: the Pi **uploads each new recording to Cloudflare's file storage (R2)** the moment it's detected, the website **plays it from there**, and a **7-day auto-delete rule** removes clips older than a week so storage never piles up. The **detection data — every bird, count, date, the life list, all stats — stays forever** in the database; only the audio clips expire. After a week, an old recording in a bird's history simply shows "no audio" instead of playing (intended). Net effect: play works for anything heard in the last 7 days, R2 stays ~half a gigabyte, and historical data is untouched.

---

## Decisions locked

| Decision | Choice | Why |
|---|---|---|
| Where audio lives | **Cloudflare R2** (`avian-clips` bucket) | Keeps the Pi outbound-only; R2 egress is $0; the box is already swapping (57 MB free RAM) so it must not serve public traffic |
| Clip retention | **7-day lifecycle rule** (delete 7 days after upload) | ~440 MB steady-state; ample listening window |
| Detection data retention | **Forever** (D1 rows never purged) | ~25 MB/year; decades inside the free tier |
| History granularity | **Per-detection clips** (not newest-per-species) | So the modal's recordings list plays each of the last 7 days' calls, not just the latest |
| Audio serving | **Streamed through the Worker** from R2 | One origin; applies CORS + Range/seek in one place |

---

## The numbers (measured on the live box 2026-06-20)

- Detection rate: **~1,400/day** (1,389 on 2026-06-20), peaking 175–200/hr midday. 22 species so far.
- Clip size: **~45 KB** each (observed 36–48 KB; mono MP3, `AUDIOFMT=mp3`, `RECORDING_LENGTH=30`).
- Volume: ~1,400 × 45 KB ≈ **63 MB/day**.
- **R2 with 7-day TTL:** 63 MB/day × 7 ≈ **~440 MB steady-state** (free cap = 10 GB). Writes ≈ 42k/mo = **4% of the 1M/mo** free write quota. Reads trivial. **Egress = $0.**
- **D1 "forever":** detection rows are tiny text; ~1,400/day ≈ **~25 MB/year** (free storage = 5 GB → decades).
- Pi disk: 105 GB free / 6% used (clips dir 486 MB, 1,406 files) — not a constraint.
- Pi RAM: **57 MB free, ~100 MB available, already 366 MB in zram swap** — this is *why* audio is not served from the Pi.

---

## Root cause

Audio 404s everywhere in the edge deployment because, end to end, no clip ever reaches the cloud and nothing there serves it:

- **Pi → cloud carries no audio.** The hook POSTs only `{sci, com, conf, ts}` (`worker/src/index.js` `ingest()` ~110–124). D1 `detections(id, sci, com, conf, ts)` has no filename/blob (`worker/migrations/0001_init.sql`).
- **Worker has no recording route** and deliberately returns `top_file/file = null` ("deferred to v2", `worker/src/index.js:15-16`, `311-314`).
- **Frontend points at the old on-Pi PHP** with **relative** URLs that bypass `AV_API` (the Worker base in `config.js`). On `barrysbirds.pages.dev` these resolve to Cloudflare Pages' **200-HTML fallback** (documented gotcha) — `avian/build-site.sh` ships no PHP.

Per-surface symptom:

| Surface | Code | Behavior on click |
|---|---|---|
| **Atlas cards** (`#atlasGrid`, View 3) | `apt.js:1180` sets `data-audio="./avian/api/recording.php?sci=…"` (relative); handler `apt.js:1258-1326` | `new Audio()` loads the HTML fallback → `error` event → button flashes **"no audio"** ~2.2 s (`apt.js:1316-1322`, `1225-1233`); no sound |
| **Detail modal list** (`#modalRecordings`) | rows render `data-file="(d.file||'')"` at `apt.js:2106`; handler `apt.js:2916-2984` | Worker `species()` (`index.js:375-392`) returns rows of `{d,t,conf}` with **no `file`** → `data-file=""` → handler bails at **`apt.js:2932` `if (!pfile) return;`** → **nothing happens** (the reported symptom) |
| **"Listen" live stream** (`#liveAudioBtn`) | `apt.js:1565` `new Audio('/stream?…')` | relative `/stream` (Pi-only Icecast) → `error` → "stream error". Separate feature — out of scope |

---

## Implementation steps

### 1. D1 — add filename column (never purge this table)
- `worker/migrations/0004_detection_file.sql`:
  ```sql
  ALTER TABLE detections ADD COLUMN file TEXT;  -- R2 object key; nullable; persists even after the clip expires
  ```
- Apply: `wrangler d1 migrations apply avian-detections --remote` (run from `worker/`).

### 2. R2 — bucket, binding, 7-day lifecycle
- Create bucket `avian-clips`.
- `worker/wrangler.toml` — add:
  ```toml
  [[r2_buckets]]
  binding = "CLIPS"
  bucket_name = "avian-clips"
  ```
- Lifecycle rule = **delete objects 7 days after upload**. Set via dashboard (**avian-clips → Settings → Object lifecycle rules → Delete objects → 7 days**), or `wrangler r2 bucket lifecycle`, or the S3-compat `PutBucketLifecycleConfiguration` API. (NB: R2 *bucket locks* are the opposite — they prevent deletion. Use *lifecycle rules*.)

### 3. Worker (`worker/src/index.js`)
- **`ingest()`** (~110–124): accept optional `body.file`; store it (`INSERT … (sci,com,conf,ts,file) …`).
- **New `POST /api/clip`** (gate with the existing `X-Avian-Secret` check, like `ingest`):
  `await env.CLIPS.put('clips/' + key, request.body, { httpMetadata: { contentType: 'audio/mpeg' } })`.
  Key = the BirdNET basename (already unique: `<Species>-<conf>-<YYYY-MM-DD>-birdnet-<HH-MM-SS>.mp3`).
- **New `GET /api/recording`** (add to the dispatch at ~70–91):
  - `?file=<key>` → `env.CLIPS.get('clips/'+key, { range })`.
  - `?sci=<sci>` → newest D1 row for that sci with non-null `file`, then fetch that key (plays the most recent call *if heard within ~7 days*, else 404).
  - Headers: `Content-Type: audio/mpeg`, `Accept-Ranges: bytes`, **honor `Range` → 206** (`env.CLIPS.get(key,{range:{offset,length}})`), the existing `CORS` const (`index.js:26` — the spectrogram does a cross-origin `fetch().arrayBuffer()`, so CORS is required), `Cache-Control: public, max-age=604800`.
  - Missing/expired object → **404** (frontend already degrades to "no audio").
- **`species()`** (375–392): include `file` per row. **`recent()`** (311–316): set `top_file` from the newest row's `file`.
- Update header comment (14–16): audio now in R2 with a 7-day TTL.

### 4. Pi (READ `pi/detection-forwarder.py` + the BirdNET on-detection hook first — not opened during the investigation)
- The hook receives the extracted clip path. Add to the existing flow:
  1. include `file` (basename) in the existing `POST /api/detection` body;
  2. after that succeeds, `POST` the clip bytes to `/api/clip` with `X-Avian-Secret` **and a `User-Agent`** (Cloudflare 403s the default urllib UA — documented gotcha). Optionally gate by a confidence floor.
- Upstream cost ≈ 63 MB/day — trivial for the home line.
- Deploy: `bash ~/BirdNET-Pi/pi/update.sh`.

### 5. Frontend (`avian/frontend/apt.js`) — 3 one-line swaps, no other logic
- `1180`: `'./avian/api/recording.php?sci='` → `AV_API + '/api/recording?sci='`
- `2892`: `'./avian/api/recording.php?file='` → `AV_API + '/api/recording?file='`
- `2957`: `'./avian/api/recording.php?file='` → `AV_API + '/api/recording?file='`
- With `species()` returning `file`, `data-file` (`2106`) is populated → the `if (!pfile) return;` guard at `2932` passes. Expired/clip-less rows → 404 → existing "no audio"/"!" path. No new UI code.

### 6. Deploy order
D1 migration → create R2 bucket + lifecycle → `wrangler deploy` (Worker) → push Pi update → rebuild & redeploy Pages:
`avian/build-site.sh` → `wrangler pages deploy _site --project-name barrysbirds --branch production` (run from `worker/` so the local wrangler resolves).

---

## Behavior after 7 days
- Bird heard in the last 7 days: plays on its atlas card and recent modal rows.
- Older rows: clip gone, row remains, play → "no audio." Counts / life list / first-seen / stats / timeseries unchanged forever.
- Optional polish (not required): Worker nulls `file` for rows >7 days old so the modal doesn't even attempt playback (cosmetic: silent vs. brief "no audio").

## Verification
- `curl -I "<worker>/api/recording?sci=Cardinalis%20cardinalis"` → `200`, `audio/mpeg`, `Accept-Ranges: bytes`; `Range: bytes=0-99` → `206`.
- On `barrysbirds.pages.dev`: atlas card → audio + spectrogram paints; modal recent row → audio; no CORS error in console; an old row → "no audio" (not a hang).
- After a week: R2 dashboard object count/size plateaus (~440 MB) while `/api/stats` totals keep climbing.

## Explicitly NOT touched (scope guards)
- Admin-only relative paths — `menu.php`, `config.php`, `birdnet-status.php` (`apt.js` 1457/1476/1716/1832/2357/2402/2501/2538/2605): intentionally same-origin to the Pi admin screen.
- **"Listen" live stream** (`apt.js:1565`, `/stream`): separate, larger feature.
- Modal **Wikipedia blurb** (`apt.js:2126`, `wiki.php`): same relative-URL class of bug but not audio; defer.

## Micro-decisions for the build session
1. **Confidence floor for uploads** (skip sub-threshold clips) — optional, saves a few PUTs.
2. **Null `file` for >7-day rows in `species()`** — cosmetic only.

---

## Rejected alternative (for the record)
**Serve clips from the Pi via the cloudflared tunnel.** Feasible *only* with a ~2 MB static server (darkhttpd/busybox — never php-fpm, which would +50–80 MB and risk the OOM-thrash that bricked the box on 2026-06-19) + edge caching + filename-in-D1. Disk (4.5 yrs) and bandwidth (with caching) are fine, but it **re-couples the public site to the fragile, already-swapping box** and adds a public endpoint + systemd service. Volume was the user's worry, but that's the *least* concerning part — R2 handles 1,400 clips/day comfortably and charges $0 egress. Chose R2 for robustness.
