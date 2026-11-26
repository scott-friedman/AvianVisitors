// Tests for the "play" view's engine (avian/frontend/sampler-core.js) and its
// songbook. Run with:  node --test avian/tests/
//
// The analysis is checked against SYNTHETIC sound — tones whose pitch, start
// and length are known exactly — so a regression shows up as a number that is
// wrong, not as "it sounds a bit off". (No recordings are needed or bundled.)
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const CORE = fileURLToPath(new URL('../frontend/sampler-core.js', import.meta.url));
const S = require(CORE);
const BOOK = require('../frontend/songbook.js');

const SR = 32000;
// A small deterministic noise source, so every run sees the same "weather".
function rng(seed) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function clip(seconds, noise = 0.002, seed = 7) {
  const r = rng(seed), a = new Float32Array(Math.round(seconds * SR));
  for (let i = 0; i < a.length; i++) a[i] = (r() + r() + r() - 1.5) * noise;
  return a;
}
// Add a tone. hz may be a number or a function of t (seconds into the tone).
function tone(a, at, dur, hz, amp = 0.3, ramp = 0.008) {
  const n0 = Math.round(at * SR), n = Math.round(dur * SR);
  let ph = 0;
  for (let i = 0; i < n && n0 + i < a.length; i++) {
    const t = i / SR, f = typeof hz === 'function' ? hz(t) : hz;
    ph += 2 * Math.PI * f / SR;
    const env = Math.min(1, t / ramp, (dur - t) / ramp);
    a[n0 + i] += amp * env * Math.sin(ph);
  }
  return a;
}
const cents = (a, b) => 1200 * Math.log2(a / b);
const near = (got, want, tol, msg) => assert.ok(Math.abs(got - want) <= tol, `${msg}: got ${got}, want ${want} ± ${tol}`);

// ------------------------------------------------------------- analysis ----
test('finds whistled notes: the right pitch, the right place', () => {
  const a = clip(3);
  tone(a, 0.50, 0.25, 2000);
  tone(a, 1.20, 0.30, 3520);
  tone(a, 2.00, 0.20, 4186.01);
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, 3);
  const want = [[0.50, 0.25, 2000], [1.20, 0.30, 3520], [2.00, 0.20, 4186.01]];
  r.notes.forEach((n, i) => {
    const [at, dur, hz] = want[i];
    near(cents(n.hz, hz), 0, 4, `note ${i} pitch (cents)`);
    near(n.t0, at, 0.012, `note ${i} start`);
    assert.ok(n.t0 <= at + 0.004, `note ${i} must not start after its attack (t0 ${n.t0})`);
    assert.ok(n.s0 >= at - 0.02 && n.s1 <= at + dur + 0.02, `note ${i} steady part inside the tone`);
    assert.ok(n.t1 >= at + dur - 0.03 && n.t1 <= at + dur + 0.06, `note ${i} end (t1 ${n.t1})`);
    assert.ok(n.q > 0.7, `note ${i} quality ${n.q}`);
    assert.ok(n.rms > 0.15 && n.rms < 0.25, `note ${i} rms ${n.rms}`);   // 0.3 peak sine ≈ 0.21 rms
  });
  assert.equal(S.noteName(r.notes[1].midi), 'A7');
  assert.equal(S.noteName(r.notes[2].midi), 'C8');
});

test('measures pitch to within a few cents across the range', () => {
  for (const hz of [330, 587.33, 1046.5, 1975.53, 2793.83, 5587.65, 7902.13, 9500]) {
    const r = S.analyzeClip(tone(clip(1.6), 0.6, 0.3, hz), SR);
    assert.equal(r.notes.length, 1, `${hz} Hz: one note`);
    near(cents(r.notes[0].hz, hz), 0, 5, `${hz} Hz (cents)`);
  }
});

test('works at 44.1 and 48 kHz too (browsers that will not decode at 32 kHz)', () => {
  for (const sr of [44100, 48000]) {
    const a = new Float32Array(sr * 2), r0 = rng(3);
    for (let i = 0; i < a.length; i++) a[i] = (r0() - 0.5) * 0.004;
    const n0 = Math.round(0.7 * sr), n = Math.round(0.3 * sr);
    for (let i = 0; i < n; i++) a[n0 + i] += 0.3 * Math.min(1, i / 300, (n - i) / 300) * Math.sin(2 * Math.PI * 3000 * i / sr);
    const r = S.analyzeClip(a, sr);
    assert.equal(r.notes.length, 1);
    near(cents(r.notes[0].hz, 3000), 0, 4, `${sr} pitch`);
    near(r.notes[0].t0, 0.7, 0.015, `${sr} start`);
  }
});

test('a sweep is not a note', () => {
  const a = clip(2);
  tone(a, 0.6, 0.18, (t) => 2000 * Math.pow(3, t / 0.18));    // 2 → 6 kHz in 180 ms
  assert.equal(S.analyzeClip(a, SR).notes.length, 0);
});

test('keeps the natural slide into a note, but pitches only the steady part', () => {
  const a = clip(2);
  // 70 ms slide up from 3 kHz, then 220 ms held at 4 kHz: one continuous call.
  tone(a, 0.6, 0.29, (t) => (t < 0.07 ? 3000 * Math.pow(4000 / 3000, t / 0.07) : 4000));
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, 1);
  const n = r.notes[0];
  near(cents(n.hz, 4000), 0, 8, 'pitch is the held part');
  assert.ok(n.s0 > 0.6 + 0.04, `steady part starts after the slide (s0 ${n.s0})`);
  near(n.t0, 0.6, 0.015, 'sample still starts at the slide');
  // The "body" starts where the slide comes within a semitone of the note
  // (about 56 ms in), not at the bottom of the slide and not as late as s0.
  assert.ok(n.b0 > 0.6 + 0.03 && n.b0 < 0.6 + 0.075, `body starts near the top of the slide (b0 ${n.b0})`);
  assert.ok(n.t0 <= n.b0 && n.b0 <= n.s0 && n.s1 <= n.b1 && n.b1 <= n.t1, 'whole ⊇ body ⊇ steady');
  near(n.b1, n.t1, 1e-9, 'nothing slides away afterwards, so the body runs to the end');
});

test('a call that falls away after its note: the fall is kept, but outside the body', () => {
  const a = clip(2);
  // 90 ms held at 3350 Hz, then a 100 ms fall of a fourth: a titmouse "peter".
  tone(a, 0.6, 0.19, (t) => (t < 0.09 ? 3350 : 3350 * Math.pow(0.75, (t - 0.09) / 0.1)));
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, 1);
  const n = r.notes[0];
  near(cents(n.hz, 3350), 0, 25, 'pitch is the held part');
  assert.ok(n.t1 > 0.6 + 0.17, `the whole call includes the fall (t1 ${n.t1})`);
  assert.ok(n.b1 < 0.6 + 0.14, `the body stops within a semitone of the note (b1 ${n.b1})`);
  assert.ok(n.b1 >= n.s1 && n.b0 <= n.s0);
});

