// day-feather.js — a day's song, drawn as a feather.
//
// Each day in the yard grows its own feather, and everything about it comes
// from that day (GET /api/day-songs → worker/src/day-shape.js):
//   kind     a lively day grows a broad, rounded body feather; a gentle day a
//            long, swept flight feather; a very quiet day a soft, curly down one
//   length   how many kinds of bird were heard (and, today, how far the day has got)
//   bend     which way the quill curves: did the day peak in the morning or evening
//   barbs    dawn at the quill, dusk at the tip; longer where that eighth of the
//            day was busier; a midday lull leaves a gap
//   colour   each eighth in the colour of the bird that led it (the site's --ch-*)
//   splits   a stop-start day comes apart in places, the way a real feather does
//   eye-spot a rare visitor, at the hour it called
// Scott chose the feather (2026-11-27) over bars ("less mechanical, bird
// inspired") and asked that no two days look alike. The words on the page say
// "song", not "feather": the feather is only its picture.
//
// draw(shape, opts) → an <svg> string. Each eighth's barbs are a <g class="e"
// data-k="0..7">, so the page can light the part of the day that is playing.
// Pure and deterministic (seeded by the date), so a day always looks the same.
(function (root) {
  'use strict';
  var W = 120, H = 48;

  function seeded(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    var s = (h >>> 0) % 2147483646 + 1;
    return function () { s = s * 16807 % 2147483647; return (s - 1) / 2147483646; };
  }
  function f1(n) { return Math.round(n * 10) / 10; }
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  // What kind of feather a day grows.
  function kindOf(shape) {
    if (!shape || !shape.calls) return null;
    if (shape.calls < 150) return 'down';
    return shape.mood === 'bright' ? 'contour' : 'flight';
  }

  function draw(shape, opts) {
    var o = opts || {};
    var hue = o.hue || function () { return 8; };
    var cls = 'feather' + (o.cls ? ' ' + o.cls : '');
    var label = o.label ? ' role="img" aria-label="' + esc(o.label) + '"' : ' aria-hidden="true"';
    var head = '<svg class="' + cls + '" viewBox="0 0 ' + W + ' ' + H + '"' + label + '>';
    var kind = kindOf(shape);
    if (!kind) {
      // Nothing heard yet: a bare quill, waiting.
      return head + '<path class="fq" d="M14,34 Q60,30 104,16"/></svg>';
    }
    var r = seeded(shape.date || 'day');
    var levels = shape.levels || [], P8 = levels.length || 8;
    var grow = o.grow == null ? 1 : Math.max(0.35, Math.min(1, o.grow));
    var len = Math.min(104, 62 + (shape.kinds || 0) * 1.7) * grow;
    var ang = -(8 + r() * 20) * Math.PI / 180;
    var patch = shape.patch || 0;
    var cx = 60, cy = 26, dx = Math.cos(ang) * len / 2, dy = Math.sin(ang) * len / 2;
    if (grow < 1) cx -= (104 - len) / 2 * 0.6;        // a young feather grows from the same place
    var S = [cx - dx, cy - dy], E = [cx + dx, cy + dy], nn = [-Math.sin(ang), Math.cos(ang)];
    var bend = (shape.peak === 'evening' ? -1 : 1) * (3 + r() * 5 + patch * 8) * (kind === 'flight' ? 1.3 : 1);
    var C = [cx + nn[0] * bend, cy + nn[1] * bend];
    function P(t) { var u = 1 - t; return [u * u * S[0] + 2 * u * t * C[0] + t * t * E[0], u * u * S[1] + 2 * u * t * C[1] + t * t * E[1]]; }
    function T(t) {
      var a = 2 * (1 - t) * (C[0] - S[0]) + 2 * t * (E[0] - C[0]), b = 2 * (1 - t) * (C[1] - S[1]) + 2 * t * (E[1] - C[1]), l = Math.hypot(a, b) || 1;
      return [a / l, b / l];
    }
    var t0 = 0.1, out = '';
    // The fluff at the base.
    var nf = 3 + Math.floor(r() * 4);
    for (var q = 0; q < nf; q++) {
      var tq = 0.03 + r() * 0.07, pq = P(tq), tg0 = T(tq), sd0 = r() > 0.5 ? 1 : -1, nq = [tg0[1] * sd0, -tg0[0] * sd0], Lq = 3 + r() * 5;
      out += '<path class="ff" d="M' + f1(pq[0]) + ',' + f1(pq[1]) + ' q' + f1(nq[0] * Lq * 0.6 - tg0[0] * 2) + ',' + f1(nq[1] * Lq * 0.6 - tg0[1] * 2) + ' ' +
        f1(nq[0] * Lq + tg0[0] * (r() - 0.5) * 4) + ',' + f1(nq[1] * Lq + tg0[1] * (r() - 0.5) * 4) + '"/>';
    }
    out += '<path class="fq" d="M' + f1(S[0]) + ',' + f1(S[1]) + ' Q' + f1(C[0]) + ',' + f1(C[1]) + ' ' + f1(E[0]) + ',' + f1(E[1]) + '"/>';
    // Where the vane has come apart.
    var nRuf = Math.round(patch * 10 + r() * 1.5), ruf = [];
    for (q = 0; q < nRuf; q++) ruf.push({ t: t0 + r() * (0.85 - t0), sd: r() > 0.5 ? 1 : -1 });
    var per = kind === 'down' ? 4 : 7, eye = '';
    for (var k = 0; k < P8; k++) {
      // The midday lull thins to a gap in the vane.
      var inLull = shape.lull >= 0 && (k === shape.lull || k === shape.lull + 1);
      var v = (levels[k] || 0) * (inLull ? 0.2 : 1);
      var g = '';
      if (v < 0.04) { out += '<g class="e" data-k="' + k + '"></g>'; continue; }
      var lead = shape.lead && shape.lead[k];
      // The leader's colour, deepened a little with ink so the pastel palette
      // still reads on paper; busier parts carry more of the colour.
      var mix = Math.round(58 + v * 34);
      var stroke = 'color-mix(in srgb, var(--ch-' + (lead ? hue(lead) : 8) + ') ' + mix + '%, var(--ink-2))';
      for (var j = 0; j < per; j++) {
        var t = t0 + (k + (j + 0.5) / per) / P8 * (1 - t0), p = P(t), tg = T(t), u0 = (t - t0) / (1 - t0);
        var prof = kind === 'flight' ? Math.pow(Math.sin(Math.PI * Math.min(0.97, u0 * 0.9 + 0.08)), 1.1)
          : kind === 'contour' ? Math.pow(Math.sin(Math.PI * Math.min(0.92, u0 * 0.8 + 0.12)), 0.5)
            : 0.7 + 0.3 * Math.sin(Math.PI * t);
        for (var side = -1; side <= 1; side += 2) {
          var w = kind === 'flight' ? (side < 0 ? 0.45 : 1.1) : kind === 'contour' ? 1 : 0.9;
          var L = (kind === 'down' ? (7 + v * 9) : (3 + v * 15)) * prof * w * (0.9 + r() * 0.2) * (0.75 + 0.25 * grow);
          var A = kind === 'contour' ? 0.95 : kind === 'flight' ? 0.5 : 0.6 + r() * 0.7;
          for (var x = 0; x < ruf.length; x++) if (ruf[x].sd === side && Math.abs(ruf[x].t - t) < 0.025) { A += 0.35; L *= 0.82; }
          var n = [tg[1] * side, -tg[0] * side];
          var e = [p[0] + tg[0] * L * Math.cos(A) + n[0] * L * Math.sin(A), p[1] + tg[1] * L * Math.cos(A) + n[1] * L * Math.sin(A)];
          var cc = kind === 'down' ? (r() - 0.3) * 0.8 : 0.2;
          var c = [p[0] + n[0] * L * 0.5 + tg[0] * L * cc, p[1] + n[1] * L * 0.5 + tg[1] * L * cc];
          var d = 'M' + f1(p[0]) + ',' + f1(p[1]) + ' Q' + f1(c[0]) + ',' + f1(c[1]) + ' ' + f1(e[0]) + ',' + f1(e[1]);
          if (kind === 'down') d += ' q' + f1(tg[0] * 2 + n[0] * 1.5) + ',' + f1(tg[1] * 2 + n[1] * 1.5) + ' ' + f1(tg[0] - n[0] * 0.5) + ',' + f1(tg[1] - n[1] * 0.5);
          g += '<path class="fb" style="stroke:' + stroke + '" d="' + d + '"/>';
          if (shape.rare && shape.rare.part === k && j === (per >> 1) && side > 0) {
            var ex = p[0] + n[0] * L * 0.55 + tg[0] * L * 0.3, ey = p[1] + n[1] * L * 0.55 + tg[1] * L * 0.3, er = Math.max(1.6, L * 0.18);
            eye = '<ellipse class="fe" cx="' + f1(ex) + '" cy="' + f1(ey) + '" rx="' + f1(er * 1.3) + '" ry="' + f1(er) + '" transform="rotate(' + f1(ang * 180 / Math.PI) + ' ' + f1(ex) + ' ' + f1(ey) + ')" style="fill:var(--ch-' + hue(shape.rare.sci) + ')"/>' +
              '<circle class="fp" cx="' + f1(ex) + '" cy="' + f1(ey) + '" r="' + f1(er * 0.4) + '"/>';
          }
        }
      }
      if (eye && shape.rare.part === k) { g += eye; eye = ''; }
      out += '<g class="e" data-k="' + k + '">' + g + '</g>';
    }
    return head + out + '</svg>';
  }

  // Lights the part of the day that is playing (k = 0..7, or -1 for none) on
  // every drawing inside `scope` that is marked with data-date="date".
  function light(scope, date, k) {
    if (!scope) return;
    var svgs = scope.querySelectorAll('[data-date="' + date + '"] svg.feather, svg.feather[data-date="' + date + '"]');
    for (var i = 0; i < svgs.length; i++) {
      svgs[i].classList.toggle('playing', k >= 0);
      var es = svgs[i].querySelectorAll('.e');
      for (var j = 0; j < es.length; j++) es[j].classList.toggle('lit', +es[j].getAttribute('data-k') === k);
    }
  }

  var api = { draw: draw, light: light, kindOf: kindOf };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AvianFeather = api;
})(typeof self !== 'undefined' ? self : this);
