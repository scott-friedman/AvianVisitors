/* Night screens for the e-ink frame (?frame=1&night=<screen>).
 *
 * When the frame's time window holds no birds (a 1H window after dark), the
 * Worker screenshots one of these instead of an empty collage. It picks which
 * one (worker/src/night.js → nightPlan) and passes it as ?night=; this file
 * draws it from GET /api/night:
 *
 *   recap  "Today in the yard"  — the day's birds + a short recap
 *   star   "Bird of the day"    — one bird that earned it, big
 *   sky    "The yard is asleep" — night sky, the real moon, birds as silhouettes
 *   owl    "Heard tonight"      — whatever called after dark
 *
 * Laid out on a fixed 748×403 board: the part of the 800×480 panel the
 * frame's mat leaves visible (FRAME-MATTING-PLAN.md). The Worker renders at
 * exactly that size and the Pi places it 1:1; anywhere else (a browser
 * preview) the board is scaled to fit. Colours stay near the panel's seven
 * inks so the dither stays clean. Sets #night[data-ready="1"] when done —
 * the Worker waits for it before the screenshot.
 *
 * Does nothing unless ?night= is in the URL. Talks to nothing in apt.js.
 */
(function () {
  'use strict';
  var params;
  try { params = new URLSearchParams(location.search); } catch (e) { return; }
  var want = params.get('night');
  if (!want) return;
  var SCREENS = ['recap', 'star', 'sky', 'owl'];
  if (SCREENS.indexOf(want) < 0) want = 'recap';

  var W = 748, H = 403;
  var API = (window.AVIAN_API_BASE || '').replace(/\/+$/, '');
  var NIGHT = '#00006e';   // dithers to the panel's blue + black only
  var GOLD = '#ffd800';
  document.documentElement.classList.add('night-mode');

  // ---- styles -----------------------------------------------------------------
  var fontLink = document.createElement('link');
  fontLink.rel = 'stylesheet';
  fontLink.href = 'https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,opsz,wght@0,8..60,400;0,8..60,700;1,8..60,400&family=IBM+Plex+Mono:wght@600&display=block';
  document.head.appendChild(fontLink);

  var css = [
    'html.night-mode, html.night-mode body { background:#fff !important; margin:0; overflow:hidden; }',
    'html.night-mode body > *:not(#night) { display:none !important; }',
    '#night { position:fixed; left:0; top:0; width:' + W + 'px; height:' + H + 'px; transform-origin:0 0; overflow:hidden;',
    '  background:#fff; color:#1a1612; font-family:"Source Serif 4", Georgia, "DejaVu Serif", serif; }',
    '#night * { box-sizing:border-box; }',
    '#night .mono { font-family:"IBM Plex Mono", "DejaVu Sans Mono", monospace; font-weight:600; letter-spacing:.08em; text-transform:uppercase; font-size:13px; }',
    '#night h1 { margin:0; font-weight:700; line-height:1.02; }',
    '#night img.b { display:block; }',
    '#night .sil { filter:brightness(0); }',
    // recap
    '#night .r-flock { position:absolute; left:10px; top:10px; width:450px; height:383px; display:flex; flex-wrap:wrap; align-items:flex-end; align-content:center; justify-content:center; gap:4px 8px; }',
    '#night .r-side { position:absolute; right:18px; top:22px; width:262px; bottom:20px; display:flex; flex-direction:column; }',
    '#night .r-side h1 { font-size:34px; margin:8px 0 10px; }',
    '#night .r-big { font-size:19px; line-height:1.35; }',
    '#night .r-big b { font-size:24px; }',
    '#night .rule { height:3px; background:#1a1612; margin:14px 0 12px; width:60px; }',
    '#night .r-when { font-size:16px; line-height:1.3; display:grid; grid-template-columns:auto 1fr; gap:2px 10px; }',
    '#night .r-when .who { grid-column:2; font-size:14px; color:#4a3f31; margin-bottom:4px; }',
    '#night .r-foot { margin-top:auto; display:flex; gap:12px; align-items:center; font-size:17px; line-height:1.3; }',
    '#night .r-foot svg { flex:0 0 auto; }',
    '#night .r-foot b, #night .s-l b { white-space:nowrap; }',
    // sky
    '#night.sky { background:' + NIGHT + '; color:#fff; }',
    '#night .star { position:absolute; background:#fff; border-radius:50%; }',
    '#night .s-txt { position:absolute; left:34px; top:36px; width:470px; }',
    '#night .s-txt .mono { color:' + GOLD + '; margin-bottom:10px; }',
    '#night .s-txt h1 { font-size:40px; margin:0 0 12px; color:#fff; }',
    '#night .s-l { font-size:20px; line-height:1.45; }',
    '#night .s-l b { color:' + GOLD + '; }',
    '#night .s-moon { position:absolute; left:576px; top:30px; }',
    '#night .s-ground { position:absolute; left:0; bottom:0; width:' + W + 'px; height:118px; }',
    '#night .s-perch { position:absolute; display:flex; align-items:flex-end; }',
    // star
    '#night .t-hero { position:absolute; left:18px; top:14px; width:334px; height:300px; display:flex; align-items:center; justify-content:center; }',
    '#night .t-hero img { max-width:334px; max-height:300px; }',
    '#night .t-card { position:absolute; left:372px; top:24px; right:22px; }',
    '#night .t-card .mono { color:#d40000; }',
    '#night .t-card h1 { font-size:40px; margin:8px 0 2px; }',
    '#night .t-sci { font-style:italic; font-size:17px; color:#4a3f31; margin-bottom:12px; }',
    '#night .t-why { font-size:19px; line-height:1.4; }',
    '#night .t-facts { margin-top:12px; font-size:16px; line-height:1.55; display:grid; grid-template-columns:80px 1fr; }',
    '#night .t-strip { position:absolute; left:16px; right:16px; bottom:10px; height:70px; display:flex; align-items:flex-end; justify-content:center; gap:7px; border-top:2px solid #1a1612; padding-top:6px; }',
    '#night .t-strip img { height:50px; width:44px; object-fit:contain; }',
    '#night .t-strip .mono { align-self:center; margin-right:6px; white-space:nowrap; font-size:12px; color:#4a3f31; }',
    // owl
    '#night .o-disc { position:absolute; left:430px; top:24px; width:300px; height:300px; border-radius:50%; background:' + NIGHT + '; overflow:hidden; }',
    '#night .o-bird { position:absolute; left:440px; top:34px; width:280px; height:340px; display:flex; align-items:flex-end; justify-content:center; }',
    '#night .o-bird img { max-width:280px; max-height:340px; }',
    '#night .o-branch { position:absolute; left:380px; top:352px; width:368px; height:16px; background:#5a3a1a; border-radius:8px; transform:rotate(-3deg); }',
    '#night .o-txt { position:absolute; left:30px; top:32px; width:392px; }',
    '#night .o-txt .mono { color:#0030c0; }',
    '#night .o-txt h1 { font-size:40px; margin:10px 0 4px; }',
    '#night .o-times { font-size:21px; margin:8px 0 14px; line-height:1.5; }',
    '#night .o-times b { background:' + GOLD + '; padding:0 5px; white-space:nowrap; }',
    '#night .o-l { font-size:17px; line-height:1.45; }',
    '#night .o-also { margin-top:18px; display:flex; align-items:center; gap:10px; font-size:16px; line-height:1.35; }',
    '#night .o-also img { height:52px; max-width:70px; object-fit:contain; }'
  ].join('\n');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ---- helpers ------------------------------------------------------------------
  function el(tag, cls, html) {
    var e = document.createElement(tag);
    if (cls) e.className = cls;
    if (html != null) e.innerHTML = html;
    return e;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function slug(sci) {
    return String(sci).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  }
  // Mojo (the family dog) only exists in flight; everyone else perched.
  function artUrl(sci, pose) {
    var p = pose === 2 || sci === 'Canis volaticus' ? '-2' : '';
    return './assets/illustrations/' + slug(sci) + p + '.png';
  }
  var pending = [];
  // An <img> that removes itself if there's no art (Pages answers a missing
  // .png with a 200 HTML page, which fails to decode → onerror).
  function bird(sci, cls, pose) {
    var im = new Image();
    im.className = 'b' + (cls ? ' ' + cls : '');
    im.alt = '';
    pending.push(new Promise(function (res) {
      im.onload = function () { res(im); };
      im.onerror = function () { if (im.parentNode) im.parentNode.removeChild(im); im.dataset.gone = '1'; res(null); };
    }));
    im.src = artUrl(sci, pose);
    return im;
  }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : many); }
  // Deterministic sprinkle (same night → same stars, so a redraw doesn't shimmer).
  function rng(seedStr) {
    var h = 2166136261;
    for (var i = 0; i < seedStr.length; i++) { h ^= seedStr.charCodeAt(i); h = Math.imul(h, 16777619); }
    var s = (h >>> 0) || 1;
    return function () { s = (s * 16807) % 2147483647; return s / 2147483647; };
  }

  // The moon as it is tonight: a lit limb plus a terminator ellipse.
  function moonSvg(moon, r, dark, lit) {
    var k = moon ? moon.illum : 1, waxing = moon ? moon.waxing : true;
    var c = r + 2, top = c - r, bot = c + r;
    var tx = Math.abs(1 - 2 * k) * r;
    var gibbous = k > 0.5;
    // Lit limb, top → bottom, on the right when waxing (northern sky).
    var limbSweep = waxing ? 1 : 0;
    // Terminator, bottom → top, bulging into the dark side when gibbous.
    var termSweep = waxing ? (gibbous ? 1 : 0) : (gibbous ? 0 : 1);
    var d = 'M' + c + ' ' + top + ' A' + r + ' ' + r + ' 0 0 ' + limbSweep + ' ' + c + ' ' + bot +
            ' A' + tx.toFixed(1) + ' ' + r + ' 0 0 ' + termSweep + ' ' + c + ' ' + top + 'Z';
    var size = 2 * c;
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '" aria-hidden="true">' +
      '<circle cx="' + c + '" cy="' + c + '" r="' + (r + 1) + '" fill="' + dark + '"/>' +
      (k > 0.02 ? '<path d="' + d + '" fill="' + lit + '"/>' : '') + '</svg>';
  }

  // ---- screens --------------------------------------------------------------------
  function drawRecap(root, d) {
    var day = d.day, lull = d.phase === 'lull';
    var flock = el('div', 'r-flock');
    var list = day.species.slice(0, 24);
    // Mix big and small so the flock doesn't sort itself by size.
    var mixed = [];
    for (var i = 0, j = list.length - 1; i <= j; i++, j--) { mixed.push(list[i]); if (i !== j) mixed.push(list[j]); }
    mixed.forEach(function (s) {
      var im = bird(s.sci);
      im.dataset.n = s.n;
      flock.appendChild(im);
    });
    root.appendChild(flock);

    var title = day.is_today ? 'Today in<br>the yard' : esc(day.weekday) + '<br>in the yard';
    var side = el('div', 'r-side');
    var when = '';
    if (day.first_song) when += '<span>First song</span><b>' + esc(day.first_song.time) + '</b><span class="who">' + esc(day.first_song.com) + '</span>';
    if (day.last_call) when += '<span>' + (lull ? 'Latest' : 'Last call') + '</span><b>' + esc(day.last_call.time) + '</b><span class="who">' + esc(day.last_call.com) + '</span>';
    var foot = lull
      ? '<svg width="50" height="50" viewBox="0 0 50 50" aria-hidden="true"><circle cx="25" cy="25" r="12" fill="' + GOLD + '" stroke="#1a1612" stroke-width="2"/>' +
        [0, 45, 90, 135, 180, 225, 270, 315].map(function (a) {
          var r = a * Math.PI / 180;
          return '<line x1="' + (25 + 16 * Math.cos(r)).toFixed(1) + '" y1="' + (25 + 16 * Math.sin(r)).toFixed(1) + '" x2="' + (25 + 22 * Math.cos(r)).toFixed(1) + '" y2="' + (25 + 22 * Math.sin(r)).toFixed(1) + '" stroke="#e07000" stroke-width="3" stroke-linecap="round"/>';
        }).join('') + '</svg><div>Quiet right now.<br>Last bird at <b>' + esc(d.last_bird || '') + '</b>.</div>'
      : moonSvg(d.moon, 22, NIGHT, GOLD) + '<div>Quiet for the night.<br>First songs around <b>' + esc(d.first_songs) + '</b>.</div>';
    side.innerHTML =
      '<div class="mono">' + esc(lull ? 'So far today' : day.label) + '</div>' +
      '<h1>' + title + '</h1>' +
      '<div class="r-big"><b>' + day.kinds + '</b> ' + (day.kinds === 1 ? 'kind of bird' : 'kinds of birds') + '<br><b>' + day.calls.toLocaleString('en-US') + '</b> ' + (day.calls === 1 ? 'call' : 'calls') + ' heard</div>' +
      '<div class="rule"></div>' +
      '<div class="r-when">' + when + '</div>' +
      '<div class="r-foot">' + foot + '</div>';
    root.appendChild(side);
    return function fit() {
      // Size each bird by how chatty it was, then shrink the whole flock until it fits.
      var ims = [].slice.call(flock.querySelectorAll('img')).filter(function (im) { return !im.dataset.gone; });
      var max = Math.max.apply(null, ims.map(function (im) { return +im.dataset.n || 1; }).concat([1]));
      var lo = 10, hi = 60, k;
      function apply(scale) {
        ims.forEach(function (im) {
          var rel = Math.pow((+im.dataset.n || 1) / max, 0.42);
          im.style.height = Math.max(26, Math.round(scale * 3.2 * (0.35 + 0.65 * rel))) + 'px';
        });
      }
      for (var it = 0; it < 14; it++) {
        k = (lo + hi) / 2;
        apply(k);
        if (flock.scrollHeight <= flock.clientHeight && flock.scrollWidth <= flock.clientWidth) lo = k; else hi = k;
      }
      apply(lo);
    };
  }

  function drawSky(root, d) {
    root.classList.add('sky');
    var r = rng('sky' + (d.day ? d.day.date : ''));
    for (var i = 0; i < 70; i++) {
      var s = el('div', 'star'), z = r() < 0.2 ? 4 : r() < 0.5 ? 3 : 2;
      var x = r() * W, y = r() * 280;
      if (x > 560 && y < 170) continue; // keep the moon's patch clear
      s.style.cssText = 'left:' + x.toFixed(0) + 'px;top:' + y.toFixed(0) + 'px;width:' + z + 'px;height:' + z + 'px';
      root.appendChild(s);
    }
    var moon = el('div', 's-moon', moonSvg(d.moon, 58, NIGHT, '#fffbe6'));
    root.appendChild(moon);
    var day = d.day;
    var when = day && day.is_today ? 'today' : 'yesterday';
    var lines = day && day.kinds
      ? plural(day.kinds, 'kind of bird', 'kinds of birds') + ' came by ' + when + '.<br>'
      : '';
    lines += 'Sunrise ' + esc(d.sunrise.weekday) + ' <b>' + esc(d.sunrise.time) + '</b>,<br>first songs around <b>' + esc(d.first_songs) + '</b>.';
    root.appendChild(el('div', 's-txt',
      '<div class="mono">Sudbury · ' + esc(d.tonight) + ' night</div>' +
      '<h1>' + (day && day.kinds ? 'The yard is asleep' : 'The yard is quiet') + '</h1>' +
      '<div class="s-l">' + lines + '</div>'));
    root.appendChild(el('div', '', '<svg class="s-ground" viewBox="0 0 ' + W + ' 118" preserveAspectRatio="none" aria-hidden="true">' +
      '<path d="M0 84 C120 70 220 92 330 82 C450 72 560 88 ' + W + ' 76 L' + W + ' 118 L0 118Z" fill="#000"/>' +
      '<path d="M60 36 C200 30 420 38 700 28" stroke="#000" stroke-width="8" fill="none" stroke-linecap="round"/>' +
      '<path d="M700 28 L' + W + ' 10 M700 28 L' + W + ' 40 M60 36 L0 30 M60 36 L0 52" stroke="#000" stroke-width="10"/></svg>'));
    // Today's birds asleep on the branch, as silhouettes (Mojo stays home).
    var sleepers = (day ? day.species : []).filter(function (s) { return s.sci !== 'Canis volaticus'; }).slice(0, 9);
    var maxN = sleepers.length ? sleepers[0].n : 1;
    var xs = [110, 175, 238, 302, 372, 436, 498, 560, 622];
    var order = [3, 1, 5, 0, 6, 2, 7, 4, 8];
    sleepers.forEach(function (s, i) {
      var slot = order[i];
      var wrap = el('div', 's-perch');
      var x = xs[slot];
      // The branch runs from y≈36 (left) to y≈28 (right) in the 118-px ground.
      wrap.style.left = x + 'px';
      wrap.style.bottom = (118 - 36 + (x / W) * 8 - 2) + 'px';
      var im = bird(s.sci, 'sil');
      im.style.height = Math.round(40 + 26 * Math.pow(s.n / maxN, 0.4)) + 'px';
      wrap.appendChild(im);
      root.appendChild(wrap);
    });
  }

  function drawStar(root, d) {
    var s = d.star[0];
    var hero = el('div', 't-hero');
    hero.appendChild(bird(s.sci));
    root.appendChild(hero);
    root.appendChild(el('div', 't-card',
      '<div class="mono">Bird of the day</div>' +
      '<h1>' + esc(s.com) + '</h1>' +
      '<div class="t-sci">' + esc(s.sci) + '</div>' +
      '<div class="t-why">' + esc(s.reason) + '</div>' +
      '<div class="t-facts"><b>Heard</b><span>' + (s.n === 1 ? 'once' : s.n === 2 ? 'twice' : s.n + ' times') + (d.day.is_today ? ' today' : '') + '</span>' +
      '<b>When</b><span>' + esc(s.when) + '</span></div>'));
    var strip = el('div', 't-strip', '<span class="mono">' + (d.day.is_today ? 'Also today' : 'Also ' + esc(d.day.weekday)) + '</span>');
    d.day.species.filter(function (x) { return x.sci !== s.sci; }).slice(0, 13).forEach(function (x) {
      strip.appendChild(bird(x.sci));
    });
    root.appendChild(strip);
  }

  // One plain sentence for the birds most likely to be heard after dark here.
  var NIGHT_NOTES = {
    'Bubo virginianus': 'A deep, soft "hoo-h\'HOO-hoo-hoo". Great Horned Owls nest in midwinter, so late fall is when pairs start calling to each other.',
    'Strix varia': 'Barred Owls ask "who cooks for you, who cooks for you-all?" and often answer each other through the woods.',
    'Megascops asio': 'Eastern Screech-Owls whinny and trill softly. They are about the size of a robin.',
    'Aegolius acadicus': 'A steady, high "too-too-too", like a truck backing up, from an owl small enough to sit in your hand.',
    'Asio otus': 'Long-eared Owls give a low, slow "hoo" every few seconds, mostly in late winter.',
    'Branta canadensis': 'Geese often fly at night, honking to keep the flock together.',
    'Scolopax minor': 'A nasal "peent" from the ground, then a twittering flight high over the yard at dusk.',
    'Turdus migratorius': 'Robins are often the last to stop singing at night and the first to start in the morning.'
  };

  function drawOwl(root, d) {
    var c = d.callers[0];
    var disc = el('div', 'o-disc');
    var r = rng('owl' + c.sci + (d.day ? d.day.date : ''));
    for (var i = 0; i < 26; i++) {
      var s = el('div', 'star'), a = r() * Math.PI * 2, rr = Math.sqrt(r()) * 140, z = r() < 0.3 ? 4 : 3;
      s.style.cssText = 'left:' + (150 + rr * Math.cos(a)).toFixed(0) + 'px;top:' + (150 + rr * Math.sin(a)).toFixed(0) + 'px;width:' + z + 'px;height:' + z + 'px';
      disc.appendChild(s);
    }
    root.appendChild(disc);
    root.appendChild(el('div', 'o-branch'));
    var holder = el('div', 'o-bird');
    var im = bird(c.sci);
    holder.appendChild(im);
    root.appendChild(holder);
    // No painting for this bird yet: put tonight's moon in the disc instead.
    pending.push(pending[pending.length - 1].then(function (ok) {
      if (!ok) {
        root.removeChild(holder);
        root.querySelector('.o-branch').remove();
        var m = el('div', '', moonSvg(d.moon, 70, NIGHT, '#fffbe6'));
        m.style.cssText = 'position:absolute;left:506px;top:98px';
        root.appendChild(m);
      }
    }));
    var times = c.times.map(function (t) { return '<b>' + esc(t) + '</b>'; });
    var timeLine = times.length === 1 ? 'at ' + times[0]
      : 'at ' + times.slice(0, -1).join(', ') + ' and ' + times[times.length - 1];
    var note = NIGHT_NOTES[c.sci] || 'Heard after dark, when most birds are asleep.';
    var html = '<div class="mono">' + esc(d.heard_label || 'Heard tonight') + '</div><h1>' + esc(c.com) + '</h1>' +
      '<div class="o-times">' + timeLine + '</div><div class="o-l">' + esc(note) + '</div>';
    root.appendChild(el('div', 'o-txt', html));
    var others = d.callers.slice(1, 3);
    if (others.length) {
      var also = el('div', 'o-also');
      also.appendChild(bird(others[0].sci, '', 2));
      var words = others.map(function (o) { return esc(o.com) + ' at ' + esc(o.times[0]); }).join('<br>');
      also.appendChild(el('div', '', 'Also in the dark:<br>' + words));
      root.querySelector('.o-txt').appendChild(also);
    }
  }

  // ---- boot -----------------------------------------------------------------------
  function fitBoard(root) {
    var k = Math.min(window.innerWidth / W, window.innerHeight / H);
    root.style.transform = Math.abs(k - 1) < 0.01 ? '' : 'scale(' + k + ')';
  }
  function ready(root) { root.setAttribute('data-ready', '1'); }

  function start() {
    var root = el('div');
    root.id = 'night';
    document.body.appendChild(root);
    fitBoard(root);
    window.addEventListener('resize', function () { fitBoard(root); });
    var fetchData = fetch(API + '/api/night', { cache: 'no-store' }).then(function (r) {
      if (!r.ok) throw new Error('night api ' + r.status);
      return r.json();
    });
    var fonts = Promise.race([
      new Promise(function (res) { fontLink.onload = fontLink.onerror = res; }).then(function () {
        return document.fonts && document.fonts.ready;
      }),
      new Promise(function (res) { setTimeout(res, 4000); })
    ]);
    fetchData.then(function (d) {
      var screen = want;
      if (screen === 'star' && !(d.star && d.star.length)) screen = 'recap';
      if (screen === 'owl' && !(d.callers && d.callers.length)) screen = 'sky';
      if (screen === 'recap' && !(d.day && d.day.species.length)) screen = 'sky';
      root.dataset.screen = screen;
      var fit = ({ recap: drawRecap, star: drawStar, sky: drawSky, owl: drawOwl })[screen](root, d);
      return Promise.all([fonts, Promise.race([
        Promise.all(pending),
        new Promise(function (res) { setTimeout(res, 8000); })
      ])]).then(function () {
        // pending can grow while it settles (the owl's no-art fallback); one more pass.
        return Promise.all(pending);
      }).then(function () {
        if (typeof fit === 'function') fit();
        requestAnimationFrame(function () { ready(root); });
      });
    }).catch(function (err) {
      // No data: leave the board unready, so the Worker keeps the last good frame.
      console.error('[night]', err);
    });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
})();
