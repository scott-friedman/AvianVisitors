/**
 * The panel mirror: what the e-ink frame is ACTUALLY showing right now.
 *
 * The Pi uploads the exact 7-colour pixels it handed the panel, only after the
 * panel's refresh (dev.show()) returned — frame/panel_mirror.py. So this is not
 * "what /frame.png would render" (that can differ: quiet hours, a stale render
 * the Pi refused, a redraw still waiting for its 5-min tick, the Pi offline);
 * it is the last picture the hardware confirmed. No fallback to the render
 * cache, ever: if the Pi has never reported, the mirror says so.
 *
 *   POST /api/frame-confirmed    FRAME_KEY-gated (X-Frame-Key). Body: the PNG.
 *        Headers: X-Displayed-At (unix s), X-Image-SHA256 (hex of the body),
 *        optional X-Frame-Kind (collage|night) and X-Frame-Screen (night screen).
 *   GET  /api/frame-mirror       public JSON: when, what kind, which screen.
 *   GET  /api/frame-mirror.png   public PNG of the confirmed image.
 *
 * One row (id = 1) in D1 table panel_mirror (migration 0008).
 */

const MAX_BYTES = 1024 * 1024;
const PNG_MAGIC = [137, 80, 78, 71, 13, 10, 26, 10];
// The panel is 800×480; a portrait-mounted frame (rotate 90/270) is reported
// the way a viewer sees it, 480×800.
const SIZES = new Set(['800x480', '480x800']);
const KINDS = new Set(['collage', 'night']);
const SCREENS = new Set(['recap', 'star', 'sky', 'owl']);

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Expose-Headers': 'ETag, Last-Modified, X-Frame-Source',
  'X-Content-Type-Options': 'nosniff',
};

function empty(status, extra = {}) {
  return new Response(null, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });
}

function pngSize(bytes) {
  if (bytes.length < 33 || bytes.length > MAX_BYTES) return null;
  if (!PNG_MAGIC.every((v, i) => bytes[i] === v)) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return `${dv.getUint32(16)}x${dv.getUint32(20)}`;
}
export function validMirrorPng(bytes) {
  return SIZES.has(pngSize(bytes));
}

async function sha256Hex(bytes) {
  const d = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

// Constant-time compare via fixed-length digests.
async function keyMatches(provided, expected) {
  if (!expected || !provided || provided.length > 1024) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([sha256Hex(enc.encode(provided)), sha256Hex(enc.encode(expected))]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const asBytes = (blob) => (blob instanceof Uint8Array ? blob : new Uint8Array(blob));

// GET /api/frame-mirror — what the frame shows, as data (no image bytes).
export async function frameMirrorInfo(env) {
  const row = await env.DB.prepare(
    'SELECT sha256, displayed_at, kind, screen FROM panel_mirror WHERE id = 1'
  ).first();
  const body = row
    ? { ok: true, sha256: row.sha256, displayed_at: Number(row.displayed_at),
        kind: row.kind || null, screen: row.screen || null }
    : { ok: false, reason: 'not reported yet' };
  return new Response(JSON.stringify(body), {
    headers: { ...CORS, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// GET/HEAD /api/frame-mirror.png — the confirmed image itself. The page asks
// for it as ?v=<sha256>, so each picture gets its own browser cache entry.
export async function frameMirrorPng(request, env) {
  if (!['GET', 'HEAD'].includes(request.method)) return empty(405);
  const row = await env.DB.prepare(
    'SELECT png, sha256, displayed_at FROM panel_mirror WHERE id = 1'
  ).first();
  if (!row || !row.png) return empty(404);
  const bytes = asBytes(row.png);
  if (!validMirrorPng(bytes)) return empty(404);
  const etag = `"${row.sha256}"`;
  const want = new URL(request.url).searchParams.get('v');
  const headers = {
    ...CORS,
    'Content-Type': 'image/png',
    // A ?v= that matches the stored picture never changes → cache it hard.
    // Anything else is "whatever is current" → short.
    'Cache-Control': want === row.sha256 ? 'public, max-age=86400, immutable' : 'public, max-age=60',
    ETag: etag,
    'Last-Modified': new Date(Number(row.displayed_at) * 1000).toUTCString(),
    'X-Frame-Source': 'panel-confirmed',
  };
  const inm = request.headers.get('If-None-Match') || '';
  if (inm.split(',').some((t) => [etag, '*'].includes(t.trim().replace(/^W\//, '')))) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(request.method === 'HEAD' ? null : bytes, { headers });
}

// POST /api/frame-confirmed — the Pi, right after the panel finished a redraw.
export async function frameConfirmed(request, env) {
  if (!(await keyMatches(request.headers.get('X-Frame-Key') || '', env.FRAME_KEY))) return empty(401);
  if ((request.headers.get('Content-Type') || '').split(';')[0].trim() !== 'image/png') return empty(415);
  const when = Number(request.headers.get('X-Displayed-At'));
  const claimed = (request.headers.get('X-Image-SHA256') || '').toLowerCase();
  if (!Number.isFinite(when) || when <= 0 || when > Date.now() / 1000 + 300 || !/^[0-9a-f]{64}$/.test(claimed)) {
    return empty(400);
  }
  if (Number(request.headers.get('Content-Length') || 0) > MAX_BYTES) return empty(413);
  const bytes = await readCapped(request);
  if (bytes === 413) return empty(413);
  if (!bytes || !validMirrorPng(bytes) || (await sha256Hex(bytes)) !== claimed) return empty(400);

  const kind = (request.headers.get('X-Frame-Kind') || '').toLowerCase();
  const screen = (request.headers.get('X-Frame-Screen') || '').toLowerCase();
  // Only ever move forward: a late retry of an older upload must not
  // replace a newer picture (the WHERE on the upsert enforces it).
  await env.DB.prepare(
    'INSERT INTO panel_mirror (id, png, sha256, displayed_at, kind, screen) VALUES (1, ?, ?, ?, ?, ?) ' +
    'ON CONFLICT(id) DO UPDATE SET png = excluded.png, sha256 = excluded.sha256, ' +
    'displayed_at = excluded.displayed_at, kind = excluded.kind, screen = excluded.screen ' +
    'WHERE excluded.displayed_at > panel_mirror.displayed_at'
  ).bind(bytes.buffer, claimed, when,
    KINDS.has(kind) ? kind : null,
    kind === 'night' && SCREENS.has(screen) ? screen : null).run();
  return empty(204);
}

async function readCapped(request) {
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > MAX_BYTES) { await reader.cancel(); return 413; }
      chunks.push(value);
    }
  } catch { return null; }
  const out = new Uint8Array(length);
  let off = 0;
  for (const c of chunks) { out.set(c, off); off += c.length; }
  return out;
}