test('a clean whistle outranks a trill on the same pitch', () => {
  // A wren's burble holds a "steady pitch" on paper, but it is a fast warble
  // around it. Both are real and both stay playable; the whistle is the better note.
  const a = clip(3);
  tone(a, 0.5, 0.25, 3000, 0.3);
  const at = Math.round(1.6 * SR), n = Math.round(0.25 * SR);
  let ph = 0;
  for (let i = 0; i < n; i++) {
    const t = i / SR, env = Math.min(1, i / 256, (n - i) / 256);
    ph += 2 * Math.PI * (3000 + 70 * Math.sin(2 * Math.PI * 45 * t)) / SR;     // ±70 Hz, 45 times a second
    a[at + i] += 0.3 * env * Math.sin(ph);
  }
  const notes = S.analyzeClip(a, SR).notes.filter((x) => Math.abs(x.hz - 3000) < 60);
  const whistle = notes.find((x) => x.t0 < 1), trill = notes.find((x) => x.t0 > 1);
  assert.ok(whistle && whistle.tone > 0.9, 'whistle tone ' + (whistle && whistle.tone));
  assert.ok(trill, 'the trill is still found');
  assert.ok(trill.tone < 0.8, 'trill tone ' + trill.tone);
  assert.ok(trill.q < whistle.q * 0.85, `trill q ${trill.q} vs whistle q ${whistle.q}`);
});

test('stacks overtones under their fundamental', () => {
  const a = clip(2);
  [1, 2, 3, 4].forEach((k) => tone(a, 0.6, 0.3, 800 * k, 0.24 / k));
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, 1);
  near(cents(r.notes[0].hz, 800), 0, 5, 'pitch');
  assert.ok(r.notes[0].harm >= 3, `harmonics stacked: ${r.notes[0].harm}`);
  assert.equal(r.notes[0].div, 1);
});

test('hears a missing fundamental (overtones 2·3·4 of 500 Hz)', () => {
  const a = clip(2);
  [2, 3, 4].forEach((k) => tone(a, 0.6, 0.3, 500 * k, 0.2));
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, 1);
  near(cents(r.notes[0].hz, 500), 0, 6, 'pitch');
  assert.equal(r.notes[0].div, 2);
});

test('two birds a fifth apart are not one deep note (a pair is not a comb)', () => {
  // Overtones 2 and 3 of 1000 Hz look just like this. With only two partials
  // to go on, the engine must not invent the 1000 Hz note underneath them.
  const a = clip(2);
  tone(a, 0.6, 0.3, 2000, 0.3);
  tone(a, 0.6, 0.3, 3000, 0.15);
  const hz = S.analyzeClip(a, SR).notes.map((n) => Math.round(n.hz));
  assert.ok(hz.every((h) => h > 1500), 'no missing fundamental: ' + hz);
  assert.ok(hz.some((h) => Math.abs(h - 2000) <= 6), 'the louder bird is found at its own pitch: ' + hz);
});

test('a note sung under a louder neighbour is not offered', () => {
  // Cut out and played, it would sound as the neighbour's pitch, not its own.
  const a = clip(3);
  tone(a, 0.5, 0.3, 2000, 0.3);        // together: the 2000 Hz bird is twice as loud
  tone(a, 0.5, 0.3, 3000, 0.15);
  tone(a, 1.6, 0.3, 3000, 0.15);       // the quiet bird alone: a perfectly good note
  const notes = S.analyzeClip(a, SR).notes;
  const at3000 = notes.filter((n) => Math.abs(n.hz - 3000) < 10);
  assert.equal(at3000.length, 1);
  near(at3000[0].t0, 1.6, 0.012, 'the take kept is the one sung alone');
  assert.equal(notes.filter((n) => Math.abs(n.hz - 2000) < 8).length, 1);
  // Rumble far below a note does not count against it: playback cuts it.
  const b = clip(2);
  tone(b, 0.5, 0.4, 5000, 0.1);
  tone(b, 0.45, 0.5, 400, 0.4);        // a loud low thrum under a quiet high note
  const high = S.analyzeClip(b, SR).notes.filter((n) => Math.abs(n.hz - 5000) < 12);
  assert.equal(high.length, 1, 'the high note survives the thrum');
  assert.ok(high[0].purity > 0.8, 'and is judged clean: ' + high[0].purity);
  // A steady drone in the note's own band (a tree frog, a compressor) is on the
  // tape even though the analysis tunes it out: a note quieter than the drone
  // would play back as the drone, a louder one is fine.
  const drone = (amp) => {
    const c = clip(3);
    tone(c, 0, 3, 1100, 0.2, 0.05);
    tone(c, 1.2, 0.3, 1866, amp);
    return S.analyzeClip(c, SR).notes.filter((n) => Math.abs(n.hz - 1866) < 8).length;
  };
  assert.equal(drone(0.08), 0, 'quieter than the drone');
  assert.equal(drone(0.5), 1, 'louder than the drone');
});

test('silence, hiss, hum and a thump give no notes', () => {
  assert.equal(S.analyzeClip(new Float32Array(SR * 2), SR).notes.length, 0, 'digital silence');
  assert.equal(S.analyzeClip(clip(3, 0.05), SR).notes.length, 0, 'hiss');
  const hum = clip(3, 0.004);
  tone(hum, 0, 3, 1000, 0.1, 0.001);                          // a steady drone, start to finish
  assert.equal(S.analyzeClip(hum, SR).notes.length, 0, 'a constant drone is background, not a note');
  const thump = clip(3, 0.003), r = rng(11);
  for (let i = 0; i < 0.12 * SR; i++) thump[SR + i] += (r() - 0.5) * 0.9 * Math.exp(-i / (0.03 * SR));
  assert.equal(S.analyzeClip(thump, SR).notes.length, 0, 'broadband thump');
  assert.equal(S.analyzeClip(new Float32Array(100), SR).notes.length, 0, 'too short to analyse');
});

test('survives field noise: a whistle 10 dB above pink-ish noise', () => {
  const a = clip(3, 0.0, 5), r = rng(21);
  let lp = 0;
  for (let i = 0; i < a.length; i++) { lp = 0.97 * lp + 0.03 * (r() - 0.5); a[i] = lp * 0.9 + (r() - 0.5) * 0.03; }
  tone(a, 1.2, 0.35, 3136, 0.06);
  const r1 = S.analyzeClip(a, SR);
  assert.equal(r1.notes.length, 1);
  near(cents(r1.notes[0].hz, 3136), 0, 6, 'pitch in noise');
});

test('a repeated call is capped per key; split calls are separate notes', () => {
  const a = clip(4);
  for (let i = 0; i < 9; i++) tone(a, 0.3 + i * 0.38, 0.2, 2637);          // nine identical "cheer"s
  const r = S.analyzeClip(a, SR);
  assert.equal(r.notes.length, S.CFG.perKey);
  const b = clip(2);
  tone(b, 0.5, 0.15, 3000); tone(b, 0.68, 0.15, 3000);                     // "pe-ter": 30 ms gap
  assert.equal(S.analyzeClip(b, SR, { maxNotes: 40 }).notes.length, 2);
});

