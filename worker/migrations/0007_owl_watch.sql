-- Owl watch: "maybe an owl" moments the box heard but BirdNET did not keep
-- (a weak score, or an owl its location map says isn't found here, or an owl it
-- named as an Old World species). Sent by the Pi's forwarder from
-- ~/BirdSongs/owl_watch.txt (scripts/utils/owlwatch.py). Kept apart from
-- `detections` on purpose: a possible owl is never counted as a bird; the site
-- lists them for a person to listen to and judge.
--
--   Apply remote BEFORE deploying the worker code that uses it:
--     wrangler d1 migrations apply avian-detections --remote

CREATE TABLE IF NOT EXISTS owl_watch (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  sci  TEXT NOT NULL,      -- BirdNET's guess (may be an Old World owl)
  com  TEXT NOT NULL,
  conf REAL NOT NULL,      -- BirdNET's score 0..1 (below its bar, or filtered out)
  ts   INTEGER NOT NULL,   -- unix seconds (UTC) of the 3-s window
  file TEXT                -- R2 key under owlwatch/ (NULL if the clip didn't upload)
);
CREATE INDEX IF NOT EXISTS idx_owl_watch_ts ON owl_watch(ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_owl_watch_dedupe ON owl_watch(sci, ts);
