// sampler-core.js — the note-finding engine behind the "play" view.
//
// The play view turns the box's OWN field recordings into an instrument: every
// key on its keyboard is a real note that a real bird sang into the microphone
// in Sudbury. This file is the part that listens to one recording and answers
// "which notes are in here, where do they start and stop, and exactly what pitch
// is each one?" — plus the small amount of music logic that sits on top (which
// bird sings which key, how a tune is laid onto the notes the birds really have,
// reading a typed tune or a MIDI file).
//
// It is pure computation with no DOM and no Web Audio, so the same file runs in
// three places:
//   - a Web Worker (instrument.js starts one from this very file, so analysing a
//     few hundred clips never stalls the page),
//   - the page itself (window.AvianSampler: the music logic, and the analysis as
//     a fallback where a Worker can't be started),
//   - Node (module.exports), for avian/tests/sampler-core.test.mjs.
//
// TRUE SOUNDS ONLY. Nothing here synthesises, stretches or re-pitches audio. The
// analysis MEASURES, and the one thing it changes is the background: when a note
// is cut out, whatever is not the call (steady hiss, hum, rumble) is turned down
// by CFG.cleanDb — turned down, never removed, and nothing is added. Playback
// (instrument.js) plays those samples with at most a ±50 cent nudge so a note
// lands on its key.
//
// This is deliberately NOT spectral-core.js. That file is the song-signature
// analysis (240 coarse columns, one ridge, the 1.8–8.5 kHz songbird band) and
// its output is a drawing. Cutting playable notes needs millisecond bounds,
// several simultaneous voices, and the low birds too (doves, owls, geese), so
// this is a separate, finer analysis. See CLAUDE.md → "The play view".
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;   // Node (tests)
  else if (root) root.AvianSampler = api;                                       // page or worker
  // Loaded AS a Web Worker: answer analysis jobs from instrument.js.
  if (typeof WorkerGlobalScope !== 'undefined' && root instanceof WorkerGlobalScope) {
    root.onmessage = function (ev) {
      var m = ev.data || {};
      if (m.cmd !== 'analyze') return;
      var res, transfer = [];
      try {
        res = api.analyzeClip(m.pcm, m.sr, m.opts);
        if (m.opts && m.opts.cut) transfer = api.cutClip(m.pcm, m.sr, res, m.opts);
        delete res.nr;
      } catch (e) { res = { error: String((e && e.message) || e), notes: [], phrase: null }; transfer = []; }
      root.postMessage({ id: m.id, result: res }, transfer);
    };
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Bump when the analysis changes in a way that alters its output: instrument.js
  // keys its IndexedDB cache of per-clip results on this.
  var VERSION = 2;

  // ---------------------------------------------------------------- FFT ----
  // In-place radix-2 FFT with cached bit-reversal + twiddle tables (a few
  // hundred clips × ~750 frames each makes the table reuse worth having).
  var _plans = {};
  function fftPlan(n) {
    if (_plans[n]) return _plans[n];
    var bits = Math.round(Math.log(n) / Math.LN2);
    var rev = new Uint32Array(n), i, b;
    for (i = 0; i < n; i++) {
      var r = 0;
      for (b = 0; b < bits; b++) if (i & (1 << b)) r |= 1 << (bits - 1 - b);
      rev[i] = r;
    }
    var cos = new Float64Array(n >> 1), sin = new Float64Array(n >> 1);
    for (i = 0; i < (n >> 1); i++) {
      cos[i] = Math.cos(2 * Math.PI * i / n);
      sin[i] = -Math.sin(2 * Math.PI * i / n);
    }
    return (_plans[n] = { rev: rev, cos: cos, sin: sin });
  }
  function fft(re, im) {
    var n = re.length, plan = fftPlan(n), rev = plan.rev, cos = plan.cos, sin = plan.sin;
    var i, j, t;
    for (i = 0; i < n; i++) {
      j = rev[i];
      if (j > i) { t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
    }
    for (var size = 2; size <= n; size <<= 1) {
      var half = size >> 1, step = n / size;
      for (var s = 0; s < n; s += size) {
        for (var k = 0, w = 0; k < half; k++, w += step) {
          var wr = cos[w], wi = sin[w], a = s + k, b = a + half;
          var xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - xr; im[b] = im[a] - xi;
          re[a] += xr; im[a] += xi;
        }
      }
    }
  }

  // ------------------------------------------------------------- pitch ----
  function hzToMidi(hz) { return 69 + 12 * Math.log(hz / 440) / Math.LN2; }
  function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }
  function centsBetween(a, b) { return 1200 * Math.log(a / b) / Math.LN2; }
  var NOTE_NAMES = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'];
  // 60 -> "C4". Scientific pitch notation; songbirds mostly live in octaves 6–8.
  function noteName(midi) {
    var m = Math.round(midi);
    return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
  }
  function clamp01(x) { return x < 0 ? 0 : (x > 1 ? 1 : x); }

  // ---------------------------------------------------------- analysis ----
  // Tunables. Times are in ms so they hold whatever the clip's sample rate.
  var CFG = {
    fLo: 250, fHi: 11000,       // analysed band: dove/owl coos up to kinglet-thin
    floorPct: 0.30,             // per-bin noise floor = this percentile over time...
    floorGain: 2.8,             // ...scaled to the MEAN of exponential noise (1/-ln(.7))
    peakSal: 8,                 // a spectral peak must stand this far (×) above the floor
    trackSalDb: 12,             // ...and a whole ridge must average this many dB above it
    maxPeaks: 6,                // strongest peaks kept per frame
    jumpCentsPerMs: 15,         // how fast a ridge may glide and still be one ridge
    minTrackMs: 40,
    relFloorDb: -42,            // ridges this far below the clip's loudest are dropped
    harmTol: 0.02,              // integer-ratio tolerance when stacking harmonics
    virtTol: 0.015,             // ratio tolerance for a missing-fundamental pair
    valley: 0.12,               // an energy dip below this × its neighbours splits notes
    steadyBand: 110,            // cents a note's pitch may wander and still be "one note"
    minSteadyMs: 48,
    preMs: 90, postMs: 320,     // most of the bird's own lead-in / tail kept around it
    singMs: 1500,               // how far past its note a call is followed ("sings on")...
    singGapMs: 300,             // ...until the bird pauses for longer than this
    liveOwn: 0.08, liveMax: 0.04,   // "still calling": ridges within this × the note's own level
                                //    (and never asking for more than liveMax × the clip's loudest)
    junkUp: 2,                  // ...or noise takes over: sound no ridge accounts for, this many ×
    junkOwn: 0.5,               //    the steady hiss, at least this × the note, and louder than
    junkMs: 50,                 //    the ridges — for this long (a rustle, rain, a door, a gust)
    cleanDb: 12,                // steady background around a call is turned down this far (0 = off)
    loudK: 12,                  // ...but a bin this many × above its own floor is left alone
    bgOk: -3, bgBad: 9,         // noise around a note, in dB next to the note: fine below bgOk,
    bgMax: 12,                  //    marked down towards bgBad, not used at all above bgMax
    singBonus: 0.2,             // a note the bird sings on from is preferred by up to this much
    perKey: 2,                  // takes of the same key kept per clip (a repeated call)
    bodyCents: 100,             // the call is "on the note" while within a semitone of it
    pickBand: 0.8,              // keys go to different birds only among near-equal notes
    oddSemis: 12,               // a one-off note this far outside a bird's usual range is doubted
    hpRatio: 0.45, hpMaxHz: 3500,   // playback cuts rumble below this × the note (see rumbleCut)
    leadBy: 2,                  // a note must be this many times stronger than any rival (3 dB)
    minPurity: 0.3,             // a note must own this share of the sound around it
    maxSd: 32,                  // ...hold its pitch this steadily (cents)...
    minRelDb: -30,              // ...and not be a faint bird far behind the main one
    minQ: 0.25,                 // notes scoring below this are not worth keeping
    maxNotes: 12,               // per clip
    phraseMs: 2600              // length of the "voice" excerpt for the soundboard
  };

  function median3(a, b, c) { return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c)); }
  function sortedMedian(arr, n) {
    // arr is scratch: sorts its first n entries in place.
    var v = arr.subarray(0, n); v.sort();
    return n ? v[n >> 1] : 0;
  }

  // Where playback's rumble filter sits for a note at `hz`: more than an octave
  // under it (so a call's own slide up from below survives), never above
  // hpMaxHz. One definition, shared by the analysis (purity) and the page.
  function rumbleCut(hz) {
    return Math.max(120, Math.min(CFG.hpMaxHz, hz * CFG.hpRatio));
  }

  // Listen to one clip. pcm: Float32Array (mono), sr: its sample rate.
  // Returns { sr, dur, notes: [...], phrase: {t0,t1,snr} | null }. Every time is
  // in seconds from the start of the clip. A note is:
  //   t0,t1   the bird's whole syllable around the note
  //   z1      where the bird's call ends after it (>= t1): the rest of the
  //           phrase, up to its next real pause. What gets cut out is t0..z1.
  //   b0,b1   the "body": the stretch of it that stays within a semitone of the note
  //   s0,s1   the steady part alone (what the pitch was measured on)
  //   hz,midi its pitch (midi is fractional: 93.31 = a slightly sharp A6)
  //   q       0..1 quality: how pure, steady, clear and long it is
  //   rms     loudness of the steady part (linear), for evening notes out
  //   purity  0..1: its share of everything sounding in its band while it holds
  //   tone    0..1: how whistle-like (1) or trilled / buzzy (0.5) it is
  //   sd (pitch wobble, cents), snr (dB), rel (dB below the clip's loudest),
  //   harm (partials stacked under it), div (>1: pitch is a missing fundamental)
  function analyzeClip(pcm, sr, opts) {
    var cfg = CFG, o = opts || {};
    var N = sr <= 36000 ? 1024 : 2048;     // ~32–46 ms window
    var H = N >> 2;                        // 75% overlap: 8–11 ms steps
    var len = pcm.length, dur = len / sr;
    var out = { sr: sr, dur: dur, notes: [], phrase: null, v: VERSION };
    if (len < N * 2) return out;

    var T = Math.floor((len - N) / H) + 1;
    var binHz = sr / N, hopMs = 1000 * H / sr;
    var bLo = Math.max(4, Math.floor(cfg.fLo / binHz));
    var bHi = Math.min((N >> 1) - 5, Math.ceil(Math.min(cfg.fHi, sr * 0.46) / binHz));
    if (bHi - bLo < 16) return out;
    var b0 = bLo - 3, nb = bHi + 3 - b0 + 1;        // stored bins: [b0, b0+nb)
    var lo = bLo - b0, hi = bHi - b0;               // band, in stored-bin indices
    var t, b, i, j, k;

    // --- 1. STFT → linear power (never a dB grid: see CLAUDE.md's DSP rule) ---
    var win = new Float32Array(N);
    for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var re = new Float32Array(N), im = new Float32Array(N);
    var P = new Float32Array(T * nb);
    var pmax = 0;
    for (t = 0; t < T; t++) {
      var off = t * H;
      for (i = 0; i < N; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      var row = t * nb;
      for (b = 0; b < nb; b++) {
        var bb = b + b0, pw = re[bb] * re[bb] + im[bb] * im[bb];
        P[row + b] = pw;
        if (pw > pmax) pmax = pw;
      }
    }
    if (!(pmax > 0)) return out;                    // digital silence
    var eps = pmax * 1e-10 + 1e-30;

    // --- 2. Noise floor ---
    // Per bin: a low percentile over time (the gaps between calls), scaled up to
    // the mean of the noise. A steady hum or an insect drone raises its own
    // bin's floor and so cancels itself. Per frame: if the whole band jumps at
    // once (a gust, a door, a truck) the floor rides up with it, so a broadband
    // thump can't pass as a set of notes.
    var floor = new Float32Array(nb), col = new Float32Array(T);
    var kth = Math.floor(cfg.floorPct * (T - 1));
    for (b = 0; b < nb; b++) {
      for (t = 0; t < T; t++) col[t] = P[t * nb + b];
      col.sort();
      floor[b] = col[kth] * cfg.floorGain;
    }
    var fl2 = new Float32Array(nb);
    for (b = 0; b < nb; b++) {
      fl2[b] = median3(floor[Math.max(0, b - 1)], floor[b], floor[Math.min(nb - 1, b + 1)]) + eps;
    }
    floor = fl2;
    var gain = new Float32Array(T), scratch = new Float32Array(((hi - lo) >> 1) + 2);
    var D = new Float32Array(T);                    // denoised in-band energy per frame
    for (t = 0; t < T; t++) {
      row = t * nb;
      var n = 0;
      for (b = lo; b <= hi; b += 2) scratch[n++] = P[row + b] / floor[b];
      var g = sortedMedian(scratch, n) / 0.6931;    // median of unit-mean noise = ln 2
      if (g < 1) g = 1;
      gain[t] = g;
      var e = 0;
      for (b = lo; b <= hi; b++) { var dv = P[row + b] - floor[b] * g; if (dv > 0) e += dv; }
      D[t] = e;
    }

    // --- 3. Spectral peaks per frame (refined by log-parabolic interpolation) ---
    var peaks = new Array(T);
    for (t = 0; t < T; t++) {
      row = t * nb; g = gain[t];
      var arr = [];
      for (b = lo; b <= hi; b++) {
        var pc = P[row + b];
        if (pc <= P[row + b - 1] || pc < P[row + b + 1] || pc <= P[row + b - 2] || pc < P[row + b + 2]) continue;
        var sal = pc / (floor[b] * g);
        if (sal < cfg.peakSal) continue;
        var l = Math.log(P[row + b - 1] + eps), c = Math.log(pc + eps), r = Math.log(P[row + b + 1] + eps);
        var den = l - 2 * c + r, d = den < 0 ? 0.5 * (l - r) / den : 0;
        if (d > 0.5) d = 0.5; else if (d < -0.5) d = -0.5;
        var le = 0;                                 // the partial's lobe, above the floor
        for (k = -2; k <= 2; k++) { dv = P[row + b + k] - floor[b + k] * g; if (dv > 0) le += dv; }
        arr.push({ f: (b + b0 + d) * binHz, p: pc, e: le, s: sal });
      }
      if (arr.length > cfg.maxPeaks) {
        arr.sort(function (x, y) { return y.p - x.p; });
        arr.length = cfg.maxPeaks;
      }
      peaks[t] = arr;
    }

    // --- 4. Link peaks across frames into ridges ("partials") ---
    // Strongest peaks choose first; a ridge may skip one frame (a dropout) and
    // may glide, but only so fast. Each ridge is one continuous sound: a whistle,
    // one harmonic of a nasal call, or one bird among several singing at once.
    var maxJump = cfg.jumpCentsPerMs * hopMs;
    var active = [], done = [], tr;
    for (t = 0; t < T; t++) {
      var pk = peaks[t];
      if (pk.length > 1) pk.sort(function (x, y) { return y.p - x.p; });
      for (i = 0; i < pk.length; i++) {
        var best = -1, bestD = Infinity;
        for (j = 0; j < active.length; j++) {
          tr = active[j];
          if (tr.last === t) continue;
          var dc = Math.abs(centsBetween(pk[i].f, tr.f[tr.f.length - 1]));
          if (dc <= maxJump * (t - tr.last) && dc < bestD) { bestD = dc; best = j; }
        }
        if (best >= 0) {
          tr = active[best];
          if (t - tr.last === 2) {                  // bridge a one-frame dropout
            var pf = tr.f[tr.f.length - 1], pe = tr.e[tr.e.length - 1];
            tr.f.push(Math.sqrt(pf * pk[i].f)); tr.e.push(Math.min(pe, pk[i].e) * 0.5); tr.n++;
            tr.ls += Math.log(cfg.peakSal);
          }
          tr.f.push(pk[i].f); tr.e.push(pk[i].e); tr.n++; tr.ls += Math.log(pk[i].s); tr.last = t;
        } else {
          active.push({ t0: t, last: t, f: [pk[i].f], e: [pk[i].e], n: 1, ls: Math.log(pk[i].s) });
        }
      }
      for (j = active.length - 1; j >= 0; j--) {
        if (t - active[j].last > 1) { done.push(active[j]); active.splice(j, 1); }
      }
    }
    done = done.concat(active);

    var minFrames = Math.max(3, Math.ceil(cfg.minTrackMs / hopMs));
    var tracks = [], loudest = 0;
    for (i = 0; i < done.length; i++) {
      tr = done[i];
      if (tr.n < minFrames) continue;
      tr.salDb = 10 * (tr.ls / tr.n) / Math.LN10;
      if (tr.salDb < cfg.trackSalDb) continue;
      tr.t1 = tr.t0 + tr.n - 1;
      var fs = tr.f.slice().sort(function (x, y) { return x - y; });
      tr.fMed = fs[fs.length >> 1];
      var es = 0; for (j = 0; j < tr.n; j++) es += tr.e[j];
      tr.eMean = es / tr.n;
      if (tr.eMean > loudest) loudest = tr.eMean;
      tr.parent = null; tr.div = 1;
      tracks.push(tr);
    }
    var relMin = loudest * Math.pow(10, cfg.relFloorDb / 10);
    tracks = tracks.filter(function (x) { return x.eMean >= relMin; });
    tracks.sort(function (x, y) { return x.fMed - y.fMed; });

    // What is "the call" and what is background, bin by bin: used when a note is
    // cut out (cutClip turns the background down), to tell a bird singing on
    // from a rustle, and to say how noisy a note is.
    //   ridge  a ridge runs through the bin: the tonal part of a call.
    //   pass   that, plus any bin standing far above its own usual level: a
    //          harsh caw, a click, a fast trill no ridge could follow. Measured
    //          against the bin's steady floor and nothing else, so only what is
    //          ALWAYS there (hiss, hum, rumble) counts as background. The first
    //          cut of this judged a frame against its own average instead, and
    //          on the real clips that turned a loud jay or cardinal into "noise".
    var ridge = new Uint8Array(T * nb), pass = new Uint8Array(T * nb), ridgeE = new Float32Array(T);
    for (i = 0; i < tracks.length; i++) {
      tr = tracks[i];
      for (j = -2; j < tr.n + 2; j++) {             // two frames early (the attack) and late
        t = tr.t0 + j;
        if (t < 0 || t >= T) continue;
        var tq = j < 0 ? 0 : (j >= tr.n ? tr.n - 1 : j);
        if (j >= 0 && j < tr.n) ridgeE[t] += tr.e[j];
        var cb = Math.round(tr.f[tq] / binHz) - b0;
        for (b = Math.max(0, cb - 3); b <= Math.min(nb - 1, cb + 3); b++) ridge[t * nb + b] = 1;
      }
    }
    // Per frame, the sound no ridge accounts for, over and above the steady
    // hiss: a rustle, rain, a door, a gust — or a bird with a rough voice.
    var floorSum = 0, restE = new Float32Array(T);
    for (b = lo; b <= hi; b++) floorSum += floor[b];
    for (t = 0; t < T; t++) {
      row = t * nb;
      var rs = 0;
      for (b = lo; b <= hi; b++) if (!ridge[row + b]) rs += P[row + b];
      restE[t] = rs > floorSum ? rs - floorSum : 0;
      for (b = 0; b < nb; b++) if (ridge[row + b]) pass[row + b] = 1;
      for (b = 1; b < nb - 1; b++) {
        if (P[row + b] >= floor[b] * cfg.loudK) { pass[row + b - 1] = 1; pass[row + b] = 1; pass[row + b + 1] = 1; }
      }
    }

    // --- 5. Stack harmonics ---
    // A ridge that shadows a lower one at 2×, 3×, 4×… is that sound's overtone,
    // not a note of its own. And two ridges locked at 3:2 or 4:3 with nothing
    // underneath are overtones of a fundamental too weak to see (a nuthatch's
    // nasal "yank", a goose): the pitch we hear is that missing fundamental.
    function overlapRatio(A, B) {                   // median f(B)/f(A) where both sound
      var a = Math.max(A.t0, B.t0), z = Math.min(A.t1, B.t1);
      if (z < a) return null;
      var rs = [];
      for (var q = a; q <= z; q++) rs.push(B.f[q - B.t0] / A.f[q - A.t0]);
      rs.sort(function (x, y) { return x - y; });
      return { n: rs.length, r: rs[rs.length >> 1] };
    }
    function rootOf(x) { while (x.parent) x = x.parent; return x; }
    for (j = 1; j < tracks.length; j++) {
      var B = tracks[j];
      for (i = 0; i < j; i++) {
        var A = tracks[i];
        var ov = overlapRatio(A, B);
        if (!ov || ov.n < 0.6 * B.n) continue;
        var kk = Math.round(ov.r);
        if (kk >= 2 && kk <= 8 && Math.abs(ov.r / kk - 1) <= cfg.harmTol) { B.parent = rootOf(A); break; }
      }
    }
    // A pair alone is not proof — two birds a fifth apart look the same — so the
    // missing fundamental is only believed when a THIRD ridge fits the same comb.
    var VIRT = [[3, 2], [4, 3]];                    // [num, den] → fundamental = lower / den
    var roots = tracks.filter(function (x) { return !x.parent; });
    function groupSize(x) {
      var c = 1;
      for (var q = 0; q < tracks.length; q++) if (tracks[q].parent && rootOf(tracks[q]) === x) c++;
      return c;
    }
    for (j = 1; j < roots.length; j++) {
      B = roots[j];
      if (B.parent) continue;
      for (i = 0; i < j; i++) {
        A = roots[i];
        if (A.parent) continue;
        ov = overlapRatio(A, B);
        if (!ov || ov.n < 0.6 * Math.min(A.n, B.n)) continue;
        for (k = 0; k < VIRT.length; k++) {
          var num = VIRT[k][0], dn = VIRT[k][1];
          if (Math.abs(ov.r * dn / num - 1) > cfg.virtTol) continue;
          if (A.div !== 1 && A.div !== dn) continue;            // keep one consistent comb
          if (A.fMed / dn < 180) continue;
          if (groupSize(A) + groupSize(B) < 3) continue;
          A.div = dn; B.parent = A;
          break;
        }
        if (B.parent) break;
      }
    }

    // --- 6. Notes: the steady stretches of each sound ---
    function centerSec(frame) { return (frame * H + N / 2) / sr; }
    var minSteady = Math.max(3, Math.ceil(cfg.minSteadyMs / hopMs));
    var preMax = Math.round(cfg.preMs / hopMs), postMax = Math.round(cfg.postMs / hopMs);
    var cand = [];
    var rawAcc = new Float64Array(nb), peakAcc = new Float64Array(nb), medBuf = new Float64Array(25);
    roots = tracks.filter(function (x) { return !x.parent; });
    for (var ri = 0; ri < roots.length; ri++) {
      var R = roots[ri], Rn = R.n;
      var members = [R];
      for (i = 0; i < tracks.length; i++) if (tracks[i].parent && rootOf(tracks[i]) === R) members.push(tracks[i]);
      var cc = new Float64Array(Rn), ge = new Float64Array(Rn);
      for (i = 0; i < Rn; i++) cc[i] = 100 * hzToMidi(R.f[i] / R.div);
      for (k = 0; k < members.length; k++) {
        var M = members[k];
        var a0 = Math.max(R.t0, M.t0), z0 = Math.min(R.t1, M.t1);
        for (t = a0; t <= z0; t++) ge[t - R.t0] += M.e[t - M.t0];
      }
      // Split at deep energy dips: "pe-ter pe-ter" is several notes, not one.
      var breaks = [0];
      var lmax = ge[0];
      for (i = 1; i < Rn - 1; i++) {
        if (ge[i] > lmax) lmax = ge[i];
        if (ge[i] <= ge[i - 1] && ge[i] <= ge[i + 1]) {
          var rmax = 0;
          for (j = i + 1; j < Rn; j++) {
            if (ge[j] > rmax) rmax = ge[j];
            if (j > i + 1 && ge[j] < ge[i]) break;  // only up to the next deeper dip
          }
          if (ge[i] < cfg.valley * Math.min(lmax, rmax)) { breaks.push(i); lmax = ge[i]; }
        }
      }
      breaks.push(Rn);
      for (var bi = 0; bi + 1 < breaks.length; bi++) {
        var segA = breaks[bi], segB = breaks[bi + 1] - 1;
        var wins = [];
        steadyWindows(cc, ge, segA, segB, cfg.steadyBand, minSteady, wins);
        wins.sort(function (x, y) { return x[0] - y[0]; });
        for (var wi = 0; wi < wins.length; wi++) {
          var w0 = wins[wi][0], w1 = wins[wi][1];
          // Pitch: energy-weighted median, then the mean of what sits close to it.
          var order = [];
          for (i = w0; i <= w1; i++) order.push(i);
          order.sort(function (x, y) { return cc[x] - cc[y]; });
          var tot = 0; for (i = w0; i <= w1; i++) tot += ge[i];
          var acc = 0, medC = cc[order[0]];
          for (i = 0; i < order.length; i++) { acc += ge[order[i]]; if (acc >= tot / 2) { medC = cc[order[i]]; break; } }
          var sw = 0, sc = 0;
          for (i = w0; i <= w1; i++) if (Math.abs(cc[i] - medC) <= 30) { sw += ge[i]; sc += ge[i] * cc[i]; }
          var pitchC = sw > 0 ? sc / sw : medC;
          var vs = 0, dsum = 0;
          for (i = w0; i <= w1; i++) vs += ge[i] * (cc[i] - pitchC) * (cc[i] - pitchC);
          var sd = Math.sqrt(vs / (tot || 1));
          // Purity = this sound's share of everything else going on while it
          // holds its note — judged over what playback lets through. The page
          // cuts all sound well below the note (rumbleCut), so a truck or a
          // crow down there does not make a kinglet's note any less clean.
          var cutB = Math.max(lo, Math.round(rumbleCut(midiToHz(pitchC / 100)) / binHz) - b0);
          dsum = 0;
          for (b = cutB; b <= hi; b++) {
            var be = 0, raw = 0;
            for (i = w0; i <= w1; i++) {
              pw = P[(R.t0 + i) * nb + b]; raw += pw;
              dv = pw - floor[b] * gain[R.t0 + i]; if (dv > 0) be += dv;
            }
            dsum += be; rawAcc[b] = raw;
          }
          var purity = dsum > 0 ? Math.min(1, tot / dsum) : 0;
          // ...and it has to LEAD: stand clear of every other pitched sound in
          // that band. A note sung under a louder neighbour measures fine and
          // then plays back as the neighbour's pitch — on the real clips that
          // was the one way a tune still went wrong — so such a note is not
          // offered at all. Judged on the RAW spectrum, not the denoised one: a
          // steady drone (a tree frog, a compressor) cancels itself out of the
          // analysis, but it is still on the tape. What counts is how far each
          // sound pokes above the spectrum around it, so plain broadband hiss
          // or rumble, which has no pitch to mistake, is not a rival.
          for (b = cutB; b <= hi; b++) {
            var m0 = Math.max(cutB, b - 12), m1 = Math.min(hi, b + 12), mn = 0;
            for (k = m0; k <= m1; k++) medBuf[mn++] = rawAcc[k];
            var ex = rawAcc[b] - 1.5 * sortedMedian(medBuf, mn);
            peakAcc[b] = ex > 0 ? ex : 0;
          }
          var ownTop = 0, bands = [];
          for (k = 0; k < members.length; k++) {
            M = members[k];
            a0 = Math.max(R.t0 + w0, M.t0); z0 = Math.min(R.t0 + w1, M.t1);
            if (z0 < a0) continue;
            var fa = Infinity, fz = 0;
            for (t = a0; t <= z0; t++) { var mf = M.f[t - M.t0]; if (mf < fa) fa = mf; if (mf > fz) fz = mf; }
            var ba = Math.max(cutB, Math.floor(fa / binHz) - b0 - 2), bz = Math.min(hi, Math.ceil(fz / binHz) - b0 + 2);
            if (bz < ba) continue;
            var os = 0;
            for (b = ba; b <= bz; b++) if (peakAcc[b] > os) os = peakAcc[b];
            if (os > ownTop) ownTop = os;
            bands.push(ba, bz);
          }
          var rival = 0;
          for (b = cutB; b <= hi; b++) {
            var mine = false;
            for (k = 0; k < bands.length; k += 2) if (b >= bands[k] && b <= bands[k + 1]) { mine = true; break; }
            if (!mine && peakAcc[b] > rival) rival = peakAcc[b];
          }
          if (!(ownTop > 0 && ownTop >= cfg.leadBy * rival)) continue;
          // How much of a TONE it is: the share of the partial's energy that
          // sits right on its pitch (±1 bin) rather than smeared around it
          // (±4). A whistle scores ~1; a wren's burble, a bunting's buzz or a
          // turkey's gobble hold a "steady pitch" on paper but are really a
          // trill around it, and score 0.5–0.7. They stay playable (that
          // burble IS the wren) but a clean note is preferred to them.
          var cn = 0, cd = 0;
          for (i = w0; i <= w1; i++) {
            row = (R.t0 + i) * nb; g = gain[R.t0 + i];
            var pb = Math.round(R.f[i] / binHz) - b0;
            for (k = -4; k <= 4; k++) {
              b = pb + k;
              if (b < 0 || b >= nb) continue;
              dv = P[row + b] - floor[b] * g;
              if (dv <= 0) continue;
              cd += dv;
              if (k >= -1 && k <= 1) cn += dv;
            }
          }
          var toneShare = cd > 0 ? cn / cd : 0;
          // Sample bounds. [s0,s1] is the steady part alone — the "pure note".
          // [t0,t1] is the bird's whole syllable around it: the slide up into the
          // note, the drop away after it, everything that makes a cardinal sound
          // like a cardinal — up to where the next note (or a silence) begins.
          // Playback chooses how much of that natural call to keep.
          var prevEnd = wi > 0 ? wins[wi - 1][1] : segA - 1;
          var nextStart = wi + 1 < wins.length ? wins[wi + 1][0] : segB + 1;
          var p0 = w0, p1 = w1;
          while (p0 - 1 > prevEnd && w0 - (p0 - 1) <= preMax) p0--;
          while (p1 + 1 < nextStart && (p1 + 1) - w1 <= postMax) p1++;
          var tStart = centerSec(R.t0 + p0) - 0.012;
          if (p0 === 0) {
            // The syllable begins here. The first analysis window only says
            // "somewhere in these 32 ms", which is audible lag under a finger —
            // so pin the true attack to the millisecond.
            tStart = onsetTime(pcm, sr, centerSec(R.t0) - N / (2 * sr), centerSec(R.t0) + N / (2 * sr), R.f[0]);
          }
          var steadyMs = (w1 - w0 + 1) * hopMs;
          var mid = (centerSec(R.t0 + w0) + centerSec(R.t0 + w1)) / 2;
          var tA = Math.max(0, tStart), tZ = Math.min(dur, centerSec(R.t0 + p1) + 0.02);
          var sA = Math.max(tA, centerSec(R.t0 + w0) - H / (2 * sr)), sZ = Math.min(tZ, centerSec(R.t0 + w1) + H / (2 * sr));
          // The "body": how far either side of the steady part the call stays ON
          // this note before it slides off to a different pitch. A titmouse's
          // "peter" holds its note for 50 ms and then falls a third: the fall is
          // the bird, but it is not the note.
          var q0 = w0, q1 = w1;
          while (q0 - 1 >= p0 && Math.abs(cc[q0 - 1] - pitchC) <= cfg.bodyCents) q0--;
          while (q1 + 1 <= p1 && Math.abs(cc[q1 + 1] - pitchC) <= cfg.bodyCents) q1++;
          cand.push({
            t0: tA, t1: tZ, s0: sA, s1: sZ,
            b0: q0 === p0 ? tA : Math.max(tA, centerSec(R.t0 + q0) - H / (2 * sr)),
            b1: q1 === p1 ? tZ : Math.min(tZ, centerSec(R.t0 + q1) + H / (2 * sr)),
            hz: midiToHz(pitchC / 100), midi: pitchC / 100,
            steadyMs: steadyMs, sd: sd, purity: purity, tone: toneShare, snr: R.salDb,
            e: tot / (w1 - w0 + 1), harm: members.length, div: R.div, mid: mid,
            rms: rmsOf(pcm, sr, centerSec(R.t0 + w0), centerSec(R.t0 + w1))
          });
        }
      }
    }

    // --- 7. Score, keep the best ---
    var top = 0;
    for (i = 0; i < cand.length; i++) if (cand[i].e > top) top = cand[i].e;
    // BirdNET-Pi cuts 1.5 s of context either side of its 3 s detection, so in a
    // full-length clip the bird it NAMED is most likely the one in the middle.
    var cLo = dur >= 5.5 ? 1.3 : -1, cHi = dur >= 5.5 ? dur - 1.3 : dur + 1;
    var notes = [];
    for (i = 0; i < cand.length; i++) {
      var nt = cand[i];
      nt.rel = 10 * Math.log(nt.e / top) / Math.LN10;
      var st = clamp01(1 - (nt.sd - 6) / 28);
      var sn = clamp01((nt.snr - 10) / 18);
      var du = 0.25 + 0.75 * clamp01((nt.steadyMs - 40) / 150);
      var lv = 0.55 + 0.45 * clamp01(1 + nt.rel / 26);
      var ce = (nt.mid >= cLo && nt.mid <= cHi) ? 1 : 0.8;
      // How plainly the note states its pitch. A whistle says it outright; a
      // stack of overtones (a honk, a caw) says it with an accent; a call whose
      // fundamental is missing altogether (a jay's scream, a nuthatch's "yank")
      // only implies it. All three are playable, but given the choice a tune
      // is better carried by the plainer voice.
      var tn = (nt.div > 1 ? 0.8 : (nt.harm >= 3 ? 0.92 : 1)) * (0.5 + 0.5 * clamp01((nt.tone - 0.6) / 0.25));
      nt.q = Math.pow(nt.purity, 0.5) * Math.pow(st, 0.3) * Math.pow(sn, 0.15) * Math.pow(du, 0.3) * lv * ce * tn;
      nt.dur = nt.t1 - nt.t0;
      nt.z1 = nt.t1;
      delete nt.e; delete nt.mid;
      if (nt.purity < cfg.minPurity || nt.sd > cfg.maxSd || nt.rel < cfg.minRelDb) continue;
      if (nt.q >= cfg.minQ) notes.push(nt);
    }
    // A repeated call ("cheer cheer cheer") is the same note many times: keep
    // only its best few takes so one clip can't flood a key.
    notes.sort(function (x, y) { return y.q - x.q; });
    var perKey = {}, kept = [];
    for (i = 0; i < notes.length; i++) {
      var kq = Math.round(notes[i].midi);
      perKey[kq] = (perKey[kq] || 0) + 1;
      if (perKey[kq] <= cfg.perKey) kept.push(notes[i]);
    }
    notes = kept;
    var maxNotes = o.maxNotes || cfg.maxNotes;
    if (notes.length > maxNotes) notes.length = maxNotes;
    notes.sort(function (x, y) { return x.t0 - y.t0; });
    out.notes = notes;

    // --- 8. The "voice": the liveliest stretch of the clip, for the soundboard ---
    // Works for every bird, tuneful or not — a crow's caw and a woodpecker's
    // drum have no notes to cut, but they still have a voice.
    var sm = Math.max(1, Math.round(50 / hopMs)), Es = new Float32Array(T), run = 0;
    for (t = 0; t < T; t++) {
      run += D[t]; if (t >= sm) run -= D[t - sm];
      Es[t] = run / Math.min(t + 1, sm);
    }
    var sorted = Float32Array.from(Es); sorted.sort();
    var medE = sorted[T >> 1], maxE = sorted[T - 1];
    if (maxE > 0) {
      var thr = Math.max(medE * 3, maxE * 0.04);
      var L = Math.min(T, Math.round(cfg.phraseMs / hopMs));
      var bestS = 0, bestV = -1, wsum = 0;
      var wgt = function (q) { var s = centerSec(q); return (s >= cLo && s <= cHi) ? 1 : 0.6; };
      for (t = 0; t < T; t++) {
        wsum += Es[t] * wgt(t);
        if (t >= L) wsum -= Es[t - L] * wgt(t - L);
        if (t >= L - 1 && wsum > bestV) { bestV = wsum; bestS = t - L + 1; }
      }
      var pa = bestS, pb = bestS + L - 1;
      while (pa < pb && Es[pa] < thr) pa++;
      while (pb > pa && Es[pb] < thr) pb--;
      var ph0 = Math.max(0, centerSec(pa) - 0.09), ph1 = Math.min(dur, centerSec(pb) + 0.14);
      if (ph1 - ph0 < 0.7) {                        // a lone chip: give it a little room
        var padd = (0.7 - (ph1 - ph0)) / 2;
        ph0 = Math.max(0, ph0 - padd); ph1 = Math.min(dur, ph1 + padd);
      }
      var mean = 0; for (t = pa; t <= pb; t++) mean += Es[t];
      mean /= (pb - pa + 1);
      out.phrase = { t0: ph0, t1: ph1, snr: 10 * Math.log((mean + eps) / (medE + eps)) / Math.LN10 };

      // --- 9. How far the bird sings on after each note ---
      // One syllable is a note; the run of syllables after it is what makes it
      // a BIRD. Follow the call past the note until it pauses for longer than
      // singGapMs (or singMs is up).
      //
      // "Calling" is judged on the RIDGES, not on loudness: on the yard's real
      // clips a whistle is often no louder than the hiss across the whole band
      // (it only stands out in its own few bins), so a loudness gate threw most
      // calls away. A ridge is by construction a tone well clear of the noise,
      // so the bird is calling while ridges carry something within reach of the
      // note's own level. And it is NOT a call when a lot of sound turns up that
      // no ridge accounts for — well above the usual hiss, loud next to the
      // note, and louder than whatever ridges there are: a rustle, rain, a door.
      var gapF = Math.max(1, Math.round(cfg.singGapMs / hopMs));
      var junkF = Math.max(1, Math.round(cfg.junkMs / hopMs));
      // The same 50 ms mean as Es, of what the ridges carry and of the rest.
      var Rs = new Float32Array(T), Xs = new Float32Array(T), maxR = 0, runX = 0;
      run = 0;
      for (t = 0; t < T; t++) {
        run += ridgeE[t]; runX += restE[t];
        if (t >= sm) { run -= ridgeE[t - sm]; runX -= restE[t - sm]; }
        Rs[t] = run / Math.min(t + 1, sm); Xs[t] = runX / Math.min(t + 1, sm);
        if (Rs[t] > maxR) maxR = Rs[t];
      }
      // Rs trails the sound (a 50 ms mean over windows N long), so the note's
      // own dying echo in it must not be mistaken for the bird singing on.
      var echoF = Math.ceil((50 + 500 * N / sr) / hopMs) + 1;
      var frameOf = function (sec) { return Math.max(0, Math.min(T - 1, Math.round((sec * sr - N / 2) / H))); };
      var gmin2 = Math.pow(10, -cfg.cleanDb / 10), quiet = [];
      for (i = 0; i < notes.length; i++) {
        nt = notes[i];
        var fa0 = frameOf(nt.s0), fa1 = frameOf(nt.s1), own = 0;
        for (t = fa0; t <= fa1; t++) if (Rs[t] > own) own = Rs[t];
        var live = Math.min(maxR * cfg.liveMax, own * cfg.liveOwn);
        var loud = Math.max(own * cfg.junkOwn, floorSum * cfg.junkUp);
        var f1 = frameOf(nt.t1), fEnd = frameOf(nt.t1 + cfg.singMs / 1000), lastOn = f1, hush = 0, junk = 0;
        for (t = f1 + 1; t <= fEnd; t++) {
          if (Xs[t] >= loud && Rs[t] < Xs[t]) {
            if (++junk > junkF) break;              // the noise wins from here: stop before it
            hush = 0;
          } else if (Rs[t] >= live && t > f1 + echoF) { lastOn = t; junk = 0; hush = 0; }
          else if (++hush > gapF) break;
        }
        if (lastOn > f1) nt.z1 = Math.min(dur, Math.max(nt.t1, centerSec(lastOn) + 0.03));
        // How noisy the note itself is: everything around its tone, as it will
        // be played (above the rumble cut, the steady background already turned
        // down), against the tone. In dB: 0 = as much noise as note. A rough
        // voice counts as noise here too; that is what `tone` and `purity`
        // already say about it, in other words.
        var hpB = Math.max(lo, Math.ceil(rumbleCut(nt.hz) / binHz) - b0);
        var fz0 = frameOf(nt.b0), fz1 = frameOf(nt.b1), toneE = 0, restN = 0;
        for (t = fz0; t <= fz1; t++) {
          row = t * nb;
          for (b = hpB; b <= hi; b++) {
            pw = P[row + b];
            if (ridge[row + b]) toneE += pw; else restN += pass[row + b] ? pw : pw * gmin2;
          }
        }
        nt.bg = 10 * Math.log((restN + eps) / (toneE + eps)) / Math.LN10;
        if (nt.bg <= cfg.bgMax) quiet.push(nt);     // too loud a background: not used at all
      }
      out.notes = quiet;
    }
    // Scratch for cutClip (which removes it): what is call and what is background.
    out.nr = { N: N, H: H, T: T, b0: b0, nb: nb, pass: pass };
    return out;
  }

  // Power of one frequency in a short Hann-windowed slice (Goertzel): a cheap
  // single-bin probe, used to time an attack far more finely than the STFT can.
  function tonePower(pcm, start, len, hz, sr) {
    if (start < 0) start = 0;
    if (start + len > pcm.length) len = pcm.length - start;
    if (len < 8) return 0;
    var w = 2 * Math.PI * hz / sr, coeff = 2 * Math.cos(w), s1 = 0, s2 = 0;
    for (var i = 0; i < len; i++) {
      var x = pcm[start + i] * (0.5 - 0.5 * Math.cos(2 * Math.PI * i / (len - 1)));
      var s0 = x + coeff * s1 - s2; s2 = s1; s1 = s0;
    }
    return s1 * s1 + s2 * s2 - coeff * s1 * s2;
  }
  // When, between `from` and `to` (seconds), does a tone at `hz` really begin?
  // Slides a 6 ms probe in 1 ms steps and returns just before the first step
  // that reaches a tenth of the loudest the tone gets in that stretch.
  function onsetTime(pcm, sr, from, to, hz) {
    var len = Math.max(32, Math.round(0.006 * sr)), step = Math.max(1, Math.round(0.001 * sr));
    var a = Math.max(0, Math.round(from * sr)), z = Math.min(pcm.length - len, Math.round(to * sr));
    if (z <= a) return Math.max(0, from);
    var pw = [], ref = 0, i;
    for (i = a; i <= z; i += step) { var v = tonePower(pcm, i, len, hz, sr); pw.push(v); if (v > ref) ref = v; }
    if (!(ref > 0)) return Math.max(0, from);
    for (i = 0; i < pw.length; i++) {
      if (pw[i] >= 0.1 * ref) return Math.max(0, (a + i * step) / sr - 0.002);
    }
    return Math.max(0, from);
  }
  function rmsOf(pcm, sr, from, to) {
    var a = Math.max(0, Math.round(from * sr)), z = Math.min(pcm.length, Math.round(to * sr)), s = 0;
    if (z <= a) return 0;
    for (var i = a; i < z; i++) s += pcm[i] * pcm[i];
    return Math.sqrt(s / (z - a));
  }

  // Cut [t0,t1] out of the clip as 16-bit PCM. The slice is scaled so its
  // loudest sample sits near full scale — a far-off bird would otherwise use
  // only a few of the sixteen bits. `gain` is the scale that was applied.
  function cutPcm(pcm, sr, t0, t1) {
    var a = Math.max(0, Math.floor(t0 * sr)), z = Math.min(pcm.length, Math.ceil(t1 * sr));
    var n = Math.max(0, z - a), peak = 0, i, v;
    for (i = a; i < z; i++) { v = pcm[i] < 0 ? -pcm[i] : pcm[i]; if (v > peak) peak = v; }
    var g = peak > 0 ? 0.92 / peak : 1;
    var out = new Int16Array(n);
    for (i = 0; i < n; i++) out[i] = Math.round(pcm[a + i] * g * 32767);
    return { pcm: out, gain: g };
  }
  // Samples [a,z) of the clip with the background turned down: every STFT bin
  // that analyzeClip did not mark as part of a call (nr.pass) is scaled by
  // cleanDb, the rest is left exactly as recorded, and the frames are overlap-
  // added back. Nothing is added and nothing is gated to silence, so there is no
  // "underwater" warble: the hiss is still there, a good deal quieter.
  function cleanSlice(pcm, sr, nr, a, z) {
    var N = nr.N, H = nr.H, nb = nr.nb, b0 = nr.b0, half = N >> 1;
    var n = z - a, out = new Float32Array(n), wsum = new Float32Array(n);
    var gmin = Math.pow(10, -CFG.cleanDb / 20), i, k, b;
    var win = new Float32Array(N);
    for (i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1));
    var re = new Float32Array(N), im = new Float32Array(N), G = new Float32Array(half + 1), Gs = new Float32Array(half + 1);
    var f0 = Math.max(0, Math.floor((a - N) / H) + 1), f1 = Math.min(nr.T - 1, Math.floor((z - 1) / H));
    for (var f = f0; f <= f1; f++) {
      var off = f * H, row = f * nb;
      for (i = 0; i < N; i++) { re[i] = pcm[off + i] * win[i]; im[i] = 0; }
      fft(re, im);
      for (k = 0; k <= half; k++) { b = k - b0; G[k] = (b >= 0 && b < nb && nr.pass[row + b]) ? 1 : gmin; }
      Gs[0] = G[0]; Gs[half] = G[half];             // soften the mask's edges across frequency
      for (k = 1; k < half; k++) Gs[k] = 0.25 * G[k - 1] + 0.5 * G[k] + 0.25 * G[k + 1];
      for (k = 0; k <= half; k++) {
        re[k] *= Gs[k]; im[k] *= -Gs[k];            // (negated: inverse FFT by conjugation)
        if (k > 0 && k < half) { re[N - k] *= Gs[k]; im[N - k] *= -Gs[k]; }
      }
      fft(re, im);
      for (i = 0; i < N; i++) {
        var q = off + i - a;
        if (q < 0 || q >= n) continue;
        out[q] += (re[i] / N) * win[i];
        wsum[q] += win[i] * win[i];
      }
    }
    for (i = 0; i < n; i++) out[i] = wsum[i] > 0.05 ? out[i] / wsum[i] : pcm[a + i] * gmin;
    return out;
  }

  // The loudest the sound gets between two times: the highest RMS of any 50 ms
  // stretch (stepped by 10 ms). 0 when there is less than 60 ms to measure.
  function loudestOf(pcm, sr, from, to) {
    var a = Math.max(0, Math.round(from * sr)), z = Math.min(pcm.length, Math.round(to * sr));
    var w = Math.round(0.05 * sr), step = Math.max(1, Math.round(0.01 * sr)), best = 0;
    if (z - a < Math.round(0.06 * sr)) return 0;
    for (var i = a; i + w <= z; i += step) {
      var e = 0;
      for (var j = i; j < i + w; j++) e += pcm[j] * pcm[j];
      if (e > best) best = e;
    }
    return Math.sqrt(best / w);
  }
  // Attach the playable samples to an analyzeClip() result: note.pcm for every
  // note (note.rms is rescaled to match), and — with opts.phrase — phrase.pcm.
  // A note's samples run from t0 to z1: its syllable and then the rest of the
  // call. note.tail is the loudest that "rest" gets, on the same scale as rms,
  // so playback can keep the note in front of what follows it.
  // Returns the list of ArrayBuffers, ready to hand to postMessage as transfers.
  function cutClip(pcm, sr, res, opts) {
    var o = opts || {}, bufs = [], c;
    var nr = res.nr, clean = !!(nr && CFG.cleanDb > 0 && o.clean !== false);
    for (var i = 0; i < res.notes.length; i++) {
      var n = res.notes[i];
      var end = n.z1 > n.t1 ? n.z1 : n.t1;
      if (clean) {
        // The note's slice with the background turned down; its loudness is
        // measured again, on what will actually be played.
        var a = Math.max(0, Math.floor(n.t0 * sr)), z = Math.min(pcm.length, Math.ceil(end * sr));
        var sl = cleanSlice(pcm, sr, nr, a, z), base = a / sr;
        c = cutPcm(sl, sr, 0, sl.length / sr);
        n.rms = rmsOf(sl, sr, n.s0 - base, n.s1 - base) * c.gain;
        n.tail = loudestOf(sl, sr, n.b1 - base, end - base) * c.gain;
      } else {
        c = cutPcm(pcm, sr, n.t0, end);
        n.rms *= c.gain;
        n.tail = loudestOf(pcm, sr, n.b1, end) * c.gain;
      }
      n.pcm = c.pcm;
      bufs.push(c.pcm.buffer);
    }
    delete res.nr;
    if (res.phrase && o.phrase) {
      c = cutPcm(pcm, sr, res.phrase.t0, res.phrase.t1);
      res.phrase.pcm = c.pcm;
      res.phrase.rms = rmsOf(pcm, sr, res.phrase.t0, res.phrase.t1) * c.gain;
      bufs.push(c.pcm.buffer);
    }
    return bufs;
  }

  // Find the non-overlapping stretches of [a,b] in which the pitch c[] stays
  // inside a `band`-cent window for at least minLen frames. The most energetic
  // stretch is taken first, then the search repeats either side of it.
  function steadyWindows(c, w, a, b, band, minLen, out) {
    if (b - a + 1 < minLen) return;
    var bestI = -1, bestJ = -1, bestE = -1;
    for (var i = a; i <= b - minLen + 1; i++) {
      var mn = c[i], mx = c[i], e = 0, j = i;
      for (; j <= b; j++) {
        if (c[j] < mn) mn = c[j]; else if (c[j] > mx) mx = c[j];
        if (mx - mn > band) break;
        e += w[j];
      }
      j--;
      if (j - i + 1 >= minLen && e > bestE) { bestE = e; bestI = i; bestJ = j; }
    }
    if (bestI < 0) return;
    out.push([bestI, bestJ]);
    steadyWindows(c, w, a, bestI - 1, band, minLen, out);
    steadyWindows(c, w, bestJ + 1, b, band, minLen, out);
  }

  // -------------------------------------------------------------- bank ----
  // The bank is every note cut from every clip. Each note belongs to one KEY
  // (its nearest equal-tempered semitone) and sits `cents` away from that key's
  // exact pitch — never more than 50, which is the whole "tiny nudge" budget.
  function keyOf(midi) { return Math.round(midi); }

  // How much to trust each note, beyond its own quality. Two things matter:
  //   - closeness to its key (a note 45 cents flat is a poorer C than one dead on),
  //   - whether the SAME species sings near that pitch in its OTHER recordings.
  //     A clip often has a second bird in the background; a pitch this species
  //     hits in one clip only is more likely the neighbour than the bird named.
  // And a note heard in one clip only, lying more than an octave outside
  // everything the bird sings in two or more of its clips, is flagged `odd`: on
  // the yard's real recordings those were a mourning dove cooing behind a phoebe,
  // a kinglet over a woodpecker. An odd note can still hold a key nobody else
  // has (it is a real sound from the yard), but it is the last choice for one,
  // it stays out of the bird's solo board, and the page says so.
  // Sets note.key, .cents, .sup, .odd, .rank on each note. Notes need
  // { sci, clip, midi, q }; bg, t1 and z1 are used when they are there.
  function rankNotes(notes) {
    var bySci = {}, i;
    for (i = 0; i < notes.length; i++) (bySci[notes[i].sci] = bySci[notes[i].sci] || []).push(notes[i]);
    Object.keys(bySci).forEach(function (sci) {
      var list = bySci[sci], clips = {}, nClips = 0;
      list.forEach(function (n) { if (!clips[n.clip]) { clips[n.clip] = 1; nClips++; } });
      var sLo = Infinity, sHi = -Infinity, sN = 0;
      list.forEach(function (n) {
        var seen = {}, sup = 0;
        for (var k = 0; k < list.length; k++) {
          var m = list[k];
          if (m.clip === n.clip || seen[m.clip]) continue;
          if (Math.abs(m.midi - n.midi) <= 1.2) { seen[m.clip] = 1; sup++; }
        }
        n.key = keyOf(n.midi);
        n.cents = (n.midi - n.key) * 100;
        n.sup = sup;
        if (sup > 0) { sN++; if (n.midi < sLo) sLo = n.midi; if (n.midi > sHi) sHi = n.midi; }
      });
      list.forEach(function (n) {
        n.odd = !n.sup && nClips >= 3 && sN >= 2 && (n.midi < sLo - CFG.oddSemis || n.midi > sHi + CFG.oddSemis);
        var trust = n.sup > 0 ? 1 + 0.1 * Math.min(n.sup, 3) : (n.odd ? 0.5 : (nClips >= 3 ? 0.8 : 1));
        // Two things about the slice the note is cut from (when they are known):
        // noise around the note marks it down, and a note the bird sings on
        // from is worth a little more than one that just stops.
        var clear = n.bg > CFG.bgOk ? Math.max(0.5, 1 - 0.5 * (n.bg - CFG.bgOk) / (CFG.bgBad - CFG.bgOk)) : 1;
        var on = n.z1 > n.t1 ? 1 + CFG.singBonus * Math.min(1, (n.z1 - n.t1) / 0.4) : 1;
        n.rank = n.q * (1 - 0.35 * Math.abs(n.cents) / 50) * trust * clear * on;
      });
    });
    return notes;
  }

  // Lay the notes out as a keyboard.
  //   keys[k] = that key's singers: the best note PER SPECIES, best first.
  //   pick[k] = which singer the key shows first. Not simply the best: the
  //             choice is nudged so neighbouring keys go to different birds and
  //             no one species hogs the board — the point is to hear the range
  //             of the yard, not forty keys of chickadee. But variety never
  //             costs quality: only birds whose note is nearly as good as the
  //             key's best (within CFG.pickBand) are in the running.
  // opts.sci restricts the board to one species (solo mode), minus its `odd`
  // notes (see rankNotes): a solo board should be that bird and nothing else.
  function buildKeys(notes, opts) {
    var o = opts || {}, keys = {}, i;
    for (i = 0; i < notes.length; i++) {
      var n = notes[i];
      if (o.sci && (n.sci !== o.sci || n.odd)) continue;        // solo: this bird, and surely this bird
      if (n.key == null) continue;
      var slot = keys[n.key] || (keys[n.key] = {});
      if (o.sci) (slot._all || (slot._all = [])).push(n);         // solo: keep every take
      else if (!slot[n.sci] || n.rank > slot[n.sci].rank) slot[n.sci] = n;
    }
    var list = Object.keys(keys).map(Number).sort(function (a, b) { return a - b; });
    var outKeys = {}, pick = {};
    list.forEach(function (k) {
      var arr = o.sci ? keys[k]._all : Object.keys(keys[k]).map(function (s) { return keys[k][s]; });
      arr.sort(function (a, b) { return b.rank - a.rank; });
      if (o.sci && arr.length > 6) arr.length = 6;
      outKeys[k] = arr;
      pick[k] = 0;
    });
    if (!o.sci) {
      var usage = {}, chosen = {};
      var order = list.slice().sort(function (a, b) { return outKeys[a].length - outKeys[b].length || a - b; });
      order.forEach(function (k) {
        var arr = outKeys[k], best = 0, bestV = -1, floor = arr[0].rank * CFG.pickBand;
        for (var c = 0; c < arr.length; c++) {
          if (arr[c].rank < floor) break;                         // (best-first, so the rest are worse)
          var s = arr[c].sci, v = arr[c].rank / (1 + 0.6 * (usage[s] || 0));
          if (chosen[k - 1] === s || chosen[k + 1] === s) v *= 0.6;
          else if (chosen[k - 2] === s || chosen[k + 2] === s) v *= 0.85;
          if (v > bestV) { bestV = v; best = c; }
        }
        pick[k] = best;
        chosen[k] = arr[best].sci;
        usage[arr[best].sci] = (usage[arr[best].sci] || 0) + 1;
      });
    }
    return { keys: outKeys, pick: pick, list: list, lo: list.length ? list[0] : null, hi: list.length ? list[list.length - 1] : null };
  }

  // What each species can sing: its distinct keys and their span. Drives the
  // solo picker ("Northern Cardinal — 14 notes across 2 octaves"). Best solo
  // voices first: a bird is ranked by its keys weighed by how good the note on
  // each one is, so a kinglet's twelve clean whistles come before a
  // woodpecker's fifteen rough ones. Doubted (`odd`) notes are not counted.
  function speciesRanges(notes) {
    var by = {};
    notes.forEach(function (n) {
      if (n.key == null || n.odd) return;
      var s = by[n.sci] || (by[n.sci] = { sci: n.sci, keys: {}, notes: 0 });
      var r = n.rank == null ? 1 : n.rank;
      if (!(s.keys[n.key] >= r)) s.keys[n.key] = r;
      s.notes++;
    });
    return Object.keys(by).map(function (sci) {
      var s = by[sci], ks = Object.keys(s.keys).map(Number).sort(function (a, b) { return a - b; });
      var score = 0;
      ks.forEach(function (k) { score += Math.min(1, s.keys[k]); });
      return { sci: sci, keys: ks, count: ks.length, notes: s.notes, score: score, lo: ks[0], hi: ks[ks.length - 1], span: ks[ks.length - 1] - ks[0] };
    }).sort(function (a, b) { return b.score - a.score || b.count - a.count || b.span - a.span; });
  }

  // ------------------------------------------------------------ melody ----
  // A tune is [{ m: midi, t: start beat, d: beats }]. Typed tunes use a tiny
  // notation: letters A–G (+ # or b), an optional octave number that STICKS for
  // the notes after it, ":beats" for length (default 1), "r" for a rest, and "|"
  // wherever you like (bar lines are only for the reader).
  //   C4 C G G A A G:2 | F F E E D D C:2
  var STEP = { c: 0, d: 2, e: 4, f: 5, g: 7, a: 9, b: 11 };
  function parseMelody(text) {
    var notes = [], errors = [], bars = [], t = 0, barStart = 0, oct = 4;
    var toks = String(text == null ? '' : text).replace(/\|/g, ' | ').split(/[\s,]+/);
    for (var i = 0; i < toks.length; i++) {
      var tok = toks[i];
      if (!tok) continue;
      if (tok === '|') { if (t > barStart) bars.push(t - barStart); barStart = t; continue; }
      var m = /^([A-Ga-g])([#♯b♭]?)(-?\d)?(?::(\d*\.?\d+))?$/.exec(tok);
      var rest = !m && /^(?:r|R|z|_|-)(?::(\d*\.?\d+))?$/.exec(tok);
      if (!m && !rest) { errors.push(tok); continue; }
      var d = parseFloat((m ? m[4] : rest[1]) || '1');
      if (!(d > 0) || d > 64) { errors.push(tok); continue; }
      if (m) {
        if (m[3] != null) oct = parseInt(m[3], 10);
        var acc = (m[2] === '#' || m[2] === '♯') ? 1 : (m[2] ? -1 : 0);
        notes.push({ m: 12 * (oct + 1) + STEP[m[1].toLowerCase()] + acc, t: t, d: d });
      }
      t += d;
    }
    if (t > barStart) bars.push(t - barStart);
    return { notes: notes, beats: t, bars: bars, errors: errors };
  }

  // How well a key carries a TUNE, 0..1. Above roughly 4-5 kHz the ear stops
  // hearing notes as a melody (it hears "high" and "higher", which is why a
  // piano stops at C8), and half the yard sings up there: on the real recordings
  // an unweighted fit put Ode to Joy at 7 kHz, every note "right" and no tune
  // to be heard. So the fitter leans toward the octaves where a melody reads as
  // one. The keyboard itself is not filtered: every real note stays playable.
  function melodic(key) {
    if (key > 108) return Math.max(0.25, 1 - 0.1 * (key - 108));    // C8 = 4186 Hz
    if (key < 57) return Math.max(0.6, 1 - 0.05 * (57 - key));      // A3: thin, rumbly
    return 1;
  }

  // Lay a tune onto the notes the birds really have.
  //   has(key) -> 0 if no bird sings that key, else >0 (a 0..1 quality).
  // Because nothing is re-pitched, the only freedom is WHERE the tune sits: every
  // whole-semitone transposition is tried, and the one that lands the most of
  // the tune on real keys, in the octaves a melody can be heard in, on the
  // better notes, wins. A note with no key is then (when fill is on) moved an
  // octave to a key that exists, else to the nearest key within two semitones,
  // else left silent. `how` on each note says which: exact | octave | near | rest.
  // opts.shift pins the transposition instead of searching for it: the roll call
  // is already written on the birds' own keys and must not be slid anywhere.
  function fitMelody(mel, has, opts) {
    var o = opts || {}, fill = o.fill !== false;
    var res = { shift: 0, notes: [], exact: 0, octave: 0, near: 0, rest: 0, total: mel.length, pct: 0 };
    if (!mel.length) return res;
    var lo = o.lo, hi = o.hi, i;
    var mn = Infinity, mx = -Infinity, pcs = {};
    for (i = 0; i < mel.length; i++) {
      if (mel[i].m < mn) mn = mel[i].m;
      if (mel[i].m > mx) mx = mel[i].m;
      pcs[((mel[i].m % 12) + 12) % 12] = 1;
    }
    if (lo == null || hi == null || lo > hi) {
      res.notes = mel.map(function (n) { return { m: n.m, t: n.t, d: n.d, key: null, how: 'rest' }; });
      res.rest = mel.length;
      return res;
    }
    // Where the bank is richest: used only to break ties between equal fits.
    var cw = 0, cs = 0;
    for (var k = lo; k <= hi; k++) { var hv = has(k); if (hv > 0) { cw += hv; cs += hv * k; } }
    var center = cw > 0 ? cs / cw : (lo + hi) / 2;
    var melMid = (mn + mx) / 2;

    function place(key, shift) {                    // → [mappedKey|null, how]
      if (has(key) > 0) return [key, 'exact'];
      if (!fill) return [null, 'rest'];
      for (var oc = 1; oc <= 3; oc++) {             // same note name, another octave
        var up = key + 12 * oc, dn = key - 12 * oc;
        var hu = up <= hi && has(up) > 0, hd = dn >= lo && has(dn) > 0;
        if (hu && hd) {
          var mu = melodic(up), md = melodic(dn);
          if (mu !== md) return [mu > md ? up : dn, 'octave'];
          return [Math.abs(up - center) <= Math.abs(dn - center) ? up : dn, 'octave'];
        }
        if (hu) return [up, 'octave'];
        if (hd) return [dn, 'octave'];
      }
      var best = null, bestV = Infinity;            // nearest real key, in-scale first
      for (var dd = -2; dd <= 2; dd++) {
        if (!dd || !(has(key + dd) > 0)) continue;
        var pc = (((key + dd - shift) % 12) + 12) % 12;
        var v = Math.abs(dd) + (pcs[pc] ? 0 : 0.6) + (dd > 0 ? 0.01 : 0);
        if (v < bestV) { bestV = v; best = key + dd; }
      }
      return best == null ? [null, 'rest'] : [best, 'near'];
    }
    var VAL = { exact: 1, octave: 0.5, near: 0.2, rest: 0 };
    var bestShift = null, bestScore = -Infinity;
    var sFrom = lo - mx - 12, sTo = hi - mn + 12;
    if (o.shift != null) sFrom = sTo = o.shift;
    for (var s = sFrom; s <= sTo; s++) {
      var score = 0, reg = 0, sounding = 0;
      for (i = 0; i < mel.length; i++) {
        var pl = place(mel[i].m + s, s);
        if (pl[0] == null) continue;
        score += VAL[pl[1]] * (0.6 + 0.4 * Math.min(1, has(pl[0])));
        reg += melodic(pl[0]); sounding++;
      }
      // The register counts for the tune as a whole, not note by note: weighing
      // single notes would make it "cheap" to break the tune's shape up high.
      if (sounding) score *= reg / sounding;
      score -= 0.0005 * Math.abs(melMid + s - center) * mel.length / 12;
      if (score > bestScore) { bestScore = score; bestShift = s; }
    }
    res.shift = bestShift;
    for (i = 0; i < mel.length; i++) {
      var p = place(mel[i].m + bestShift, bestShift);
      res.notes.push({ m: mel[i].m, t: mel[i].t, d: mel[i].d, key: p[0], how: p[1] });
      res[p[1]]++;
    }
    res.pct = Math.round(100 * res.exact / mel.length);
    return res;
  }

  // "Roll call": every key the birds have, low to high — the quickest way to
  // hear the whole range of the yard.
  function rollCall(keyList) {
    return keyList.map(function (k, i) { return { m: k, t: i * 0.5, d: 0.5 }; });
  }

  // -------------------------------------------------------------- MIDI ----
  // A small Standard MIDI File reader: enough to pull the notes out of a .mid
  // someone drops on the page. Times come out in beats (quarter notes); the
  // file's first tempo becomes the suggested bpm. Notes are grouped into parts
  // by (track, channel); the drum channel is left out.
  function parseMidi(buf) {
    var d = new Uint8Array(buf), p = 0;
    function u32() { var v = (d[p] << 24 | d[p + 1] << 16 | d[p + 2] << 8 | d[p + 3]) >>> 0; p += 4; return v; }
    function u16() { var v = d[p] << 8 | d[p + 1]; p += 2; return v; }
    function tag() { var s = String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]); p += 4; return s; }
    function vlq() { var v = 0, c; do { c = d[p++]; v = (v << 7) | (c & 0x7f); } while (c & 0x80 && p < d.length); return v; }
    if (d.length < 14 || tag() !== 'MThd') throw new Error('not a MIDI file');
    var hlen = u32(); u16(); var ntr = u16(), div = u16();
    p = 8 + hlen;
    if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
    var ppq = div || 480, bpm = null, parts = {}, order = [];
    for (var ti = 0; ti < ntr && p + 8 <= d.length; ti++) {
      var isTrack = tag() === 'MTrk', clen = u32();        // (read the length BEFORE adding it to p)
      if (!isTrack) { p += clen; continue; }
      var end = p + clen, tick = 0, status = 0, name = '', on = {};
      while (p < end && p < d.length) {
        tick += vlq();
        var bt = d[p];
        if (bt & 0x80) { status = bt; p++; }
        var hi4 = status & 0xf0, ch = status & 0x0f;
        if (status === 0xff) {                      // meta event
          var type = d[p++], mlen = vlq();
          if (type === 0x51 && mlen === 3 && bpm == null) bpm = 60000000 / (d[p] << 16 | d[p + 1] << 8 | d[p + 2]);
          else if (type === 0x03 && !name) { for (var q = 0; q < mlen; q++) name += String.fromCharCode(d[p + q]); }
          p += mlen;
        } else if (status === 0xf0 || status === 0xf7) {
          p += vlq();
        } else if (hi4 === 0x90 || hi4 === 0x80) {
          var key = d[p++], vel = d[p++], id = ch + ':' + key;
          var pk = ti + ':' + ch;
          if (hi4 === 0x90 && vel > 0) {
            (on[id] = on[id] || []).push(tick);
          } else if (on[id] && on[id].length) {
            var st = on[id].shift();
            if (ch !== 9) {
              if (!parts[pk]) { parts[pk] = { track: ti, ch: ch, name: '', notes: [] }; order.push(pk); }
              parts[pk].notes.push({ m: key, t: st / ppq, d: Math.max(0.05, (tick - st) / ppq) });
            }
          }
        } else if (hi4 === 0xc0 || hi4 === 0xd0) {
          p += 1;
        } else if (hi4 >= 0x80) {
          p += 2;
        } else {
          p++;                                      // stray data byte: resync
        }
      }
      order.forEach(function (pk2) { if (parts[pk2].track === ti && !parts[pk2].name) parts[pk2].name = name.replace(/[^\x20-\x7e]/g, '').trim(); });
      p = end;
    }
    var list = order.map(function (pk3) {
      var part = parts[pk3];
      part.notes.sort(function (a, b) { return a.t - b.t || b.m - a.m; });
      var sum = 0; part.notes.forEach(function (n) { sum += n.m; });
      part.mean = part.notes.length ? sum / part.notes.length : 0;
      return part;
    }).filter(function (part) { return part.notes.length > 0; });
    return { ppq: ppq, bpm: bpm ? Math.round(bpm) : 120, parts: list };
  }

  // The part most likely to carry the tune: plenty of notes, sitting high.
  function midiTunePart(parsed) {
    var best = -1, bestV = -Infinity;
    parsed.parts.forEach(function (part, i) {
      if (part.notes.length < 4) return;
      var v = part.mean + 6 * Math.log(part.notes.length) / Math.LN2;
      if (v > bestV) { bestV = v; best = i; }
    });
    return best < 0 ? (parsed.parts.length ? 0 : -1) : best;
  }

  // Notes of one part (or of every part, with index -1) as a tune starting at
  // beat 0. mode 'top' keeps only the highest note sounding at each moment (the
  // tune line); 'all' keeps the chords. Capped so a symphony can't lock the page.
  function midiMelody(parsed, index, mode, maxNotes) {
    var src = [];
    if (index < 0) parsed.parts.forEach(function (part) { src = src.concat(part.notes); });
    else if (parsed.parts[index]) src = parsed.parts[index].notes.slice();
    src.sort(function (a, b) { return a.t - b.t || b.m - a.m; });
    var out = [];
    if (mode === 'all') {
      out = src.map(function (n) { return { m: n.m, t: n.t, d: n.d }; });
    } else {
      for (var i = 0; i < src.length; i++) {
        var n = src[i], last = out[out.length - 1];
        if (last && Math.abs(n.t - last.t) < 1e-3) continue;      // same instant: highest already kept
        if (last && last.t + last.d > n.t) last.d = Math.max(0.05, n.t - last.t);
        out.push({ m: n.m, t: n.t, d: n.d });
      }
    }
    var cap = maxNotes || 1200;
    if (out.length > cap) out.length = cap;
    var t0 = out.length ? out[0].t : 0, end = 0;
    out.forEach(function (n) { n.t -= t0; if (n.t + n.d > end) end = n.t + n.d; });
    return { notes: out, beats: end };
  }

  return {
    VERSION: VERSION, CFG: CFG,
    fft: fft, hzToMidi: hzToMidi, midiToHz: midiToHz, noteName: noteName,
    analyzeClip: analyzeClip, steadyWindows: steadyWindows, onsetTime: onsetTime,
    cutPcm: cutPcm, cutClip: cutClip, cleanSlice: cleanSlice,
    keyOf: keyOf, rankNotes: rankNotes, buildKeys: buildKeys, speciesRanges: speciesRanges,
    parseMelody: parseMelody, fitMelody: fitMelody, melodic: melodic, rollCall: rollCall, rumbleCut: rumbleCut,
    parseMidi: parseMidi, midiTunePart: midiTunePart, midiMelody: midiMelody
  };
});
