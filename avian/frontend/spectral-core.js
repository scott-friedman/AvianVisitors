// spectral-core.js — the ONE implementation of the bird-call STFT analysis.
//
// Loaded by index.html before apt.js (exposes window.AvianSpectral) AND
// required by the build-time signature generator in Node
// (avian/scripts/build-signatures.mjs via module.exports). Sharing one
// file means a species' CANONICAL bloom (precomputed from a clean
// xeno-canto reference clip at build time) is analyzed with byte-identical
// math to the LIVE per-recording pitch lines drawn in the browser — so they
// can never visually drift apart.
//
// Exposes: _fft, specNormLog, analyzeBuffer, and the SPEC_* constants.
// See SPECTRO-CONCEPTS-PLAN.md.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;     // Node build script
  if (typeof window !== 'undefined') window.AvianSpectral = api;                  // browser
})(this, function () {
  'use strict';

  // Minimal in-place Cooley-Tukey radix-2 FFT (n must be a power of 2).
  // Operates on parallel real/imag Float32Array buffers.
  function _fft(real, imag) {
    var n = real.length;
    var j = 0;
    for (var i = 0; i < n - 1; i++) {
      if (i < j) {
        var tr = real[i]; real[i] = real[j]; real[j] = tr;
        var ti = imag[i]; imag[i] = imag[j]; imag[j] = ti;
      }
      var k = n >> 1;
      while (k <= j) { j -= k; k >>= 1; }
      j += k;
    }
    for (var stage = 2; stage <= n; stage *= 2) {
      var half = stage >> 1;
      var ang = -2 * Math.PI / stage;
      var wR = Math.cos(ang), wI = Math.sin(ang);
      for (var sBase = 0; sBase < n; sBase += stage) {
        var cR = 1, cI = 0;
        for (var sb = 0; sb < half; sb++) {
          var a = sBase + sb;
          var b = a + half;
          var trA = real[b] * cR - imag[b] * cI;
          var tiA = real[b] * cI + imag[b] * cR;
          real[b] = real[a] - trA;
          imag[b] = imag[a] - tiA;
          real[a] = real[a] + trA;
          imag[a] = imag[a] + tiA;
          var nR = cR * wR - cI * wI;
          cI = cR * wI + cI * wR;
          cR = nR;
        }
      }
    }
  }

  // Bird band only (~1.8-8.5 kHz): excludes the low-frequency rumble/wind that
  // dominates real field recordings and the hiss/artifacts above ~9 kHz.
  var SPEC_FFT = 1024, SPEC_COLS = 240, SPEC_FLO = 1800, SPEC_FHI = 8500;

  // Hz -> 0..1 on a log warp across the bird band (bloom radius + line Y).
  function specNormLog(f) {
    if (f < SPEC_FLO) f = SPEC_FLO; else if (f > SPEC_FHI) f = SPEC_FHI;
    return Math.log(f / SPEC_FLO) / Math.log(SPEC_FHI / SPEC_FLO);
  }

  // Dominant-pitch RIDGE TRACKER (replaces the old spectral-centroid).
  //
  // The centroid is the energy-weighted *average* frequency per column. For a
  // clean whistle that equals the pitch, but for a raspy/broadband/multi-note
  // call it smears to a near-constant mid-band value — the line goes flat and
  // tells you nothing. Instead we find the actual brightest spectral peak in
  // each column and connect the peaks into a continuous ridge (a small greedy
  // Viterbi), so the line rides the note you'd hear it sweep. Columns with too
  // little energy are marked UNVOICED so the trace breaks in silence rather
  // than drawing a misleading line across the gaps.
  //
  // grid: COLS x bins denoised magnitudes (0..1). energy: per-column 0..1.
  // Returns { peakHz: Float32Array, voiced: Uint8Array }.
  function trackPitch(grid, energy, binLo, binHi, bins, nyq) {
    var COLS = grid.length, bin2hz = nyq / bins;
    var GATE = 0.06;     // energy below this (of the per-clip max) = unvoiced
    var LAMBDA = 1.5;    // continuity penalty per unit of log-frequency distance

    // Candidate peaks per column: up to 4 strongest local maxima, magnitudes
    // normalized to the column max so the strength term is comparable column
    // to column (quiet and loud notes compete fairly on shape, not loudness).
    var cand = [];
    for (var c = 0; c < COLS; c++) {
      var col = grid[c], cmax = 1e-9, b;
      for (b = binLo; b <= binHi; b++) if (col[b] > cmax) cmax = col[b];
      var peaks = [];
      for (b = binLo + 1; b < binHi; b++) {
        var v = col[b];
        if (v > col[b - 1] && v >= col[b + 1] && v > 0.18 * cmax) peaks.push({ bin: b, mag: v / cmax });
      }
      if (!peaks.length) { // broadband/silence: keep the argmax so we have a value
        var ab = binLo, am = 0;
        for (b = binLo; b <= binHi; b++) if (col[b] > am) { am = col[b]; ab = b; }
        peaks.push({ bin: ab, mag: 1 });
      }
      peaks.sort(function (x, y) { return y.mag - x.mag; });
      cand.push(peaks.slice(0, 4));
    }

    // Seed the walk at the highest-energy column (the most confident note) and
    // grow the ridge outward in both directions from there.
    var seed = 0, se = -1;
    for (c = 0; c < COLS; c++) if (energy[c] > se) { se = energy[c]; seed = c; }
    var pitchBin = new Float32Array(COLS);
    pitchBin[seed] = cand[seed][0].bin;
    function lf(bin) { return Math.log(Math.max(1, bin) * bin2hz); }
    function walk(from, to, step) {
      var prev = pitchBin[from];
      for (var c = from + step; c !== to; c += step) {
        var ps = cand[c], best = ps[0].bin, bestCost = Infinity, pl = lf(prev);
        for (var i = 0; i < ps.length; i++) {
          var cost = -ps[i].mag + LAMBDA * Math.abs(lf(ps[i].bin) - pl);
          if (cost < bestCost) { bestCost = cost; best = ps[i].bin; }
        }
        pitchBin[c] = best;
        // Only carry the continuity anchor through VOICED columns, so a silent
        // gap doesn't drag the ridge onto a noise blip.
        if (energy[c] >= GATE) prev = best;
      }
    }
    walk(seed, COLS, 1);
    walk(seed, -1, -1);

    var peakHz = new Float32Array(COLS), voiced = new Uint8Array(COLS);
    for (c = 0; c < COLS; c++) { peakHz[c] = pitchBin[c] * bin2hz; voiced[c] = energy[c] >= GATE ? 1 : 0; }
    return { peakHz: peakHz, voiced: voiced };
  }

  // Run one STFT over the whole clip -> the arrays every treatment needs:
  // a column x bin grid (denoised heatmap ground), per-column energy (0..1),
  // a smoothed dominant-pitch ridge + a voiced mask, plus peak/range/duration
  // readouts. binLo/binHi depend on the clip's sample rate, so they ride along.
  function analyzeBuffer(audioBuffer) {
    var samples = audioBuffer.getChannelData(0);
    var sr = audioBuffer.sampleRate;
    var FFT_SIZE = SPEC_FFT, bins = FFT_SIZE >> 1, nyq = sr / 2;
    var fHi = Math.min(SPEC_FHI, nyq);
    var binLo = Math.max(1, Math.floor(SPEC_FLO / nyq * bins));
    var binHi = Math.min(bins - 1, Math.ceil(fHi / nyq * bins));
    var COLS = SPEC_COLS;
    var win = new Float32Array(FFT_SIZE);
    for (var i = 0; i < FFT_SIZE; i++) {
      win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
    }
    // Normalize the clip to a 0.6 peak so quiet/distant and loud/close calls
    // get equal contrast. Fold the scale into the window step rather than
    // mutating the AudioBuffer (it's cached + shared with the atlas spectrograms).
    var mx = 1e-6;
    for (i = 0; i < samples.length; i++) { var av = samples[i]; if (av < 0) av = -av; if (av > mx) mx = av; }
    var scale = 0.6 / mx;
    var hop = Math.max(1, Math.floor((samples.length - FFT_SIZE) / Math.max(1, COLS - 1)));
    var pw = [], energy = new Float32Array(COLS);
    var binE = new Float32Array(bins);
    var re = new Float32Array(FFT_SIZE), im = new Float32Array(FFT_SIZE);
    // STFT -> a LINEAR POWER grid over the bird band. Loudness + pitch must be
    // derived from power, NOT a dB-compressed grid: log compression and 0..1
    // saturation flatten the real spectrum and, summed over a linear-frequency
    // band, over-weight the wide high-frequency region - which pinned every
    // dominant-pitch readout up near the ceiling (a robin "singing" at 7 kHz
    // when its power is plainly at 2.5 kHz). The dB heatmap for the visual is
    // derived from this grid AFTER denoising, near the end.
    for (var c = 0; c < COLS; c++) {
      var start = c * hop;
      for (var s = 0; s < FFT_SIZE; s++) {
        var idx = start + s;
        re[s] = (idx < samples.length ? samples[idx] * scale : 0) * win[s];
        im[s] = 0;
      }
      _fft(re, im);
      var pcol = new Float32Array(bins);
      for (var bn = binLo; bn <= binHi; bn++) pcol[bn] = re[bn] * re[bn] + im[bn] * im[bn];
      pw.push(pcol);
    }
    // Denoise: subtract a background spectrum estimated from the quietest ~25%
    // of frames (the gaps between syllables). Robust whether the bird sings 20%
    // of the clip (noisy field recording) or 80% (a clean reference trimmed to
    // the song) - unlike a per-bin temporal median, which erases a sustained
    // tone outright when the bird sings through most of the clip.
    var rawE = new Float32Array(COLS), bq;
    for (c = 0; c < COLS; c++) { var s2 = 0; for (bq = binLo; bq <= binHi; bq++) s2 += pw[c][bq]; rawE[c] = s2; }
    var order = [];
    for (c = 0; c < COLS; c++) order.push(c);
    order.sort(function (x, y) { return rawE[x] - rawE[y]; });
    var nq = Math.max(3, Math.floor(0.25 * COLS)), noise = new Float32Array(bins);
    for (var oi = 0; oi < nq; oi++) { var cc = order[oi]; for (bq = binLo; bq <= binHi; bq++) noise[bq] += pw[cc][bq]; }
    for (bq = binLo; bq <= binHi; bq++) noise[bq] /= nq;
    for (c = 0; c < COLS; c++) for (bq = binLo; bq <= binHi; bq++) { var pv = pw[c][bq] - noise[bq]; pw[c][bq] = pv < 0 ? 0 : pv; }
    // Per-column energy envelope for the VISUAL = sum of magnitude (sqrt power;
    // less spiky than raw power). Per-bin POWER feeds the dominant-note readout.
    for (c = 0; c < COLS; c++) {
      var e = 0;
      for (var bn3 = binLo; bn3 <= binHi; bn3++) { var pp = pw[c][bn3]; binE[bn3] += pp; e += Math.sqrt(pp); }
      energy[c] = e;
    }
    var emax = 1e-9;
    for (c = 0; c < COLS; c++) if (energy[c] > emax) emax = energy[c];
    for (c = 0; c < COLS; c++) energy[c] /= emax;
    // Dominant pitch via the ridge tracker (peaks from power, gate/seed from
    // the energy envelope), then energy-weighted smoothing (kills jitter in
    // quiet columns while preserving the loud, defining notes).
    var tracked = trackPitch(pw, energy, binLo, binHi, bins, nyq);
    var peakF = tracked.peakHz, voiced = tracked.voiced;
    var sm = new Float32Array(COLS);
    for (c = 0; c < COLS; c++) {
      var acc = 0, w = 0;
      for (var d = -3; d <= 3; d++) {
        var cc = c + d; if (cc < 0 || cc >= COLS) continue;
        var wt = energy[cc] + 0.05; acc += peakF[cc] * wt; w += wt;
      }
      sm[c] = w > 0 ? acc / w : peakF[c];
    }
    // Readouts from the cleaned per-bin energy: dominant frequency (loudest
    // bin) + 12th..88th percentile range.
    var gPF = SPEC_FLO, pkE = 0;
    for (var bn = binLo; bn <= binHi; bn++) if (binE[bn] > pkE) { pkE = binE[bn]; gPF = (bn / bins) * nyq; }
    var tot = 0; for (bn = binLo; bn <= binHi; bn++) tot += binE[bn];
    var cum = 0, loR = gPF, hiR = gPF, got = false;
    for (bn = binLo; bn <= binHi; bn++) {
      cum += binE[bn];
      if (!got && cum >= tot * 0.12) { loR = (bn / bins) * nyq; got = true; }
      if (cum >= tot * 0.88) { hiR = (bn / bins) * nyq; break; }
    }
    // dB heatmap ground for the per-row line, derived from the DENOISED power
    // (so the faint spectrogram under the trace shows the cleaned call).
    // 10*log10(power) == 20*log10(magnitude): same warm-ink mapping as before.
    var grid = [];
    for (c = 0; c < COLS; c++) {
      var dcol = new Float32Array(bins);
      for (bn = binLo; bn <= binHi; bn++) {
        var dv = (10 * Math.log10(pw[c][bn] + 1e-12) + 75) / 65;
        dcol[bn] = dv < 0 ? 0 : (dv > 1 ? 1 : dv);
      }
      grid.push(dcol);
    }
    return {
      grid: grid, energy: energy, peakSmooth: sm, voiced: voiced, cols: COLS, bins: bins,
      binLo: binLo, binHi: binHi,
      dur: audioBuffer.duration || (samples.length / sr),
      peakHz: gPF, loHz: loR, hiHz: hiR
    };
  }

  return {
    _fft: _fft,
    specNormLog: specNormLog,
    analyzeBuffer: analyzeBuffer,
    SPEC_FFT: SPEC_FFT, SPEC_COLS: SPEC_COLS, SPEC_FLO: SPEC_FLO, SPEC_FHI: SPEC_FHI
  };
});