test('finds the lively stretch of a clip for the soundboard', () => {
  const a = clip(6);
  tone(a, 2.4, 0.2, 3000); tone(a, 2.7, 0.2, 3400); tone(a, 3.0, 0.2, 3000);
  const r = S.analyzeClip(a, SR);
  assert.ok(r.phrase, 'has a phrase');
  assert.ok(r.phrase.t0 <= 2.4 && r.phrase.t0 >= 2.0, `phrase start ${r.phrase.t0}`);
  assert.ok(r.phrase.t1 >= 3.2 && r.phrase.t1 <= 3.6, `phrase end ${r.phrase.t1}`);
});

test('cutClip hands back full-scale 16-bit samples and rescales rms to match', () => {
  const a = tone(clip(2), 0.6, 0.3, 2500, 0.05);              // a quiet, far-off bird
  const r = S.analyzeClip(a, SR);
  const before = r.notes[0].rms;
  const bufs = S.cutClip(a, SR, r, { phrase: true });
  const n = r.notes[0];
  assert.ok(n.pcm instanceof Int16Array);
  assert.equal(n.z1, n.t1, 'a lone note has nothing after it');
  near(n.pcm.length, Math.ceil(n.t1 * SR) - Math.floor(n.t0 * SR), 1, 'sample length');
  let peak = 0; for (const v of n.pcm) peak = Math.max(peak, Math.abs(v));
  near(peak / 32767, 0.92, 0.01, 'peak normalised');
  assert.ok(n.rms / before > 16 && n.rms / before < 18.5, `rms follows the gain (×${n.rms / before})`);   // ≈ 0.92 / 0.05
  assert.ok(r.phrase.pcm instanceof Int16Array && r.phrase.rms > 0);
  assert.equal(bufs.length, 2);
});

test('a note is followed through the rest of the bird\'s call, up to its next pause', () => {
  // "tsee … tu-tu-tu": the note, then three more syllables 90 ms apart, then
  // nothing for a long second, then a different call.
  const a = clip(5);
  tone(a, 1.00, 0.16, 4000);
  tone(a, 1.25, 0.10, 3300); tone(a, 1.44, 0.10, 3100); tone(a, 1.63, 0.10, 2900);
  tone(a, 2.90, 0.20, 5000);
  const r = S.analyzeClip(a, SR);
  const first = r.notes.find((n) => Math.abs(n.hz - 4000) < 60);
  assert.ok(first, 'the first note is found');
  assert.ok(first.t1 < 1.25, `its own syllable ends before the next one (t1 ${first.t1})`);
  near(first.z1, 1.73, 0.09, 'the call is followed to the end of its last syllable');
  // The last syllable of the run has nothing after it but a long pause.
  const last = r.notes.find((n) => Math.abs(n.hz - 2900) < 60);
  assert.ok(last && last.z1 - last.t1 < 0.05, `nothing follows the last syllable (z1 ${last && last.z1}, t1 ${last && last.t1})`);
  // The cut carries the whole run, and says how loud the rest of it gets.
  S.cutClip(a, SR, r);
  near(first.pcm.length / SR, first.z1 - first.t0, 0.002, 'samples run from t0 to z1');
  assert.ok(first.tail > 0.5 * first.rms && first.tail < 2 * first.rms, `tail loudness is on the note's scale (${first.tail} vs ${first.rms})`);
  assert.equal(last.tail, 0, 'no tail, no tail loudness');
});

test('a lone note, or one in steady hiss, is not stretched', () => {
  const lone = S.analyzeClip(tone(clip(3), 1.0, 0.25, 3000), SR).notes[0];
  assert.equal(lone.z1, lone.t1);
  const hissy = S.analyzeClip(tone(clip(3, 0.03), 1.0, 0.25, 3000, 0.3), SR).notes[0];
  assert.ok(hissy, 'still found in hiss');
  assert.ok(hissy.z1 - hissy.t1 < 0.05, `hiss is not the bird singing on (z1 ${hissy.z1}, t1 ${hissy.t1})`);
});

test('a long call is followed no further than singMs', () => {
  const a = clip(6);
  tone(a, 1.0, 0.15, 3500);
  for (let t = 1.25; t < 5; t += 0.2) tone(a, t, 0.12, 2600);          // a trill that goes on and on
  const n = S.analyzeClip(a, SR).notes.find((x) => Math.abs(x.hz - 3500) < 60);
  assert.ok(n, 'note found');
  near(n.z1 - n.t1, S.CFG.singMs / 1000, 0.08, 'followed for singMs, no more');
});

// A burst of plain noise (no pitch): a rustle, a slammed door.
function burst(a, at, dur, amp, seed = 11) {
  const r = rng(seed), n0 = Math.round(at * SR), n = Math.round(dur * SR);
  for (let i = 0; i < n && n0 + i < a.length; i++) a[n0 + i] += (r() * 2 - 1) * amp * Math.min(1, i / 200, (n - i) / 200);
  return a;
}
const rmsIn = (x, from, to) => { let e = 0; const a = Math.round(from * SR), z = Math.round(to * SR); for (let i = a; i < z; i++) e += x[i] * x[i]; return Math.sqrt(e / (z - a)); };

test('the background is turned down around a call, and the call is left as it was', () => {
  const a = tone(clip(3, 0.02), 1.0, 0.4, 3000, 0.3);
  const r = S.analyzeClip(a, SR);
  assert.ok(r.nr && r.nr.pass instanceof Uint8Array, 'the call/background map is there for cutClip');
  const c = S.cleanSlice(a, SR, r.nr, 0, a.length);
  assert.equal(c.length, a.length);
  // Hiss on its own: down by cleanDb (12 dB = ×0.25).
  near(rmsIn(c, 0.2, 0.8) / rmsIn(a, 0.2, 0.8), Math.pow(10, -S.CFG.cleanDb / 20), 0.05, 'hiss level, as a share of what it was');
  // The whistle: untouched (its level within a hair), with less hiss riding on it.
  near(rmsIn(c, 1.05, 1.35), 0.3 / Math.SQRT2, 0.006, 'tone level after cleaning');
  assert.ok(rmsIn(c, 1.05, 1.35) <= rmsIn(a, 1.05, 1.35), 'nothing was added');
  // And it joins up with no click at the edges of a slice cut from the middle.
  const mid = S.cleanSlice(a, SR, r.nr, Math.round(0.9 * SR), Math.round(1.5 * SR));
  for (let i = 0; i < mid.length; i += 97) near(mid[i], c[Math.round(0.9 * SR) + i], 1e-4, `sample ${i} of a slice matches the whole`);
});

// Noise confined to a band of frequencies (a windowed-sinc band-pass over white
// noise): what a crow's caw or a jay's scream is made of.
function harsh(a, at, dur, amp, loHz, hiHz, seed = 5) {
  const r = rng(seed), n0 = Math.round(at * SR), n = Math.round(dur * SR), L = 129, h = new Float64Array(L);
  for (let i = 0; i < L; i++) {
    const m = i - (L - 1) / 2, w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (L - 1));
    const sinc = (f) => (m === 0 ? 2 * f / SR : Math.sin(2 * Math.PI * f * m / SR) / (Math.PI * m));
    h[i] = (sinc(hiHz) - sinc(loHz)) * w;
  }
  const white = new Float64Array(n + L);
  for (let i = 0; i < white.length; i++) white[i] = r() * 2 - 1;
  let peak = 0; const y = new Float64Array(n);
  for (let i = 0; i < n; i++) { let v = 0; for (let k = 0; k < L; k++) v += h[k] * white[i + k]; y[i] = v; peak = Math.max(peak, Math.abs(v)); }
  for (let i = 0; i < n && n0 + i < a.length; i++) a[n0 + i] += amp * (y[i] / peak) * Math.min(1, i / 200, (n - i) / 200);
  return a;
}

