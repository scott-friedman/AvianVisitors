-- Single-row liveness heartbeat. See REVIEW-TODO.md A-High.
--   Apply remote:   wrangler d1 migrations apply avian-detections --remote
--
-- The Pi pings POST /api/heartbeat on a 15-min systemd timer, INDEPENDENT of
-- bird activity (so a quiet night never reads as "dead"). GET /api/status turns
-- the stored ts into a 200 (fresh) / 503 (stale) response so any external uptime
-- monitor can alert when the box goes silent. One row, id pinned to 1
-- (INSERT OR REPLACE keeps exactly one), mirroring frame_cache.

CREATE TABLE IF NOT EXISTS heartbeat (
  id INTEGER PRIMARY KEY CHECK (id = 1),  -- pinned single row
  ts INTEGER NOT NULL                     -- unix seconds (UTC) of the last ping
);
