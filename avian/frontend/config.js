// AvianVisitors — per-deploy config for the static (Cloudflare Pages) collage.
// Point this at the avian-worker that serves /api/* over D1. Empty string ('')
// falls back to same-origin, i.e. the stock on-Pi PHP layout under ./avian/api/.
window.AVIAN_API_BASE = 'https://avian-worker.s-friedman.workers.dev';