test('a loud rough call is not thinned out, however much of the band it fills', () => {
  // A caw: loud noise between 1.5 and 4.5 kHz. It is the bird, so it stays.
  const a = harsh(clip(3, 0.004), 1.0, 0.3, 0.3, 1500, 4500);
  const ca = S.cleanSlice(a, SR, S.analyzeClip(a, SR).nr, 0, a.length);
  const cawDb = 20 * Math.log10(rmsIn(ca, 1.05, 1.25) / rmsIn(a, 1.05, 1.25));
  assert.ok(cawDb > -1.5, `the caw keeps its level (${cawDb.toFixed(2)} dB)`);
  // A jay's scream fills most of the band. Still the bird. (On the real clips
  // the first cut of this took a loud, close jay or cardinal for noise and
  // turned it down; only what is ALWAYS there counts as background.)
  const b = harsh(clip(3, 0.004), 1.0, 0.3, 0.3, 1200, 10000);
  const cb = S.cleanSlice(b, SR, S.analyzeClip(b, SR).nr, 0, b.length);
  const jayDb = 20 * Math.log10(rmsIn(cb, 1.05, 1.25) / rmsIn(b, 1.05, 1.25));
  assert.ok(jayDb > -1.5, `the scream keeps its level (${jayDb.toFixed(2)} dB)`);
  // ...while the hiss before it is down by the full amount.
  near(rmsIn(cb, 0.2, 0.8) / rmsIn(b, 0.2, 0.8), Math.pow(10, -S.CFG.cleanDb / 20), 0.05, 'hiss level, as a share of what it was');
});

test('a note with a racket over it is marked down, and one drowned by it is not used', () => {
  // The same quiet whistle with a rustle over it, louder each time.
  const under = (amp) => {
    const a = tone(clip(3), 1.0, 0.3, 3000, 0.1);
    if (amp) burst(a, 0.9, 0.5, amp);
    return S.analyzeClip(a, SR).notes.find((x) => Math.abs(x.hz - 3000) < 60);
  };
  const clean = under(0), some = under(0.1), lots = under(0.2);
  assert.ok(clean.bg < -20, `a clean note has next to nothing around it (${clean.bg.toFixed(1)} dB)`);
  assert.ok(some.bg > clean.bg + 15 && lots.bg > some.bg + 3, `noise around the note is measured (${some.bg.toFixed(1)}, ${lots.bg.toFixed(1)} dB)`);
  assert.ok(lots.bg > 0, 'a rustle louder than the note reads as more noise than note');
  assert.equal(under(0.8), undefined, 'a drowned note is not offered at all');
  // The same three as takes of one key: the cleaner the slice, the better its rank.
  const takes = [clean, some, lots].map((n, i) => Object.assign({}, n, { sci: 'a', clip: 'c' + i }));
  S.rankNotes(takes);
  assert.ok(takes[0].rank > takes[1].rank && takes[1].rank > takes[2].rank, 'cleaner takes rank higher');
  assert.ok(takes[2].rank < 0.8 * takes[2].q, 'and noise costs more than the note\'s own score says');
});

test('a note the bird sings on from is preferred, a little', () => {
  const lone = { sci: 'a', clip: '1', midi: 80, q: 0.8, t1: 1.2, z1: 1.2 };
  const sung = { sci: 'a', clip: '2', midi: 80, q: 0.8, t1: 1.2, z1: 2.0 };
  const best = { sci: 'a', clip: '3', midi: 80, q: 1.0, t1: 1.2, z1: 1.2 };
  S.rankNotes([lone, sung, best]);
  assert.ok(sung.rank > lone.rank, 'between equals, the one with a call after it');
  near(sung.rank / lone.rank, 1 + S.CFG.singBonus, 1e-9, 'by singBonus at most');
  assert.ok(best.rank > sung.rank, 'but a clearly better note still wins');
});

test('cutClip plays back the cleaned slice, and can be told not to', () => {
  const mk = () => tone(tone(clip(3, 0.02), 1.0, 0.16, 4000, 0.3), 1.3, 0.2, 3300, 0.3);
  const a = mk(), r = S.analyzeClip(a, SR);
  S.cutClip(a, SR, r);
  assert.equal(r.nr, undefined, 'the scratch map is gone once the notes are cut');
  const b = mk(), raw = S.analyzeClip(b, SR);
  S.cutClip(b, SR, raw, { clean: false });
  const n = r.notes[0], m = raw.notes[0];
  assert.ok(n.z1 > n.t1, 'the second syllable is followed');
  assert.equal(n.pcm.length, m.pcm.length);
  // The gap between the two syllables holds only hiss: quieter in the cleaned cut.
  const gap = (x) => { let e = 0; const i0 = Math.round((1.2 - x.t0) * SR), i1 = Math.round((1.27 - x.t0) * SR); for (let i = i0; i < i1; i++) e += x.pcm[i] * x.pcm[i]; return Math.sqrt(e / (i1 - i0)); };
  assert.ok(gap(n) < 0.4 * gap(m), `hiss between syllables is turned down (${gap(n).toFixed(1)} vs ${gap(m).toFixed(1)})`);
  near(n.rms / m.rms, 1, 0.08, 'the note itself is as loud as before');
});

test('a call is not followed into a rustle or a slam', () => {
  // The note, then 250 ms later a loud burst of plain noise where a second
  // syllable might have been.
  const a = clip(4);
  tone(a, 1.0, 0.18, 3500);
  burst(a, 1.3, 0.5, 0.12);
  const n = S.analyzeClip(a, SR).notes.find((x) => Math.abs(x.hz - 3500) < 60);
  assert.ok(n, 'the note is found');
  assert.ok(n.z1 < 1.36, `the slice stops before the noise takes over (z1 ${n.z1})`);
});

test('what sings on is judged the way the key is played: above its rumble cut', () => {
  // A kinglet's thin note, then a dove cooing on underneath. Playback filters
  // the dove out of that key, so the slice must not be stretched over it.
  const a = clip(4);
  tone(a, 1.0, 0.16, 7000);
  for (let k = 0; k < 4; k++) tone(a, 1.3 + k * 0.2, 0.15, 500, 0.3);
  const hi = S.analyzeClip(a, SR).notes.find((x) => Math.abs(x.hz - 7000) < 100);
  assert.ok(hi, 'the high note is found');
  assert.equal(hi.z1, hi.t1, 'a coo far below the note is not the bird singing on');
  // The other way round, the low note IS followed by higher syllables.
  const b = clip(4);
  tone(b, 1.0, 0.16, 1200);
  for (let k = 0; k < 3; k++) tone(b, 1.3 + k * 0.2, 0.15, 3000, 0.3);
  const lo = S.analyzeClip(b, SR).notes.find((x) => Math.abs(x.hz - 1200) < 40);
  assert.ok(lo && lo.z1 > 1.8, `higher syllables after a low note are followed (z1 ${lo && lo.z1})`);
});

