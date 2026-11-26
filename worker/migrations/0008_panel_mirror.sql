-- The panel mirror (worker/src/panel-mirror.js): the one image the physical
-- e-ink panel last confirmed it is showing, uploaded by the Pi after each
-- redraw (frame/panel_mirror.py). Deliberately NOT seeded from frame_cache: a
-- rendered image is not evidence that the panel ever showed it.
CREATE TABLE IF NOT EXISTS panel_mirror (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  png BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  displayed_at REAL NOT NULL,
  kind TEXT,      -- 'collage' | 'night' (from the worker's X-Frame-Kind)
  screen TEXT     -- night screen: 'recap' | 'star' | 'sky' | 'owl'
);
