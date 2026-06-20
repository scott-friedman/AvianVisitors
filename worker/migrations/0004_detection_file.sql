-- Add the R2 object key (clip basename) per detection. See AUDIO-FIX-PLAN.md.
--   Apply remote: wrangler d1 migrations apply avian-detections --remote
--
-- Nullable: pre-audio rows and any detection whose clip we couldn't read stay
-- NULL. The value PERSISTS even after the clip's 7-day R2 lifecycle deletes the
-- object — the detection row (counts/lifelist/stats) is never purged; only the
-- audio expires, after which /api/recording?file=<key> simply 404s ("no audio").
ALTER TABLE detections ADD COLUMN file TEXT;