test('a note is levelled by what will be heard of it, not by a hum underneath', () => {
  const mk = (hum) => {
    const a = tone(clip(3), 1.0, 0.3, 6000, 0.1);
    if (hum) for (let i = 0; i < a.length; i++) a[i] += hum * Math.sin(2 * Math.PI * 300 * i / SR);
    const r = S.analyzeClip(a, SR);
    S.cutClip(a, SR, r);
    return r.notes.find((x) => Math.abs(x.hz - 6000) < 80);
  };
  // How strong the 6 kHz tone itself is in the stored samples, as an RMS.
  const toneRms = (n) => {
    const i0 = Math.round((n.s0 - n.t0) * SR), i1 = Math.round((n.s1 - n.t0) * SR);
    let c = 0, q = 0;
    for (let i = i0; i < i1; i++) { const v = n.pcm[i] / 32767, w = 2 * Math.PI * n.hz * i / SR; c += v * Math.cos(w); q += v * Math.sin(w); }
    return Math.hypot(c, q) * 2 / (i1 - i0) / Math.SQRT2;
  };
  const plain = mk(0), hummed = mk(0.3);
  assert.ok(plain && hummed, 'found with and without the hum');
  near(plain.rms / toneRms(plain), 1, 0.08, 'a clean note: rms is the tone');
  near(hummed.rms / toneRms(hummed), 1, 0.08, 'a hum three times the note does not count towards its loudness');
});

test('answers analysis jobs when loaded as a Web Worker', () => {
  const posted = [];
  function WorkerGlobalScope() {}
  const self = new WorkerGlobalScope();
  self.postMessage = (msg, transfer) => posted.push({ msg, transfer });
  const ctx = vm.createContext({ self, WorkerGlobalScope, Math, Float32Array, Float64Array, Int16Array, Uint32Array, Uint8Array, Array, Object, String, Number, Infinity, Error });
  vm.runInContext(readFileSync(CORE, 'utf8'), ctx);
  assert.equal(typeof self.onmessage, 'function');
  assert.equal(typeof self.AvianSampler.analyzeClip, 'function');
  self.onmessage({ data: { cmd: 'analyze', id: 42, pcm: tone(clip(2), 0.6, 0.3, 3000), sr: SR, opts: { cut: true, phrase: true } } });
  assert.equal(posted.length, 1);
  assert.equal(posted[0].msg.id, 42);
  assert.equal(posted[0].msg.result.notes.length, 1);
  assert.ok(posted[0].msg.result.notes[0].pcm.length > 0);
  assert.equal(posted[0].transfer.length, 2);
  self.onmessage({ data: { cmd: 'analyze', id: 43, pcm: null, sr: SR } });   // a bad job must still answer
  assert.equal(posted[1].msg.id, 43);
  assert.ok(posted[1].msg.result.error);
});

// ----------------------------------------------------------------- bank ----
const N = (sci, clip, midi, q = 0.8) => ({ sci, clip, midi, q });

test('rankNotes: key, cents, and trust from the bird\'s other recordings', () => {
  const notes = S.rankNotes([
    N('Wren', 'a', 84.10), N('Wren', 'b', 84.30), N('Wren', 'c', 91.00),   // 91 is heard in one clip only
    N('Dove', 'x', 70.49)
  ]);
  assert.equal(notes[0].key, 84);
  near(notes[0].cents, 10, 0.01, 'cents');
  assert.equal(notes[0].sup, 1);
  assert.equal(notes[2].sup, 0);
  assert.ok(notes[0].rank > notes[2].rank * 1.2, 'a supported note outranks a lone one of equal quality');
  near(notes[3].cents, 49, 0.01, 'never more than 50 cents from its key');
  assert.ok(notes.every((n) => Math.abs(n.cents) <= 50));
  assert.ok(notes[3].rank < notes[3].q, 'far from its key costs rank');
});

test('buildKeys spreads the keyboard across species', () => {
  const notes = [];
  // A chickadee that could take every key (and, heard in five recordings, ranks
  // best on each), and five others nearly as good at one key each.
  for (let k = 80; k <= 84; k++) notes.push(N('Chickadee', 'c' + k, k, 0.9));
  ['Wren', 'Robin', 'Dove', 'Finch', 'Jay'].forEach((s, i) => notes.push(N(s, s, 80 + i, 0.95)));
  const B = S.buildKeys(S.rankNotes(notes));
  assert.deepEqual(B.list, [80, 81, 82, 83, 84]);
  assert.equal(B.lo, 80); assert.equal(B.hi, 84);
  const singers = B.list.map((k) => B.keys[k][B.pick[k]].sci);
  assert.ok(new Set(singers).size >= 4, `diverse singers: ${singers}`);
  for (let i = 1; i < singers.length; i++) assert.notEqual(singers[i], singers[i - 1], 'neighbouring keys differ');
  assert.equal(B.keys[80][0].sci, 'Chickadee', 'singers are still listed best-first');
  assert.equal(B.keys[80].length, 2);
});

test('buildKeys: variety never costs quality', () => {
  // The chickadee is far better on every key: a poor note from another bird
  // must not take a key just to be different.
  const notes = [];
  for (let k = 80; k <= 83; k++) { notes.push(N('Chickadee', 'c' + k, k, 0.9)); notes.push(N('Crow', 'x' + k, k, 0.4)); }
  const B = S.buildKeys(S.rankNotes(notes));
  assert.deepEqual(B.list.map((k) => B.keys[k][B.pick[k]].sci), ['Chickadee', 'Chickadee', 'Chickadee', 'Chickadee']);
  assert.ok(B.keys[80].some((n) => n.sci === 'Crow'), 'the crow is still on the key, for "take turns" and the picker');
});

test('singTurns: a repeated note goes round the birds that sing it well', () => {
  const n = (sci, rank, odd) => ({ sci, rank, odd: !!odd });
  const board = {
    keys: {
      76: [n('Cardinal', 1), n('Titmouse', 0.95), n('Robin', 0.9), n('Crow', 0.5), n('Dove', 0.98, true)],
      77: [n('Kinglet', 0.9)],
      79: [n('Sparrow', 0.9), n('Robin', 0.85)]
    },
    pick: { 76: 1, 77: 0, 79: 0 }
  };
  const tune = [76, 76, 77, 79, 79, 77, 76, null, 76, 76].map((key) => ({ key }));
  const who = S.singTurns(tune, board).map((i, j) => (i == null ? null : board.keys[tune[j].key][i].sci));
  assert.equal(who[0], 'Titmouse', 'the first time, the bird shown on the key');
  assert.equal(who[7], null, 'a rest stays a rest');
  const e = who.filter((s, j) => tune[j].key === 76);
  assert.deepEqual([...new Set(e)].sort(), ['Cardinal', 'Robin', 'Titmouse'], 'every good singer gets a turn');
  assert.ok(!who.includes('Crow'), 'a much weaker note never takes a turn');
  assert.ok(!who.includes('Dove'), 'a doubted note never takes a turn');
  assert.ok(who.filter((s, j) => tune[j].key === 77).every((s) => s === 'Kinglet'), 'a note one bird sings stays with it');
  assert.deepEqual(who.slice(3, 5), ['Sparrow', 'Robin']);
  for (let j = 1; j < who.length; j++) {
    if (who[j] && tune[j].key === tune[j - 1].key) assert.notEqual(who[j], who[j - 1], 'a note sung twice in a row changes bird');
  }
});

