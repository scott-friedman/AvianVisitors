#!/usr/bin/env node
// build-signatures.mjs — precompute CANONICAL bird "song signatures".
//
// For each target species it pulls one clean, A-grade SONG recording from
// xeno-canto (license-filtered to stay inside our CC-BY-NC-SA-4.0 non-
// commercial project), trims it to its loudest ~3.5 s, runs the SHARED STFT
// analysis (avian/frontend/spectral-core.js — byte-identical to the browser),
// and writes:
//   avian/assets/signatures.json     { version, generated, species: { <sci>: {...} } }
//   avian/assets/songs/<slug>.mp3    the trimmed reference clip (tap-to-play)
//
// The bloom in the modal then renders this stable, species-true fingerprint
// instead of analyzing our own noisy field clips. Re-run any time to expand
// coverage (incremental by default; --force re-does everything).
//
// Requires: ffmpeg on PATH, and a xeno-canto v3 API key at
//   ~/.config/avian/xeno-canto-key   (free; mandatory since 2025-10-10)
//
// Usage:
//   node avian/scripts/build-signatures.mjs                 # detected species w/ art, missing only
//   node avian/scripts/build-signatures.mjs --all-art       # EVERY species with art ("all birds")
//   node avian/scripts/build-signatures.mjs --force         # rebuild (re-pick clips for) targets
//   node avian/scripts/build-signatures.mjs --only "Cyanocitta cristata"
//   node avian/scripts/build-signatures.mjs --limit 5       # first N (testing)
// Combine, e.g. `--all-art --force`. Curated per-species clip overrides:
//   avian/assets/signature-overrides.json  { "Genus species": <xeno-canto id> }
// Then: bash avian/build-site.sh && (cd worker && npx wrangler pages deploy ../_site \
//   --project-name barrysbirds --branch production)
//
// See SPECTRO-CONCEPTS-PLAN.md ("Runbook") and CLAUDE.md (Cloudflare side).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const Spectral = require('../frontend/spectral-core.js');
const { SPEC_FLO, SPEC_FHI } = Spectral;

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '..', '..');
const ILLU = path.join(ROOT, 'avian/assets/illustrations');
const SONGS = path.join(ROOT, 'avian/assets/songs');
const OUTJSON = path.join(ROOT, 'avian/assets/signatures.json');
const LIFELIST = 'https://avian-worker.s-friedman.workers.dev/api/lifelist';
const UA = 'avian-build/1.0 (bird signature pipeline; +https://barrysbirds.pages.dev)';
const SR = 48000, WIN = 3.5;          // analysis sample rate + reference-clip length (s)

const args = process.argv.slice(2);
const FORCE = args.includes('--force');
const ALL_ART = args.includes('--all-art');   // every species that has illustration art, not just detected
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const LIMIT = args.includes('--limit') ? +args[args.indexOf('--limit') + 1] : 0;

const KEYPATH = path.join(os.homedir(), '.config/avian/xeno-canto-key');
let KEY = '';
try { KEY = fs.readFileSync(KEYPATH, 'utf8').trim(); } catch (e) {}
if (!KEY) { console.error('No xeno-canto key at ' + KEYPATH); process.exit(1); }

// Optional per-species clip overrides for birds whose auto-picked clip is poor
// (e.g. woodpeckers have no tonal "song" so type:song returns drums/high calls).
// Map { "Genus species": <xeno-canto recording id> }; forces that exact clip.
// Drop a curated id here as you review coverage. No file => no overrides.
const OVERRIDE_PATH = path.join(ROOT, 'avian/assets/signature-overrides.json');
let OVERRIDE = {};
try { OVERRIDE = JSON.parse(fs.readFileSync(OVERRIDE_PATH, 'utf8')); } catch (e) {}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slugify = (sci) => sci.toLowerCase().trim().replace(/\s+/g, '-');
const hasArt = (sci) => fs.existsSync(path.join(ILLU, slugify(sci) + '.png'));
// slug "genus-species" -> "Genus species" (used by --all-art to turn the
// illustration filenames into queryable binomials).
const slugToSci = (slug) => { const p = slug.split('-'); return p[0].charAt(0).toUpperCase() + p[0].slice(1) + ' ' + p.slice(1).join(' '); };

// ---- license filter (reject ND - trimming is a derivative; reject all-rights) ----
function licCode(u) {
  const m = /licenses\/([a-z-]+)\//.exec(u || '');
  if (m) return m[1];
  if (/publicdomain\/zero/.test(u || '')) return 'cc0';
  return '';
}
const licOk = (u) => { const c = licCode(u); return c === 'cc0' || /^by(-nc)?(-sa)?$/.test(c); };
const lenSec = (s) => String(s || '').split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

