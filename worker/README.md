# avian-worker

Cloudflare Worker for **AvianVisitors (bird)** — the live-data spine: detection
ingest, the JSON read API over D1, R2 clip upload/playback, and the e-ink frame
render. See `../PLAN.md` (Phase 1) and `../CLAUDE.md` for the full architecture,
`../DEPLOYING.md` for the deploy runbook.

## Routes

Auth column: **secret** = header `X-Avian-Secret` must equal the
`AVIAN_INGEST_SECRET` secret · **key** = header `X-Frame-Key` (or legacy `?k=`)
must equal `FRAME_KEY` · **public** — and *(cached)* = served from the poll
micro-cache (see "Operational invariants").

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/detection` | secret | Pi's BirdNET hook posts `{sci, com, conf, ts, file?}`. `INSERT OR IGNORE` dedupes on `(sci, ts)`; each species' first 25 clips are archived to R2 `rare/`. A **first life-list** insert whose species is missing art and/or a non-exempt song signature POSTs `{event, sci, com, art_missing, signature_missing}` to `COVERAGE_WEBHOOK_URL` (best-effort; unset/failure still → **204**). Mojo is skipped. |
| `POST /api/clip?file=<key>` | secret | Pi uploads that detection's mp3 bytes → R2 `clips/<key>` (bucket's 7-day lifecycle rule). → **204** |
| `POST /api/heartbeat` | secret | Pi's 15-min liveness ping → single-row D1 upsert. → **204** |
| `GET /frame.png` | key | 800×480 collage PNG for the e-ink panel — Browser Rendering screenshot of `FRAME_URL`, signature-cached **per window** in D1 `frame_cache`. Fails closed if `FRAME_KEY` is unset (`FRAME_DEV_OPEN=1` opens it for local dev). |
| `GET`/`HEAD` `/api/status` | public | **200** if the Pi pinged within `HEARTBEAT_MAX_AGE_SECONDS` (default 2700 s = 3 missed pings), else **503**. For uptime monitors; `no-store`. |
| `GET /api/recent?hours=N` | public *(cached)* | Species-collapsed recent detections. The collage polls this every ~5–10 s. |
| `GET /api/stats` | public *(cached)* | Totals / today / week / last hour. |
| `GET /api/lifelist` | public *(cached)* | Every species ever heard (first/last seen, count, best conf). |
| `GET /api/timeseries?days=N` | public *(cached)* | Daily + by-hour aggregates. |
| `GET /api/hourly?hours=N` | public *(cached)* | Rolling by-hour counts for the Day Dial, plus the sunrise/sunset arc from `SITE_LAT`/`SITE_LON`. |
| `GET /api/facts` | public *(cached)* | Auto-generated plain-English "field notes" for the stats panel. |
| `GET /api/rhythm?days=&top=` | public *(cached)* | Per-species activity-by-clock-hour ridgeline (default 14-day lookback). |
| `GET /api/chorus?hours=&interval=&top=` | public *(cached)* | Binned per-species counts for the Chorus streamgraph. |
| `GET /api/species?sci=` | public | Per-species detail (uncached — rarely hit). |
| `GET /api/firstseen?limit=N` | public *(cached)* | Newest life-list additions. |
| `GET /api/recording?file=` or `?sci=` | public | Streams a clip from R2: `clips/` then the `rare/` forever-archive; `?sci=` also falls back to the species' oldest clip. Range + CORS; **404** once expired. |
| `GET /api/wiki?sci=&com=` | public | Wikipedia summary proxy for the bird modal (day-cached; Mojo gets his curated field notes). |
| `GET /api/frame-config` | public | Read the shared e-ink time window → `{window_hours}` (uncached — must be fresh). |
| `POST /api/frame-config` | public **by design** | Set the shared window (`{window_hours: 1/12/24/168/1000000}`) — the site's picker writes it. No-op writes are skipped and real changes are rate-limited; the per-window frame cache bounds render burn. |
| `GET /api/coverage` | public *(cached)* | Art + song-signature gap lists (D1 life list diffed against the Pages `art-manifest.json` + `signatures.json`), for the HA dashboard. |
| `GET /` or `/health` | public | `{ok:true}` — proves the *Worker* is up, NOT the Pi (that's `/api/status`). |

`action` may also be given as a query param (`/api/birdnet-api.php?action=recent`)
so the static collage can repoint with only a base-URL change; other unknown
`/api/*` paths 404. **Cron** (`[triggers]` in `wrangler.toml`, `*/30 10-23 UTC`):
`mojoVisit()` — the Mojo easter-egg "detections" (see the `MOJO` block in
`src/index.js`; do NOT "fix" or dedupe him).

## Secrets & vars

Secrets (`wrangler secret put …`; local dev values live in `.dev.vars`, gitignored):

- `AVIAN_INGEST_SECRET` — gates the three Pi POST routes (detection/clip/heartbeat).
- `FRAME_KEY` — gates `GET /frame.png` (a render costs metered Browser Rendering time).
- `COVERAGE_WEBHOOK_URL` — Grok Bot routine webhook. When unset, the first-seen
  coverage ping is a no-op. Never commit the URL; never log it.
- `COVERAGE_WEBHOOK_KEY` — that routine's sender key (`Authorization: Bearer`,
  plus `X-Automation-Key` and `X-Webhook-Key`). Optional if the URL is open,
  but the routine panel issues a key.

Vars (`wrangler.toml [vars]`):

- `TZ_NAME` (`America/New_York`) — **authoritative**, DST-correct local timezone,
  computed per-hour via `Intl`. `TZ_OFFSET_HOURS` is only the fallback when
  `TZ_NAME` is unset or unresolvable — don't reintroduce fixed-offset math.
- `SITE_LAT` / `SITE_LON` — site coordinates for `/api/hourly`'s sun arc.
- `FRAME_URL` — the page `/frame.png` screenshots (`birds-origin…/?frame=1`).
- `PAGES_BASE` — Pages origin `/api/coverage` reads the two manifests from.
- `HEARTBEAT_MAX_AGE_SECONDS` — staleness threshold for `/api/status`.

## Migrations (`migrations/`)

Apply with `npm run migrate:local` / `npm run migrate:remote`. **Always apply
remote migrations BEFORE `wrangler deploy`** — 0006 in particular: new code
against the old table fails its `CHECK (id = 1)` on the first non-24h render.

- `0001_init` — `detections` table + `idx_detections_ts` + the unique `(sci, ts)` dedupe index.
- `0002_frame_cache` — single-row cache of the rendered frame PNG.
- `0003_heartbeat` — single-row Pi liveness timestamp.
- `0004_detection_file` — nullable `detections.file` = R2 clip key (persists after the clip expires).
- `0005_settings` — singleton settings row (shared frame window, default 24 h).
- `0006_frame_cache_per_window` — one cached frame PER window (id = window hours, ≤5 rows), so a public window flip serves a cached PNG instead of forcing a metered re-render.

## Local dev (no Cloudflare-account writes)

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars   # AVIAN_INGEST_SECRET (+ optional FRAME_DEV_OPEN=1)
npm run migrate:local
npm run dev                      # wrangler dev → http://localhost:8787

# post a detection, then read it back:
curl -XPOST localhost:8787/api/detection \
  -H 'X-Avian-Secret: dev-local-secret-not-for-prod' \
  -H 'content-type: application/json' \
  -d '{"sci":"Cardinalis cardinalis","com":"Northern Cardinal","conf":0.91,"ts":1750000000}'
curl 'localhost:8787/api/recent?hours=999999'
```