test('buildKeys solo: one bird, several takes per key', () => {
  const notes = [];
  for (let i = 0; i < 9; i++) notes.push(N('Wren', 'w' + i, 84 + (i % 2) * 0.1, 0.5 + i * 0.05));
  notes.push(N('Robin', 'r', 84, 0.99));
  const B = S.buildKeys(S.rankNotes(notes), { sci: 'Wren' });
  assert.deepEqual(B.list, [84]);
  assert.equal(B.keys[84].length, 6);
  assert.ok(B.keys[84].every((n) => n.sci === 'Wren'));
  assert.ok(B.keys[84][0].rank >= B.keys[84][5].rank);
  assert.deepEqual(S.buildKeys([], {}).list, []);
});

test('speciesRanges ranks birds by how many different notes they sing, and how well', () => {
  const R = S.speciesRanges(S.rankNotes([N('Wren', 'a', 80), N('Wren', 'a', 85), N('Wren', 'b', 92), N('Dove', 'x', 70), N('Dove', 'y', 70.2)]));
  assert.equal(R[0].sci, 'Wren');
  assert.deepEqual([R[0].count, R[0].lo, R[0].hi, R[0].span], [3, 80, 92, 12]);
  assert.deepEqual([R[1].sci, R[1].count, R[1].notes], ['Dove', 1, 2]);
  // Four rough notes do not outrank three clean ones.
  const Q = S.speciesRanges(S.rankNotes([
    N('Kinglet', 'a', 100, 0.9), N('Kinglet', 'a', 102, 0.9), N('Kinglet', 'b', 104, 0.9),
    N('Woodpecker', 'x', 90, 0.3), N('Woodpecker', 'x', 92, 0.3), N('Woodpecker', 'y', 94, 0.3), N('Woodpecker', 'y', 96, 0.3),
  ]));
  assert.deepEqual(Q.map((r) => r.sci), ['Kinglet', 'Woodpecker']);
  assert.equal(Q[1].count, 4);
});

// --------------------------------------------------------------- melody ----
test('a one-off note far outside a bird\'s usual range is doubted (the neighbour in the background)', () => {
  // A phoebe heard in three recordings sings around 100-103. One recording
  // also has a low coo at 75: almost certainly the dove behind it.
  const notes = S.rankNotes([
    N('Phoebe', 'a', 100), N('Phoebe', 'b', 100.3), N('Phoebe', 'b', 103), N('Phoebe', 'c', 103.2),
    N('Phoebe', 'c', 75, 0.9),            // the coo: one clip only, two octaves below everything else
    N('Phoebe', 'a', 108, 0.9),           // one clip only, but within an octave of its range: not doubted
    N('Crow', 'x', 75, 0.5),
  ]);
  const coo = notes[4], high = notes[5];
  assert.equal(coo.odd, true);
  assert.equal(high.odd, false);
  assert.ok(Math.abs(coo.rank - 0.9 * 0.5) < 1e-9, 'an odd note keeps half its rank');
  // Flock: still playable (it is a real sound from the yard), but a surer bird wins the key.
  const B = S.buildKeys(notes);
  assert.equal(B.keys[75][B.pick[75]].sci, 'Crow');
  assert.ok(B.keys[75].some((n) => n.sci === 'Phoebe'));
  // Solo and the range ranking are that bird and nothing else.
  assert.deepEqual(S.buildKeys(notes, { sci: 'Phoebe' }).list, [100, 103, 108]);
  assert.deepEqual(S.speciesRanges(notes).find((r) => r.sci === 'Phoebe').keys, [100, 103, 108]);
  // Too little to go on (fewer than three recordings): nothing is doubted.
  const few = S.rankNotes([N('Owl', 'a', 60), N('Owl', 'b', 60.1), N('Owl', 'b', 90)]);
  assert.ok(few.every((n) => !n.odd));
});

test('fitMelody keeps a tune where it can be heard as one', () => {
  assert.equal(S.melodic(84), 1);
  assert.equal(S.melodic(108), 1);
  assert.ok(S.melodic(112) < 0.7 && S.melodic(120) <= 0.3 && S.melodic(120) > 0);
  assert.ok(S.melodic(45) < 1 && S.melodic(45) >= 0.6);
  // Every key from C6 to C9 exists, and the high ones are the "better" notes.
  // The tune must still land at or below C8, not up where the quality is.
  const has = (k) => (k >= 84 && k <= 120 ? (k > 108 ? 0.8 : 0.6) : 0);
  const mel = S.parseMelody('C4 D E F G A B C5').notes;
  const fit = S.fitMelody(mel, has, { lo: 84, hi: 120 });
  assert.equal(fit.exact, 8);
  assert.ok(fit.notes.every((n) => n.key <= 108), 'placed at ' + fit.notes.map((n) => n.key).join(' '));
  // Worth giving up a little exactness for: the birds have every note up high,
  // but below C8 one note of the tune is missing and has to borrow an octave.
  const gap = (k) => (k >= 110 && k <= 122 ? 1 : (k >= 84 && k <= 96 && k !== 88 ? 0.6 : 0));
  const low = S.fitMelody(mel, gap, { lo: 84, hi: 122 });
  assert.ok(low.notes.filter((n) => n.key != null && n.key <= 108).length >= 7, 'placed at ' + low.notes.map((n) => n.key).join(' '));
  // With nothing below C8 at all, the tune still plays up there.
  const onlyHigh = S.fitMelody(mel, (k) => (k >= 109 && k <= 121 ? 1 : 0), { lo: 109, hi: 121 });
  assert.equal(onlyHigh.exact, 8);
});

test('parseMelody: octaves stick, lengths, rests, bars, mistakes', () => {
  const m = S.parseMelody('C4 D:0.5 e:0.5 | F#:2 r G3 | Bb A♭5:1.5 r:0.5 xyz H2');
  assert.deepEqual(m.notes.map((n) => n.m), [60, 62, 64, 66, 55, 58, 80]);
  assert.deepEqual(m.notes.map((n) => n.t), [0, 1, 1.5, 2, 5, 6, 7]);
  assert.deepEqual(m.notes.map((n) => n.d), [1, 0.5, 0.5, 2, 1, 1, 1.5]);
  assert.deepEqual(m.bars, [2, 4, 3]);
  assert.equal(m.beats, 9);
  assert.deepEqual(m.errors, ['xyz', 'H2']);
  assert.deepEqual(S.parseMelody('').notes, []);
  assert.deepEqual(S.parseMelody('C:0 C:999').errors, ['C:0', 'C:999']);
  assert.equal(S.parseMelody('C-1').notes[0].m, 0);
  assert.equal(S.parseMelody('c4,d4, e4').notes.length, 3, 'commas are fine too');
});

