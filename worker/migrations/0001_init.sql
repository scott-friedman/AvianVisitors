-- avian-detections schema (D1 / SQLite). See PLAN.md Phase 1.
--   Apply locally:  wrangler d1 migrations apply avian-detections --local
--   Apply remote:   wrangler d1 migrations apply avian-detections --remote

CREATE TABLE IF NOT EXISTS detections (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  sci  TEXT NOT NULL,            -- scientific name
  com  TEXT NOT NULL,            -- common name
  conf REAL NOT NULL,            -- confidence 0..1
  ts   INTEGER NOT NULL          -- unix seconds (UTC)
);

CREATE INDEX IF NOT EXISTS idx_detections_ts ON detections(ts);

-- Dedupe Pi restarts/replays: the hook may re-emit the same detection.
-- (sci, ts) is unique enough at 1s resolution for BirdNET's ~3s windows, so
-- the ingest endpoint can INSERT OR IGNORE safely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_detections_dedupe ON detections(sci, ts);
