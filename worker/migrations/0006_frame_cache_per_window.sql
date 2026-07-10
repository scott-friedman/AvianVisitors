-- One cached frame PER WINDOW (id = window hours: 1/12/24/168/1000000),
-- replacing the single pinned row. Why: /api/frame-config is public (the site's
-- picker writes it), so flipping the window must not be able to force a metered
-- Browser-Rendering re-render on every 5-min Pi poll. With a per-window cache a
-- flip just serves the other window's cached PNG; a render happens only when
-- that window's detection signature actually changes. Bounded: ids come from
-- the validated FRAME_WINDOWS list, so at most 5 rows ever.
--
--   Apply remote BEFORE deploying the worker code that uses it:
--     wrangler d1 migrations apply avian-detections --remote
--   (Old worker code keeps working against the new table — it reads/writes
--    id=1. New code against the OLD table would fail its CHECK (id = 1) on the
--    first non-1h render, so migrate first.)

CREATE TABLE frame_cache_new (
  id  INTEGER PRIMARY KEY,  -- frame window in hours this PNG was rendered for
  sig TEXT NOT NULL,        -- signature of the rendered species set (+ window)
  png BLOB NOT NULL,        -- 800x480 PNG bytes
  ts  INTEGER NOT NULL      -- unix seconds (UTC) the frame was rendered
);

-- Seed with the existing frame under the currently-configured window, so the
-- panel doesn't need an immediate re-render right after the deploy.
INSERT INTO frame_cache_new (id, sig, png, ts)
  SELECT COALESCE((SELECT frame_window_hours FROM settings WHERE id = 1), 24),
         sig, png, ts
    FROM frame_cache;

DROP TABLE frame_cache;
ALTER TABLE frame_cache_new RENAME TO frame_cache;