test('fitMelody slides a tune to where the birds have its notes', () => {
  const have = new Set([84, 86, 88, 89, 91, 93]);             // C7 D E F G A
  const has = (k) => (have.has(k) ? 1 : 0);
  const mel = S.parseMelody('C4 C G G A A G:2').notes;
  const fit = S.fitMelody(mel, has, { lo: 84, hi: 93 });
  assert.equal(fit.shift, 24);
  assert.deepEqual(fit.notes.map((n) => n.key), [84, 84, 91, 91, 93, 93, 91]);
  assert.ok(fit.notes.every((n) => n.how === 'exact'));
  assert.deepEqual([fit.exact, fit.total, fit.pct], [7, 7, 100]);
});

test('fitMelody: a missing note borrows an octave, then a neighbour, else rests', () => {
  const have = new Set([72, 74, 76, 79, 84, 89]);
  const has = (k) => (have.has(k) ? 1 : 0);
  // C D E F G with F missing at 77 but present an octave up (89).
  const mel = [72, 74, 76, 77, 79].map((m, i) => ({ m, t: i, d: 1 }));
  const fit = S.fitMelody(mel, has, { lo: 72, hi: 89 });
  assert.equal(fit.shift, 0);
  assert.deepEqual(fit.notes.map((n) => n.how), ['exact', 'exact', 'exact', 'octave', 'exact']);
  assert.equal(fit.notes[3].key, 89);
  assert.equal(fit.pct, 80);
  const strict = S.fitMelody(mel, has, { lo: 72, hi: 89, fill: false });
  assert.equal(strict.notes[3].how, 'rest');
  assert.equal(strict.notes[3].key, null);
  assert.equal(strict.rest, 1);
  // No octave anywhere: the nearest real key within two semitones.
  const has2 = (k) => (k === 60 || k === 62 || k === 66 ? 1 : 0);
  const fit2 = S.fitMelody([60, 62, 64].map((m, i) => ({ m, t: i, d: 1 })), has2, { lo: 60, hi: 66 });
  assert.deepEqual(fit2.notes.map((n) => n.how), ['exact', 'exact', 'near']);
  assert.ok([62, 66].includes(fit2.notes[2].key));
});

test('fitMelody with no birds at all rests every note; an empty tune is fine', () => {
  const none = S.fitMelody([{ m: 60, t: 0, d: 1 }], () => 0, { lo: null, hi: null });
  assert.deepEqual([none.rest, none.pct, none.notes[0].how], [1, 0, 'rest']);
  assert.equal(S.fitMelody([], () => 1, { lo: 60, hi: 72 }).total, 0);
});

test('rollCall walks every key the birds have', () => {
  assert.deepEqual(S.rollCall([70, 75, 90]).map((n) => [n.m, n.t, n.d]), [[70, 0, 0.5], [75, 0.5, 0.5], [90, 1, 0.5]]);
});

test('a pinned fit leaves the roll call on its own keys', () => {
  // The real yard's board on the day this went live (2026-11-22): A3, A♭4, then
  // B4 to D9 with one gap. Left free, the fitter slid the roll call down nine
  // semitones to where a melody is easier to hear, borrowing ten notes from an
  // octave away. Right for a song, wrong for "every note, low to high".
  const keys = [57, 68];
  for (let k = 71; k <= 122; k++) if (k !== 79) keys.push(k);
  const has = (k) => (keys.includes(k) ? 0.8 : 0);
  const roll = S.rollCall(keys);
  const free = S.fitMelody(roll, has, { lo: 57, hi: 122 });
  assert.notEqual(free.shift, 0, 'this board is the case that slid the roll call');
  assert.ok(free.exact < keys.length);
  const pinned = S.fitMelody(roll, has, { lo: 57, hi: 122, shift: 0 });
  assert.equal(pinned.shift, 0);
  assert.equal(pinned.exact, keys.length);
  assert.deepEqual(pinned.notes.map((n) => n.key), keys);
});

// ------------------------------------------------------------- songbook ----
test('songbook: every tune parses, and every bar adds up', () => {
  assert.ok(BOOK.length >= 20);
  const ids = new Set();
  for (const tune of BOOK) {
    assert.ok(tune.id && tune.title && tune.by && tune.bpm > 30 && tune.bpm < 260, `${tune.id}: fields`);
    assert.ok(!ids.has(tune.id), `${tune.id}: duplicate id`); ids.add(tune.id);
    const m = S.parseMelody(tune.notes);
    assert.deepEqual(m.errors, [], `${tune.id}: unreadable tokens`);
    assert.ok(m.notes.length >= 5, `${tune.id}: has notes`);
    assert.ok(m.notes.every((n) => n.m >= 36 && n.m <= 96), `${tune.id}: a note landed in a strange octave`);
    // A forgotten octave number shows up as a wild leap or an absurd range.
    for (let i = 1; i < m.notes.length; i++) {
      assert.ok(Math.abs(m.notes[i].m - m.notes[i - 1].m) <= 15, `${tune.id}: a leap of more than a tenth at note ${i} (sticky-octave slip?)`);
    }
    const ms = m.notes.map((n) => n.m);
    assert.ok(Math.max(...ms) - Math.min(...ms) <= 24, `${tune.id}: spans more than two octaves`);
    if (!tune.meter) continue;
    m.bars.forEach((len, i) => {
      const first = i === 0, last = i === m.bars.length - 1;
      if (first && tune.pickup) return near(len, tune.pickup, 1e-9, `${tune.id}: pickup`);
      if (last) return assert.ok(len > 0 && len <= tune.meter + 1e-9, `${tune.id}: last bar is ${len} beats`);
      near(len, tune.meter, 1e-9, `${tune.id}: bar ${i + 1}`);
    });
  }
});

// ----------------------------------------------------------------- MIDI ----
// Build a tiny two-track Standard MIDI File by hand.
function vlq(n) { const out = [n & 0x7f]; while ((n >>= 7)) out.unshift((n & 0x7f) | 0x80); return out; }
function chunk(tag, bytes) {
  const len = bytes.length;
  return [...tag].map((c) => c.charCodeAt(0)).concat([len >>> 24 & 255, len >>> 16 & 255, len >>> 8 & 255, len & 255], bytes);
}
function smf(ppq, tracks) {
  return new Uint8Array(chunk('MThd', [0, 1, 0, tracks.length, ppq >> 8, ppq & 255]).concat(...tracks.map((t) => chunk('MTrk', t)))).buffer;
}
const END = [0, 0xff, 0x2f, 0];

