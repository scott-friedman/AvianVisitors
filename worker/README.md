# avian-worker

Cloudflare Worker for **AvianVisitors (bird)** — the live-data spine. See
`../PLAN.md` (Phase 1) and `../CLAUDE.md` for the full architecture.

## Routes

| Route | Purpose |
|---|---|
| `POST /api/detection` | Pi's BirdNET hook posts `{sci, com, conf, ts}`. Header `X-Avian-Secret` must equal `AVIAN_INGEST_SECRET`. `INSERT OR IGNORE` dedupes by `(sci, ts)`. → **204** |
| `GET /api/recent?hours=N` | Species-collapsed recent detections. The collage polls this every ~5–10 s. |
| `GET /api/stats` | Totals / today / week / last hour. |
| `GET /api/lifelist` | Every species ever heard (first/last seen, count, best conf). |
| `GET /api/timeseries?days=N` | Daily + by-hour aggregates. |
| `GET /api/species?sci=<name>` | Per-species detail. |
| `GET /api/firstseen?limit=N` | Newest life-list additions. |

`action` may also be given as a query param (`/api/birdnet-api.php?action=recent`)
so the static collage can repoint with only a base-URL change. Reimplements
`avian/api/birdnet-api.php` over **D1** (`avian-detections`); audio playback
(`recording.php`) is deferred to v2, so `top_file`/`file` are `null`.

## Local dev (no Cloudflare-account writes)

```sh
cd worker
cp .dev.vars.example .dev.vars          # holds AVIAN_INGEST_SECRET for local dev
wrangler d1 migrations apply avian-detections --local
wrangler dev                            # http://localhost:8787

# post a detection, then read it back:
curl -XPOST localhost:8787/api/detection \
  -H 'X-Avian-Secret: dev-local-secret-not-for-prod' \
  -H 'content-type: application/json' \
  -d '{"sci":"Cardinalis cardinalis","com":"Northern Cardinal","conf":0.91,"ts":1750000000}'
curl 'localhost:8787/api/recent?hours=999999'
```

## Deploy (needs Cloudflare auth — gated on Scott)

```sh
wrangler d1 create avian-detections          # paste the UUID into wrangler.toml -> database_id
wrangler d1 migrations apply avian-detections --remote
echo '<random-secret>' | wrangler secret put AVIAN_INGEST_SECRET
wrangler deploy
```

Set `TZ_OFFSET_HOURS` in `wrangler.toml` to the deployment's UTC offset (e.g.
`-4` for US Eastern in summer) so the "today" / daily buckets use the local day.
Rolling windows (recent / last_hour / week) are UTC and unaffected.
