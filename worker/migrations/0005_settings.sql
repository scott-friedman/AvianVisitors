-- Singleton settings row. See FRAME-WINDOW-TOGGLE-PLAN.md.
--   Apply remote:   wrangler d1 migrations apply avian-detections --remote
--
-- Holds shared, server-side knobs the public site can change for the PHYSICAL
-- e-ink frame (as opposed to the per-device localStorage prefs). Today that's
-- just the frame's time window (1H/12H/24H/7D/ALL → 1/12/24/168/1000000 hours);
-- /frame.png and the Pi's change-detector both read it via /api/frame-config.
-- One row, id pinned to 1 (INSERT OR REPLACE keeps exactly one), mirroring
-- frame_cache and heartbeat.

CREATE TABLE IF NOT EXISTS settings (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),  -- pinned single row
  frame_window_hours INTEGER NOT NULL DEFAULT 24          -- frame window, in hours
);
INSERT OR IGNORE INTO settings (id, frame_window_hours) VALUES (1, 24);