test('parseMidi reads notes, tempo, names, running status; skips drums', () => {
  const tempo = [0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, ...END];                      // 500000 µs = 120 bpm
  const lead = [
    0, 0xff, 0x03, 4, 0x4c, 0x65, 0x61, 0x64,                                      // name "Lead"
    0, 0x90, 60, 100, ...vlq(480), 0x80, 60, 0,                                    // C4, one beat
    0, 0x90, 64, 100, ...vlq(240), 64, 0,                                          // E4, half a beat, off by running status vel 0
    0, 67, 90, ...vlq(960), 67, 0,                                                 // G4 two beats (running status)
    0, 0x99, 36, 100, ...vlq(120), 0x89, 36, 0,                                    // a drum hit: ignored
    ...END
  ];
  const bass = [0, 0x91, 36, 80, 0, 0x91, 48, 80, ...vlq(1920), 0x81, 36, 0, 0, 0x81, 48, 0, ...END];
  const P = S.parseMidi(smf(480, [tempo, lead, bass]));
  assert.equal(P.bpm, 120);
  assert.equal(P.ppq, 480);
  assert.equal(P.parts.length, 2);
  assert.equal(P.parts[0].name, 'Lead');
  assert.deepEqual(P.parts[0].notes.map((n) => [n.m, n.t, n.d]), [[60, 0, 1], [64, 1, 0.5], [67, 1.5, 2]]);
  assert.equal(P.parts[1].notes.length, 2);
  assert.equal(S.midiTunePart({ parts: [{ notes: new Array(4).fill({ m: 40 }), mean: 40 }, { notes: new Array(12).fill({ m: 72 }), mean: 72 }] }), 1);
  // The tune line of everything: the highest note at each moment, trimmed so it never overlaps.
  const top = S.midiMelody(P, -1, 'top');
  assert.deepEqual(top.notes.map((n) => n.m), [60, 64, 67]);
  const all = S.midiMelody(P, -1, 'all');
  assert.equal(all.notes.length, 5);
  assert.equal(S.midiMelody(P, 1, 'top').notes.length, 1, 'a chord in one part → its top note');
  assert.equal(S.midiMelody(P, 0, 'all', 2).notes.length, 2, 'capped');
});

test('parseMidi rejects what it cannot read', () => {
  assert.throws(() => S.parseMidi(new Uint8Array([1, 2, 3]).buffer), /not a MIDI file/);
  assert.throws(() => S.parseMidi(new TextEncoder().encode('RIFF....WAVEfmt ').buffer), /not a MIDI file/);
  const smpte = new Uint8Array(chunk('MThd', [0, 1, 0, 0, 0xe7, 0x28])).buffer;
  assert.throws(() => S.parseMidi(smpte), /SMPTE/);
  // A truncated file must not hang or throw past the end.
  const cut = smf(480, [[0, 0x90, 60, 100, ...vlq(480)]]);
  assert.deepEqual(S.parseMidi(cut).parts, []);
});

test('pitch helpers', () => {
  assert.equal(S.noteName(60), 'C4');
  assert.equal(S.noteName(69), 'A4');
  assert.equal(S.noteName(70), 'B♭4');
  assert.equal(S.noteName(108), 'C8');
  assert.equal(S.noteName(84.4), 'C6');
  near(S.midiToHz(69), 440, 1e-9, 'A4');
  near(S.hzToMidi(880), 81, 1e-9, 'A5');
  assert.equal(S.keyOf(83.5), 84);
});

// A made-up day: a busy dawn (robin, cardinal), a quiet middle (one titmouse),
// an evening (cardinal, wren), a 3 am owl, and a junco with no notes at all.
function fakeDay() {
  const sp = (sci, slots) => ({ sci, com: sci, n: slots.reduce((a, s) => a + s[1], 0), slots });
  const range = (a, b, n, step = 1) => { const o = []; for (let s = a; s <= b; s += step) o.push([s, n]); return o; };
  return { date: '2026-05-10', start: 0, interval: 5, bins: 288, species: [
    sp('robin', range(66, 100, 6)), sp('cardinal', range(70, 110, 3).concat(range(200, 230, 4))),
    sp('titmouse', range(130, 180, 1, 10)), sp('wren', range(205, 235, 3)),
    sp('owl', [[36, 2]]), sp('junco', range(70, 90, 5)),
  ] };
}
function fakeBoard() {
  const notes = [];
  const add = (sci, keys) => keys.forEach((k) => notes.push({ sci, key: k, rank: 1, odd: false }));
  add('robin', [72, 74, 76, 79, 81, 75]);
  add('cardinal', [67, 69, 72, 76, 84, 70]);
  add('titmouse', [74, 79, 86]);
  add('wren', [76, 81, 83, 88]);
  add('owl', [52]);
  const keys = {};
  notes.forEach((n) => (keys[n.key] = keys[n.key] || []).push(n));
  return { keys };
}

test('daySong: the day squeezed onto a beat, in one key, sung by that day\'s birds', () => {
  const day = fakeDay(), board = fakeBoard();
  const a = S.daySong(day, board), b = S.daySong(day, board);
  assert.deepEqual(a, b, 'the same day gives the same tune');
  assert.ok(a.notes.length > 20, 'a real tune: ' + a.notes.length);
  assert.ok(a.beats >= 72 && a.beats <= 74, 'about 72 beats: ' + a.beats);
  // The 3 am owl is trimmed; the day starts when the yard woke.
  assert.equal(a.from, 66);
  assert.ok(!a.singers.includes('owl'));
  assert.ok(!a.singers.includes('junco'), 'a bird with no notes sits it out');
  // One key: every note is in the chosen major pentatonic, on a real key of its bird.
  const P = [0, 2, 4, 7, 9];
  for (const n of a.notes) {
    assert.ok(P.includes(((n.m - a.tonic) % 12 + 12) % 12), 'in key: ' + n.m);
    assert.equal(board.keys[n.key][n.idx].sci, n.sci, 'the note is that bird\'s');
    assert.equal(n.t * 2, Math.round(n.t * 2), 'on the eighth-note grid');
    assert.ok(n.d >= 0.5 && n.d <= 2);
  }
  for (let i = 1; i < a.notes.length; i++) assert.ok(a.notes[i].t >= a.notes[i - 1].t + a.notes[i - 1].d - 1e-9, 'no overlaps');
  // Three sections, the lull in the middle, and the lull is the quiet part.
  assert.deepEqual(a.sections.map((s) => s.name), ['dawn', 'midday lull', 'evening']);
  const inSec = (s) => a.notes.filter((n) => n.t >= s.t && n.t < s.end).length / (s.end - s.t);
  assert.ok(inSec(a.sections[1]) < inSec(a.sections[0]) && inSec(a.sections[1]) < inSec(a.sections[2]), 'the lull rests');
  // Birds sing when they called: dawn is robin and cardinal, the lull is the titmouse.
  const who = (s) => new Set(a.notes.filter((n) => n.t >= s.t && n.t < s.end).map((n) => n.sci));
  assert.ok(who(a.sections[0]).has('robin') && who(a.sections[0]).has('cardinal'));
  assert.ok(!who(a.sections[0]).has('wren'), 'the wren only called in the evening');
  assert.deepEqual([...who(a.sections[1])], ['titmouse']);
  assert.ok(who(a.sections[2]).has('wren'));
});

test('daySong: an empty or note-less day gives no tune', () => {
  assert.equal(S.daySong({ species: [] }, fakeBoard()).notes.length, 0);
  const d = { interval: 5, species: [{ sci: 'junco', n: 3, slots: [[80, 3]] }] };
  const r = S.daySong(d, fakeBoard());
  assert.equal(r.notes.length, 0);
  assert.equal(r.calls, 3);
});