// ---- xeno-canto v3 query (tag-only; colons stay literal, spaces -> %20) ----
async function xcQuery(gen, sp, q) {
  const tags = `gen:${gen} sp:${sp} grp:birds q:${q} type:song`;
  const url = `https://xeno-canto.org/api/3/recordings?query=${tags.replace(/ /g, '%20')}&key=${KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('xc query HTTP ' + res.status);
  const j = await res.json();
  if (j.error) throw new Error('xc: ' + j.message);
  return j.recordings || [];
}
// Fetch one specific recording by id (for OVERRIDE picks). `nr:` is the id tag.
async function xcById(id) {
  const url = `https://xeno-canto.org/api/3/recordings?query=nr:${id}&key=${KEY}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('xc id HTTP ' + res.status);
  const j = await res.json();
  return (j.recordings || []).filter((r) => r.file);
}
// Rank candidates by METADATA first: pure "song" (not call), no background
// species, short, A-grade. We then download the top few and keep the most
// TONAL one - many uploads tagged "song" are contaminated with chip calls,
// drumming, or other species, which drag the dominant pitch to nonsense.
function scoreMeta(r) {
  let s = 0;
  const t = String(r.type || '').toLowerCase();
  if (t === 'song') s += 3; else { if (t.includes('song')) s += 1; if (t.includes('call')) s -= 1; }
  s += (Array.isArray(r.also) ? r.also.length === 0 : !r.also) ? 2 : 0;
  const L = lenSec(r.length); if (L >= 2 && L <= 12) s += 1; else if (L > 30) s -= 1;
  if (r.q === 'A') s += 1;
  return s;
}
function candidates(recs) {
  return recs.filter((r) => r.file && licOk(r.lic)).sort((a, b) => scoreMeta(b) - scoreMeta(a));
}
// How clean/representative an analyzed clip looks: a narrow dominant band reads
// as tonal (good); a band-edge dominant or a near-empty/near-full voiced
// fraction suggests out-of-band content, noise, or contamination.
function tonality(an) {
  let score = 1 - Math.min(1, (an.hiHz - an.loHz) / (SPEC_FHI - SPEC_FLO));
  if (an.peakHz <= SPEC_FLO + 200 || an.peakHz >= SPEC_FHI - 300) score -= 0.25;
  const vf = an.voiced.reduce((a, b) => a + b, 0) / an.cols;
  if (vf < 0.12 || vf > 0.98) score -= 0.3;
  return score;
}
async function download(url, out) {
  const u = url + (url.includes('?') ? '&' : '?') + 'key=' + KEY;
  const res = await fetch(u, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error('download HTTP ' + res.status);
  fs.writeFileSync(out, Buffer.from(await res.arrayBuffer()));
}

// ---- ffmpeg helpers ----
function decodePCM(file) {
  const r = spawnSync('ffmpeg', ['-i', file, '-ac', '1', '-ar', String(SR), '-f', 'f32le',
    '-hide_banner', '-loglevel', 'error', '-'], { maxBuffer: 1 << 29 });
  if (r.status !== 0) throw new Error('ffmpeg decode: ' + String(r.stderr || '').slice(0, 160));
  const buf = r.stdout, n = Math.floor(buf.length / 4), f = new Float32Array(n);
  for (let i = 0; i < n; i++) f[i] = buf.readFloatLE(i * 4);   // alignment-safe
  return f;
}
function encodeClip(src, start, dur, out) {
  const r = spawnSync('ffmpeg', ['-y', '-ss', String(start.toFixed(3)), '-t', String(dur.toFixed(3)),
    '-i', src, '-ac', '1', '-ar', '32000', '-b:a', '64k', '-hide_banner', '-loglevel', 'error', out]);
  if (r.status !== 0) throw new Error('ffmpeg encode: ' + String(r.stderr || '').slice(0, 160));
}
// Loudest WIN-second window (coarse 50 ms energy envelope).
function peakWindow(f) {
  if (f.length <= WIN * SR) return { start: 0, dur: f.length / SR, seg: f };
  const fr = Math.floor(0.05 * SR), nF = Math.floor(f.length / fr), wF = Math.round(WIN / 0.05);
  const fe = new Float64Array(nF);
  for (let i = 0; i < nF; i++) { let s = 0; for (let j = 0; j < fr; j++) { const v = f[i * fr + j]; s += v * v; } fe[i] = s; }
  let sum = 0, best = -1, bestI = 0;
  for (let i = 0; i < nF; i++) { sum += fe[i]; if (i >= wF) sum -= fe[i - wF]; if (i >= wF - 1 && sum > best) { best = sum; bestI = i - wF + 1; } }
  const startS = bestI * fr, lenS = Math.min(wF * fr, f.length - startS);
  return { start: startS / SR, dur: lenS / SR, seg: f.subarray(startS, startS + lenS) };
}

const q3 = (a) => Array.from(a, (x) => Math.round(x * 1000) / 1000);
const qi = (a) => Array.from(a, (x) => Math.round(x));

async function buildOne(sci, db) {
  const [gen, sp] = sci.split(/\s+/);
  if (!gen || !sp) return { sci, status: 'skip', why: 'not binomial' };
  let cand;
  if (OVERRIDE[sci]) {                                // curated clip wins outright
    cand = (await xcById(OVERRIDE[sci])).filter((r) => licOk(r.lic));
    if (!cand.length) return { sci, status: 'skip', why: 'override XC' + OVERRIDE[sci] + ' missing/incompatible-license' };
  } else {
    let recs = await xcQuery(gen, sp, 'A');
    if (!recs.length) { await sleep(800); recs = await xcQuery(gen, sp, 'B'); }
    cand = candidates(recs);
    if (!cand.length) return { sci, status: 'skip', why: 'no compatible-license song' };
  }

  // Download the top few by metadata; keep the most tonal (stop early on a
  // clearly-clean one). Discard the losers' temp files as we go.
  const slug = slugify(sci), K = Math.min(4, cand.length);
  let best = null;
  for (let i = 0; i < K; i++) {
    const r = cand[i], tmp = path.join(os.tmpdir(), 'xc-' + r.id + '.dl');
    try {
      await download(r.file, tmp);
      const pcm = decodePCM(tmp);
      if (!pcm.length) throw new Error('empty');
      const w = peakWindow(pcm);
      const an = Spectral.analyzeBuffer({ getChannelData: () => w.seg, sampleRate: SR, duration: w.seg.length / SR });
      const score = tonality(an);
      if (!best || score > best.score) { if (best) { try { fs.unlinkSync(best.tmp); } catch (e) {} } best = { r, an, w, tmp, score }; }
      else { try { fs.unlinkSync(tmp); } catch (e) {} }
      if (best.score >= 0.6) break;          // clean enough - don't keep hammering the API
    } catch (e) { try { fs.unlinkSync(tmp); } catch (e2) {} }
    if (i < K - 1) await sleep(700);
  }
  if (!best) return { sci, status: 'skip', why: 'no usable clip' };

  const outMp3 = path.join(SONGS, slug + '.mp3');
  try {
    encodeClip(best.tmp, best.w.start, best.w.dur, outMp3);
    const an = best.an, pick = best.r;
    db.species[sci] = {
      cols: an.cols,
      energy: q3(an.energy),
      peakSmooth: qi(an.peakSmooth),
      voiced: Array.from(an.voiced),
      peakHz: Math.round(an.peakHz), loHz: Math.round(an.loHz), hiHz: Math.round(an.hiHz),
      dur: Math.round(an.dur * 100) / 100,
      clip: 'assets/songs/' + slug + '.mp3',
      attr: { rec: pick.rec || 'unknown', id: +pick.id, lic: pick.lic || '', url: pick.url || ('https://xeno-canto.org/' + pick.id) }
    };
    return { sci, status: 'built', why: `XC${pick.id} ${licCode(pick.lic)} ${pick.length} tonality=${best.score.toFixed(2)} by ${pick.rec}` };
  } finally {
    try { fs.unlinkSync(best.tmp); } catch (e) {}
  }
}

(async function main() {
  fs.mkdirSync(SONGS, { recursive: true });
  let db = { version: 1, generated: '', species: {} };
  if (fs.existsSync(OUTJSON)) { try { db = JSON.parse(fs.readFileSync(OUTJSON, 'utf8')); db.species = db.species || {}; } catch (e) {} }

  // Target species:
  //   --only "Genus species"  one bird
  //   --all-art               EVERY species that has illustration art (the
  //                           "do all birds" mode; ~one xeno-canto query each)
  //   (default)               the live DETECTED list, intersected with art
  let targets;
  if (ONLY) targets = [ONLY];
  else if (ALL_ART) {
    targets = fs.readdirSync(ILLU)
      .filter((f) => f.endsWith('.png') && !f.endsWith('-2.png'))
      .map((f) => slugToSci(f.replace(/\.png$/, '')))
      .sort();
  } else {
    const res = await fetch(LIFELIST, { headers: { 'User-Agent': UA } });
    const data = await res.json();
    targets = (data.species || []).map((s) => s.sci).filter(hasArt);
  }
  if (LIMIT) targets = targets.slice(0, LIMIT);

  const todo = targets.filter((sci) => FORCE || !db.species[sci]);
  console.log(`${targets.length} target species (${todo.length} to build${FORCE ? ', forced' : ', missing only'})`);

  const summary = { built: 0, skip: 0, fail: 0 };
  for (let i = 0; i < todo.length; i++) {
    const sci = todo[i];
    process.stdout.write(`[${i + 1}/${todo.length}] ${sci} … `);
    try {
      const r = await buildOne(sci, db);
      summary[r.status === 'built' ? 'built' : 'skip']++;
      console.log(r.status === 'built' ? `✓ ${r.why}` : `– skip (${r.why})`);
      if (r.status === 'built') fs.writeFileSync(OUTJSON, JSON.stringify({ ...db, generated: new Date().toISOString() }));
    } catch (e) {
      summary.fail++;
      console.log('✗ ' + e.message);
    }
    await sleep(1100);    // be polite to the xeno-canto API
  }
  db.generated = new Date().toISOString();
  fs.writeFileSync(OUTJSON, JSON.stringify(db));
  const built = Object.keys(db.species).length;
  console.log(`\nDone. built ${summary.built}, skipped ${summary.skip}, failed ${summary.fail}. signatures.json now holds ${built} species.`);
})();