`npm test` runs the vitest suite; `npm run check` = `node --check` +
`wrangler deploy --dry-run`.

## Deploy

```sh
cd worker
npm run migrate:remote   # ALWAYS before the code deploy (see Migrations)
npx wrangler deploy
```

## Operational invariants (don't regress these)

- **Poll micro-cache + D1 index pins** (the 2026-07-03 overload): the 9 polled
  read endpoints (`recent, stats, lifelist, timeseries, firstseen, hourly,
  facts, rhythm, chorus`) are micro-cached in isolate memory, keyed on clamped
  params + `MAX(ts)` + a 5-min bucket (`X-Poll-Cache: hit` header for probing);
  windowed `GROUP BY sci` queries are pinned with `INDEXED BY idx_detections_ts`
  (the planner otherwise full-scans via the dedupe index). Any NEW windowed
  aggregate must verify its plan (`EXPLAIN QUERY PLAN … --remote`) and join the
  cache set if polled. **Health check:** `wrangler d1 info avian-detections` →
  `rows_read_24h` should sit in the low millions; 9 digits means something is
  full-scanning again.
- **Migrations before deploy** — see above.
- Dispatch retries transient `D1_ERROR … reset` up to 3× (every route is
  idempotent); `/frame.png` is excluded — a retry there could double-bill
  Browser Rendering.
