-- Single-row cache of the rendered e-ink frame PNG. See PLAN.md Phase 4.
--   Apply remote:   wrangler d1 migrations apply avian-detections --remote
--
-- /frame.png renders the 800x480 collage via Cloudflare Browser Rendering, which
-- on the Workers Free plan is capped at 10 minutes of browser time per day. To
-- stay well under that, the Worker re-renders only when the detection set's
-- signature changes; identical frames are served straight from this one row
-- (id is pinned to 1, so INSERT OR REPLACE keeps exactly one cached frame).

CREATE TABLE IF NOT EXISTS frame_cache (
  id  INTEGER PRIMARY KEY CHECK (id = 1),  -- pinned single row
  sig TEXT NOT NULL,                        -- signature of the rendered species set
  png BLOB NOT NULL,                        -- 800x480 PNG bytes
  ts  INTEGER NOT NULL                      -- unix seconds (UTC) the frame was rendered
);
