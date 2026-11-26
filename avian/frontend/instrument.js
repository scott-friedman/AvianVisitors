// instrument.js — the "play" view: the yard's own recordings as an instrument.
//
// Every key on the keyboard is a real note that a real bird sang into the
// microphone. This file is the page side of that: it asks the worker which
// clips exist (GET /api/clips), downloads them a few at a time, has
// sampler-core.js find the notes in each one (in a Web Worker), and turns the
// result into three things you can play:
//   - a keyboard  (a different bird on every key)
//   - a songbook  (public-domain tunes, your own typed tune, or a MIDI file,
//                  laid onto whatever notes the birds really have)
//   - voices      (one pad per species: its call, exactly as recorded)
//
// TRUE SOUNDS ONLY. Playback is the recorded samples and nothing else: no
// synthesis, no stretching, no reverb. The one liberty is "fine-tune", which
// plays a note up to ±50 cents fast or slow so it lands on its key — and it
// can be switched off, after which every note is exactly as the bird sang it.
// The other controls only choose WHICH real sound plays (how much of the call
// around the note; which bird takes the key).
//
// Loaded after apt.js (which provides window.AvianApp and calls
// AvianPlay.show()/hide() as the view slides in and out). Nothing here runs —
// no network, no audio — until the play view is first opened.
// See CLAUDE.md → "The play view".
(function () {
  'use strict';
  var S = window.AvianSampler, APP = window.AvianApp, BOOK = window.AvianSongbook || [];
  var wrap = document.getElementById('playWrap');
  if (!S || !APP || !wrap) return;
  if (document.documentElement.classList.contains('frame')) return;   // the e-ink screenshot never plays

  var esc = APP.esc, API = APP.api || '';
  function $(id) { return document.getElementById(id); }
  function clamp(x, a, b) { return x < a ? a : (x > b ? b : x); }
  function plural(n, one, many) { return n + ' ' + (n === 1 ? one : (many || one + 's')); }
  function ls(k, d) { return APP.readLS('bird:play:' + k, d); }
  function lsSet(k, v) { APP.writeLS('bird:play:' + k, String(v)); }
  var COARSE = false;
  try { COARSE = !!(window.matchMedia && window.matchMedia('(hover: none), (pointer: coarse)').matches); } catch (e) {}

  // ------------------------------------------------------------ settings ----
  var DECODE_RATE = 32000;        // clips are decoded to this (plenty for birdsong)
  // Recordings listened to per bird: the clearest few first, so the keyboard is
  // playable quickly; then, while the tab stays open, a few more in the
  // background for more notes and more birds to share each one (cached, so a
  // return visit downloads nothing).
  var DEPTHS = [3, 8];
  var NET_PAR = 4;                // downloads in flight at once
  var TARGET_RMS = 0.2;           // every note is levelled to about this loudness
  var MAX_VOICES = 28;
  // How much of the bird's call plays around a note ("sings on"): it starts on
  // the note at its body (b0, minus a little lead-in so nothing clicks), then
  // the bird carries on with the rest of its call (to z1) for as long as the
  // note lasts or the key is held. One syllable is a pitch; the run after it
  // is what makes it a bird. (The shorter cuts sampler-core also marks, t0–t1
  // and s0–s1, were options once; Scott settled on this one, 2026-11-25.)
  var CUT = ['b0', 'z1', 0.012, 0];
  // Tuned on the yard's real recordings by rendering the songbook and checking,
  // note by note, that the written pitch is still the loudest thing where each
  // note starts (see CLAUDE.md → "The play view"). With these, a tune in "sings
  // on" holds its notes as well as the short "balanced" cut does.
  var SING = {
    minOut: 0.6,      // a tapped key gives at least this much of the bird (s)
    ring: 0.30,       // a tune note rings on past its written length: half as long again,
    ringShare: 0.5,   //    but no more than `ring` and no less than `ringMin` (s), so a quick
    ringMin: 0.08,    //    passage is not smeared and a slow one lets the bird carry on
    last: 1.2,        // ...and the last note of a tune this much longer: let it finish its call
    front: 0.45,      // the loudest thing after the note sits this far under it (× its level)
    tailMin: 0.06,    // ...however loud the rest of the call is (a faint note before a shout)
    duck: 0.035,      // how quickly it drops back once the note is over (s)
    release: 0.14     // the fade when a note is let go (s)
  };

  // A light polish on every note (Scott, 2026-11-26: some sounds were "harsh";
  // he asked for them to be "more pleasing to listen to while maintaining their
  // distinctive sounds"). Nothing is added and nothing is re-pitched; three
  // things are taken down a little:
  //   1. the edge of a note: it fades in over `attack` instead of starting dead
  //      on its loudest sample, which is what clicks and spits;
  //   2. the top end: a gentle tilt (`shelf`, from `shelfAt` × the note up) takes
  //      the rasp and hiss above the bird's first overtones down a few dB, and
  //      a soft roll-off (`lpAt` × the note, between lpMin and lpMax) takes off
  //      the mp3 fizz above everything the bird sang. A buzzy or noisy note
  //      (low `tone`, high `bg`) gets up to `shelfRough` instead of `shelfClean`;
  //   3. loudness: a quiet note is lifted at most `maxBoost`× to sit with the
  //      others (it was 2.5×, which lifted its hiss with it).
  // The fundamental and its next overtone are never touched, so each bird
  // keeps its own voice. The voice pads stay exactly as recorded.
  var POLISH = {
    attack: 0.012,                         // s
    shelfAt: 2.4, shelfClean: -3, shelfRough: -7,   // × note Hz, dB
    lpAt: 5, lpMin: 6000, lpMax: 14000,    // × note Hz, Hz
    maxBoost: 1.8
  };
  function polishOf(n) {
    var rough = clamp(Math.max((0.9 - (n.tone == null ? 0.9 : n.tone)) / 0.3, ((n.bg == null ? -20 : n.bg) + 20) / 14), 0, 1);
    return {
      shelfHz: clamp(n.hz * POLISH.shelfAt, 1500, 10000),
      shelfDb: POLISH.shelfClean + (POLISH.shelfRough - POLISH.shelfClean) * rough,
      lpHz: clamp(n.hz * POLISH.lpAt, POLISH.lpMin, POLISH.lpMax)
    };
  }

  var state = { inited: false, visible: false, failed: false, depth: 0 };

  // ---------------------------------------------------------------- audio ----
  var ctx = null, master = null, voices = [];
  function audio() {
    if (ctx) {
      if (ctx.state !== 'running' && ctx.resume) { try { ctx.resume(); } catch (e) {} }
      return ctx;
    }
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // iOS: without this the ringer switch silences Web Audio.
    try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
    try { ctx = new AC({ latencyHint: 'interactive' }); } catch (e) { try { ctx = new AC(); } catch (e2) { return null; } }
    master = ctx.createGain();
    master.gain.value = 0.9;
    // A gentle safety limiter for chords and fast runs: it only turns peaks down.
    var comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.knee.value = 10; comp.ratio.value = 6;
    comp.attack.value = 0.003; comp.release.value = 0.15;
    master.connect(comp); comp.connect(ctx.destination);
    return ctx;
  }
  // Browsers only let a page make sound after a tap or key press; iOS wants that
  // to be the END of the tap. Resume on every kind of gesture, cheaply.
  ['pointerup', 'touchend', 'click', 'keydown'].forEach(function (ev) {
    document.addEventListener(ev, function () {
      if (ctx && ctx.state !== 'running' && state.visible) { try { ctx.resume(); } catch (e) {} }
    }, { passive: true, capture: true });
  });

  function bufferOf(item) {       // item: a note or a phrase carrying 16-bit pcm
    if (item.buf) return item.buf;
    if (!ctx || !item.pcm || !item.pcm.length) return null;
    var b = ctx.createBuffer(1, item.pcm.length, item.sr), d = b.getChannelData(0), p = item.pcm;
    for (var i = 0; i < p.length; i++) d[i] = p[i] / 32768;
    return (item.buf = b);
  }
  // shape (the "sing" cut): { body, tail, held }. The first `body` seconds are
  // the note and play at full level; after that the rest of the call drops to
  // level × tail, so the note stays in front of what follows it.
  // soft (notes only): { shelfHz, shelfDb, lpHz } from polishOf().
  function startVoice(buf, when, offset, srcDur, rate, level, hpHz, maxOut, shape, soft) {
    var c = ctx, t = Math.max(c.currentTime + 0.004, when || 0);
    var outDur = srcDur / rate;
    if (maxOut != null && maxOut < outDur) outDur = Math.max(0.05, maxOut);
    var src = c.createBufferSource();
    src.buffer = buf; src.playbackRate.value = rate;
    // Rumble below the bird (wind, traffic, the house) is not part of its voice.
    // On the yard's real clips a hum at 300-400 Hz was often LOUDER than a high
    // note riding over it, so this is a steep cut (two stages, 24 dB/octave)
    // placed more than an octave under the note: nothing the bird sang is lost.
    var hp = c.createBiquadFilter(), hp2 = c.createBiquadFilter();
    hp.type = hp2.type = 'highpass';
    hp.frequency.value = hp2.frequency.value = hpHz;
    hp.Q.value = 0.541; hp2.Q.value = 1.307;
    var g = c.createGain(), gate = c.createGain();
    var att = soft ? POLISH.attack : (offset > 0.002 ? 0.005 : 0.002), rel = Math.min(shape ? SING.release : 0.045, outDur * 0.4);
    var sus = level;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(level, t + att);
    var bodyEnd = shape ? Math.max(att, shape.body) : 0, faded = false;
    if (shape && shape.tail < 1 && bodyEnd + SING.duck < outDur - rel) {
      g.gain.setValueAtTime(level, t + bodyEnd);
      g.gain.linearRampToValueAtTime(level * shape.tail, t + bodyEnd + SING.duck);
      sus = level * shape.tail;
    } else if (shape && shape.tail < 1 && bodyEnd < outDur - 0.03) {
      // No room to settle at the quieter level: fade from the end of the note.
      g.gain.setValueAtTime(level, t + bodyEnd);
      g.gain.linearRampToValueAtTime(0, t + outDur);
      faded = true;
    }
    if (!faded) {
      g.gain.setValueAtTime(sus, t + Math.max(att, outDur - rel));
      g.gain.linearRampToValueAtTime(0, t + outDur);
    }
    src.connect(hp); hp.connect(hp2);
    var last = hp2;
    if (soft) {
      var sh = c.createBiquadFilter(), lp = c.createBiquadFilter();
      sh.type = 'highshelf'; sh.frequency.value = soft.shelfHz; sh.gain.value = soft.shelfDb;
      lp.type = 'lowpass'; lp.frequency.value = Math.min(soft.lpHz, c.sampleRate * 0.45); lp.Q.value = 0.5;
      hp2.connect(sh); sh.connect(lp); last = lp;
    }
    last.connect(g); g.connect(gate); gate.connect(master);
    src.start(t, offset, srcDur + 0.05);
    src.stop(t + outDur + 0.03);
    var v = { src: src, g: g, gate: gate, at: t, dur: outDur, held: !!(shape && shape.held) };
    voices.push(v);
    src.onended = function () {
      var i = voices.indexOf(v);
      if (i >= 0) voices.splice(i, 1);
      try { g.disconnect(); gate.disconnect(); } catch (e) {}
    };
    if (voices.length > MAX_VOICES) killVoice(voices[0]);
    return v;
  }
  function killVoice(v) {
    try {
      var now = ctx.currentTime;
      v.g.gain.cancelScheduledValues(now);
      v.g.gain.setTargetAtTime(0, now, 0.012);
      v.src.stop(now + 0.07);
    } catch (e) {}
  }
  // A held note (a key kept down) is let go: it fades from here, though never
  // before it has had SING.minOut to be heard as a bird.
  function letGo(v) {
    if (!v || !v.held || v.gone || !ctx) return;
    v.gone = true;
    var at = Math.max(ctx.currentTime, v.at + SING.minOut - SING.release);
    if (at + SING.release >= v.at + v.dur) return;          // it is ending by itself anyway
    try {
      v.gate.gain.setValueAtTime(1, at);
      v.gate.gain.linearRampToValueAtTime(0, at + SING.release);
      v.src.stop(at + SING.release + 0.03);
    } catch (e) {}
    v.dur = at + SING.release - v.at;
  }
  // One note. `when` is an AudioContext time (0 = now); maxOut is how long the
  // note is written to last (the tune player passes it); `held` means a key is
  // being held down and letGo() will end it. Returns { at, dur, … }.
  function playNote(n, when, maxOut, held) {
    if (!n || !audio()) return null;
    var buf = bufferOf(n);
    if (!buf) return null;
    var len = buf.duration;                                 // the samples run on past the syllable
    var from = n[CUT[0]] != null ? n[CUT[0]] : n.s0;
    var a = Math.max(0, (from - n.t0) - CUT[2]), z = len;
    if (z - a < 0.03) a = 0;
    // "Fine-tune", always on: a note is played at most ±50 cents fast or slow
    // (under 3 % speed) so it lands on its key. Nothing more.
    var rate = Math.pow(2, -clamp(n.cents, -50, 50) / 1200);
    var level = clamp(TARGET_RMS / (n.rms || TARGET_RMS), 0.2, POLISH.maxBoost);
    // "Sings on". The note lands on pitch and at full level; then the bird
    // carries on with its call, a step behind, until the note is over.
    // In a tune the note stays in front only for as long as it is written: a
    // long-bodied bird must not sit at full level over the next note.
    var body = Math.max(0.06, ((n.b1 != null ? n.b1 : n.s1) - n.t0 - a) / rate);
    if (maxOut != null) body = Math.min(body, Math.max(0.06, maxOut - 0.07));
    var tail = n.tail > 0 ? clamp(SING.front * n.rms / n.tail, SING.tailMin, 1) : 1;
    var out = held ? null : (maxOut != null ? maxOut + clamp(SING.ringShare * maxOut, SING.ringMin, SING.ring) : SING.minOut);
    return startVoice(buf, when, a, z - a, rate, level, S.rumbleCut(n.hz), out, { body: body, tail: tail, held: !!held }, polishOf(n));
  }
  function playPhrase(ph) {
    if (!ph || !audio()) return null;
    var buf = bufferOf(ph);
    if (!buf) return null;
    return startVoice(buf, 0, 0, buf.duration, 1, clamp(0.16 / (ph.rms || 0.16), 0.2, 2.5), 110, null);
  }
  function stopVoices() { voices.slice().forEach(killVoice); }

  // Only one thing plays at a time across the whole site (apt.js's coordinator):
  // starting here stops an atlas/modal recording, and vice versa.
  function stopEverything() { stopSong(); stopVoices(); }
  function claim() { APP.audioClaim(stopEverything); }

  // ---------------------------------------------------------------- cache ----
  // What the analysis found in each clip (notes + their samples) is kept in
  // IndexedDB, so a return visit rebuilds the keyboard without downloading or
  // re-analysing anything. Keyed on the clip's file name + the engine version.
  var dbP = null;
  function db() {
    if (dbP) return dbP;
    dbP = new Promise(function (res) {
      try {
        var rq = indexedDB.open('avian-play', 1);
        rq.onupgradeneeded = function () { rq.result.createObjectStore('clips', { keyPath: 'file' }); };
        rq.onsuccess = function () { res(rq.result); };
        rq.onerror = rq.onblocked = function () { res(null); };
      } catch (e) { res(null); }
    });
    return dbP;
  }
  function cacheGet(file) {
    return db().then(function (d) {
      if (!d) return null;
      return new Promise(function (res) {
        try {
          var rq = d.transaction('clips').objectStore('clips').get(file);
          rq.onsuccess = function () { res(rq.result || null); };
          rq.onerror = function () { res(null); };
        } catch (e) { res(null); }
      });
    });
  }
  function cachePut(rec) {
    db().then(function (d) {
      if (!d) return;
      try { d.transaction('clips', 'readwrite').objectStore('clips').put(rec); } catch (e) {}
    });
  }
  // Once a session: drop results from an older engine, and clips not used in 45 days.
  function cacheSweep() {
    db().then(function (d) {
      if (!d) return;
      try {
        var old = Date.now() - 45 * 864e5;
        var rq = d.transaction('clips', 'readwrite').objectStore('clips').openCursor();
        rq.onsuccess = function () {
          var cur = rq.result;
          if (!cur) return;
          if (cur.value.v !== S.VERSION || !(cur.value.at > old)) cur.delete();
          cur.continue();
        };
      } catch (e) {}
    });
  }

  // ------------------------------------------------------------- analysis ----
  var workers = [], workerOk = true, jobs = {}, jobSeq = 0, wNext = 0;
  function startWorkers() {
    var el = document.querySelector('script[src*="sampler-core.js"]');
    if (!el || !el.src || !window.Worker) { workerOk = false; return; }
    var n = (navigator.hardwareConcurrency || 2) >= 4 ? 2 : 1;
    try {
      for (var i = 0; i < n; i++) {
        var w = new Worker(el.src);     // the same file (and ?v= hash) the page loaded
        w.onmessage = function (ev) {
          var m = ev.data || {}, done = jobs[m.id];
          if (done) { delete jobs[m.id]; done(m.result); }
        };
        w.onerror = function () {       // fall back to the page thread, and retry what was pending
          workerOk = false;
          var pending = jobs; jobs = {};
          Object.keys(pending).forEach(function (id) { pending[id]({ error: 'worker', retry: true, notes: [], phrase: null }); });
        };
        workers.push(w);
      }
    } catch (e) { workerOk = false; }
  }
  function analyze(pcm, sr, opts) {
    if (workerOk && workers.length) {
      return new Promise(function (res) {
        var id = ++jobSeq;
        jobs[id] = res;
        workers[wNext++ % workers.length].postMessage({ cmd: 'analyze', id: id, pcm: pcm, sr: sr, opts: opts }, [pcm.buffer]);
      });
    }
    return new Promise(function (res) {
      setTimeout(function () {          // let the page paint between clips
        var r;
        try { r = S.analyzeClip(pcm, sr, opts); S.cutClip(pcm, sr, r, opts); }
        catch (e) { r = { error: String((e && e.message) || e), notes: [], phrase: null }; }
        res(r);
      }, 0);
    });
  }

  var decCtx = null, decRate = DECODE_RATE;
  function decoder() {
    if (decCtx) return decCtx;
    var OC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    var rates = [DECODE_RATE, 44100, 48000];
    for (var i = 0; OC && i < rates.length; i++) {
      try { decCtx = new OC(1, 2, rates[i]); decRate = rates[i]; return decCtx; } catch (e) {}
    }
    var live = audio();                 // last resort: the playback context can decode too
    if (live) { decCtx = live; decRate = live.sampleRate; }
    return decCtx;
  }
  function decode(arrayBuf) {
    return new Promise(function (res, rej) {
      var d = decoder();
      if (!d) return rej(new Error('this browser cannot decode audio'));
      var ok = function (ab) {
        var pcm = new Float32Array(ab.length), nc = ab.numberOfChannels;
        for (var c = 0; c < nc; c++) {
          var ch = ab.getChannelData(c);
          for (var i = 0; i < ch.length; i++) pcm[i] += ch[i] / nc;
        }
        res({ pcm: pcm, sr: ab.sampleRate });
      };
      try {
        var p = d.decodeAudioData(arrayBuf, ok, rej);
        if (p && p.catch) p.catch(rej);
      } catch (e) { rej(e); }
    });
  }

  // One clip → { file, v, sr, at, ph, notes: [...with pcm], phrase }.
  function loadClip(task) {
    var file = task.clip.file;
    return cacheGet(file).then(function (rec) {
      if (rec && rec.v === S.VERSION && (rec.ph || !task.phrase)) {
        stats.cached++;
        if (!(rec.at > Date.now() - 3 * 864e5)) { rec.at = Date.now(); cachePut(rec); }
        return rec;
      }
      return fetch(API + '/api/recording?file=' + encodeURIComponent(file))
        .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.arrayBuffer(); })
        .then(decode)
        .then(function (d) { return analyze(d.pcm, d.sr, { cut: true, phrase: !!task.phrase }); })
        .then(function (res) {
          if (res.retry && !task.retried) { task.retried = true; return loadClip(task); }
          if (res.error) throw new Error(res.error);
          var out = {
            file: file, v: S.VERSION, sr: res.sr, at: Date.now(), ph: !!task.phrase,
            notes: res.notes, phrase: (res.phrase && res.phrase.pcm) ? res.phrase : null
          };
          cachePut(out);
          return out;
        });
    });
  }

  // --------------------------------------------------------------- loader ----
  var species = {}, order = [];          // sci → species record; most-heard first
  var queue = [], active = 0, inflight = {};
  var stats = { want: 0, done: 0, failed: 0, cached: 0 };

  function enqueue(sp, clip, front, phrase) {
    if (inflight[clip.file]) return;
    inflight[clip.file] = 1;
    stats.want++;
    var task = { sp: sp, clip: clip, phrase: phrase };
    if (front) queue.unshift(task); else queue.push(task);
  }
  function pump() {
    while (state.visible && active < NET_PAR && queue.length) runTask(queue.shift());
    renderStatus();
  }
  function runTask(task) {
    active++;
    loadClip(task).then(function (rec) {
      ingest(task.sp, rec);
    }, function () {
      stats.failed++;
      task.sp.done[task.clip.file] = -1;   // an expired or unreadable clip: skip it
    }).then(function () {
      active--; stats.done++;
      delete inflight[task.clip.file];
      // The last clip is in: show the finished board now, not a beat later.
      if (!queue.length && !active) {
        if (dirtyT) rebuild();
        listenDeeper();
      }
      pump();
    });
  }
  // Round-robin by rank: every bird's clearest clip first, then every bird's
  // second, and so on, so the keyboard fills in evenly across the whole flock.
  function planFlock() {
    var depth = DEPTHS[state.depth];
    for (var r = 0; r < depth; r++) {
      for (var i = 0; i < order.length; i++) {
        var sp = species[order[i]], clip = sp.clips[r];
        if (clip && !sp.done[clip.file]) enqueue(sp, clip, false, r < 2);
      }
    }
  }
  // The first few clips per bird are in: carry on, quietly, with a few more.
  function listenDeeper() {
    if (state.depth + 1 >= DEPTHS.length || !order.length || state.failed) return false;
    state.depth++;
    planFlock();
    return queue.length > 0;
  }

  function loadIndex() {
    state.failed = false;
    renderStatus('finding the recordings…');
    return fetch(API + '/api/clips')
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) {
        (j.species || []).forEach(function (s) {
          // Unconfirmed species (one faint detection) may be a misidentification:
          // they stay off the instrument until the box is sure of them.
          if (!s.confirmed || !s.clips || !s.clips.length || species[s.sci]) return;
          species[s.sci] = {
            sci: s.sci, com: s.com || s.sci, n: s.n || 0, hue: APP.hue(s.sci),
            clips: s.clips.slice(), done: {}, notes: [], phrase: null
          };
          order.push(s.sci);
        });
        if (!order.length) { renderStatus(); return; }
        planFlock();
        pump();
      })
      .catch(function () { state.failed = true; renderStatus(); });
  }

  // ----------------------------------------------------------------- bank ----
  // A species' notes. Only the best few takes of each key keep their samples;
  // the rest stay as "ghosts" (pitch + clip only) so that rankNotes can still
  // see that the bird sings that pitch in several recordings.
  function prune(sp, keep) {
    var by = {};
    sp.notes.forEach(function (n) { if (!n.ghost) (by[n.key] = by[n.key] || []).push(n); });
    Object.keys(by).forEach(function (k) {
      var arr = by[k];
      if (arr.length <= keep) return;
      arr.sort(function (a, b) { return b.rank - a.rank; });
      for (var j = keep; j < arr.length; j++) { arr[j].ghost = true; arr[j].pcm = null; arr[j].buf = null; }
    });
  }
  function ingest(sp, rec) {
    var keep = sp.notes.filter(function (n) { return n.clip !== rec.file; });
    (rec.notes || []).forEach(function (n) {
      if (!n.pcm || !n.pcm.length) return;
      n.sci = sp.sci; n.com = sp.com; n.clip = rec.file; n.sr = rec.sr; n.buf = null; n.ghost = false;
      keep.push(n);
    });
    sp.notes = keep;
    S.rankNotes(sp.notes);
    prune(sp, 1);
    var ph = rec.phrase;
    if (ph && ph.pcm && ph.pcm.length) {
      // The voice pad plays the clearest phrase of the bird's top recordings.
      var rankIdx = 0;
      for (var i = 0; i < sp.clips.length; i++) if (sp.clips[i].file === rec.file) { rankIdx = i; break; }
      var score = (ph.snr || 0) - 3 * rankIdx;
      if (!sp.phrase || score > sp.phrase.score) {
        sp.phrase = { pcm: ph.pcm, sr: rec.sr, rms: ph.rms, dur: ph.pcm.length / rec.sr, clip: rec.file, score: score, buf: null };
      }
    }
    sp.done[rec.file] = 1;
    dirty();
  }
  function liveNotes(sp) { return sp.notes.filter(function (n) { return !n.ghost; }); }

  var cur = { keys: {}, pick: {}, list: [], lo: null, hi: null };   // the board being played
  var turn = {};                    // key → the singer it shows while a song plays
  var dirtyT = 0, lastBuild = 0;
  function dirty() {
    if (dirtyT) return;
    dirtyT = setTimeout(rebuild, clamp(900 - (Date.now() - lastBuild), 40, 900));
  }
  function rebuild() {
    clearTimeout(dirtyT); dirtyT = 0; lastBuild = Date.now();
    var all = [];
    order.forEach(function (sci) { all = all.concat(liveNotes(species[sci])); });
    cur = S.buildKeys(all);
    renderKeyboard();
    renderPads();
    refitAll();
    renderStatus();
  }
  function shownIdx(k) {
    var arr = cur.keys[k];
    if (!arr) return 0;
    var i = turn[k] != null ? turn[k] : cur.pick[k];
    return i < arr.length ? i : 0;
  }
  // Who sings key k when it is pressed: the bird shown on it.
  function singerFor(k) {
    var arr = cur.keys[k];
    return arr && arr.length ? arr[shownIdx(k)] : null;
  }

  // ------------------------------------------------------------- keyboard ----
  var kbEl = $('playKb'), kbScroll = $('playKbScroll');
  var keyEls = {}, kbRange = null, kbBase = null, kbCentered = false;
  var BLACK = { 1: 1, 3: 1, 6: 1, 8: 1, 10: 1 };
  function isBlack(m) { return !!BLACK[((m % 12) + 12) % 12]; }
  // Two rows of the computer keyboard, laid out like piano keys.
  var CODES = ['KeyZ', 'KeyS', 'KeyX', 'KeyD', 'KeyC', 'KeyV', 'KeyG', 'KeyB', 'KeyH', 'KeyN', 'KeyJ', 'KeyM',
               'KeyQ', 'Digit2', 'KeyW', 'Digit3', 'KeyE', 'KeyR', 'Digit5', 'KeyT', 'Digit6', 'KeyY', 'Digit7', 'KeyU',
               'KeyI', 'Digit9', 'KeyO', 'Digit0', 'KeyP'];
  var CODE_AT = {};
  CODES.forEach(function (c, i) { CODE_AT[c] = i; });
  function codeLabel(c) { return c.replace('Key', '').replace('Digit', '').toLowerCase(); }

  function renderKeyboard() {
    var lo = cur.lo, hi = cur.hi;
    wrap.classList.toggle('is-empty', lo == null);
    if (lo == null) { kbEl.innerHTML = ''; keyEls = {}; kbRange = null; return; }
    if (hi - lo < 23) { lo = Math.floor((lo + hi) / 2) - 12; hi = lo + 24; }   // never less than two octaves
    if (kbRange) { lo = Math.min(lo, kbRange[0]); hi = Math.max(hi, kbRange[1]); }   // grows, never jumps
    if (isBlack(lo)) lo--;
    if (isBlack(hi)) hi++;
    if (!kbRange || kbRange[0] !== lo || kbRange[1] !== hi) {
      var anchor = kbRange ? anchorKey() : null;
      var html = '', whites = 0;
      for (var k = lo; k <= hi; k++) {
        var b = isBlack(k);
        html += '<button type="button" class="pk ' + (b ? 'b' : 'w') + '" data-k="' + k + '"' + (b ? ' style="--i:' + whites + '"' : '') + '>' +
          '<span class="pk-art"></span><span class="pk-n">' + esc(S.noteName(k)) + '</span><span class="pk-kbd"></span></button>';
        if (!b) whites++;
      }
      kbEl.innerHTML = html;
      kbEl.style.setProperty('--whites', whites);
      keyEls = {};
      [].forEach.call(kbEl.children, function (el) { keyEls[el.getAttribute('data-k')] = el; });
      kbRange = [lo, hi];
      layoutKeyboard();
      if (anchor) restoreAnchor(anchor);
    }
    for (var m = kbRange[0]; m <= kbRange[1]; m++) updateKey(m);
    if (kbBase == null && cur.list.length) kbBase = defaultBase();
    labelKeys();
    if (!kbCentered && cur.list.length) { kbCentered = true; centerOn(richestKey()); }
    syncNudges();
  }
  function updateKey(k) {
    var el = keyEls[k];
    if (!el) return;
    var arr = cur.keys[k], n = arr ? arr[shownIdx(k)] : null;
    var sig = n ? n.sci : '';
    if (el.getAttribute('data-sig') === sig) return;
    el.setAttribute('data-sig', sig);
    el.classList.toggle('has', !!n);
    var art = el.firstChild;
    if (!n) {
      art.innerHTML = '';
      el.style.removeProperty('--c');
      el.setAttribute('aria-label', S.noteName(k) + ', no bird sings this note yet');
      el.removeAttribute('title');
      return;
    }
    el.style.setProperty('--c', 'var(--ch-' + species[n.sci].hue + ')');
    el.setAttribute('aria-label', S.noteName(k) + ', ' + n.com);
    el.setAttribute('title', n.com + ' · ' + S.noteName(k));
    art.innerHTML = birdImg(n.sci, n.com);
  }
  // A bird's portrait; a bird with no illustration yet gets its initials.
  function birdImg(sci, com) {
    var ini = String(com || sci).split(/[\s-]+/).map(function (w) { return w.charAt(0); }).join('').slice(0, 2).toUpperCase();
    return '<img src="' + esc(APP.img(sci, 1)) + '" alt="" loading="lazy" decoding="async" draggable="false" data-ini="' + esc(ini) + '">';
  }
  // apt.js retries a missing illustration from cutouts/ (first error); if that
  // is missing too (second error), swap in the initials.
  wrap.addEventListener('error', function (e) {
    var t = e.target;
    if (!t || t.tagName !== 'IMG' || !t.hasAttribute('data-ini')) return;
    var n = (+t.getAttribute('data-err') || 0) + 1;
    t.setAttribute('data-err', n);
    if (n < 2 || !t.parentNode) return;
    var s = document.createElement('span');
    s.className = 'p-ini'; s.textContent = t.getAttribute('data-ini');
    t.parentNode.replaceChild(s, t);
  }, true);

  function layoutKeyboard() {
    if (!kbRange) return;
    var whites = +kbEl.style.getPropertyValue('--whites') || 1;
    var avail = kbScroll.clientWidth || wrap.clientWidth || 320;
    var kw = clamp(Math.floor(avail / whites), COARSE ? 42 : 30, 56);
    kbEl.style.setProperty('--kw', kw + 'px');
    kbEl.style.width = (kw * whites) + 'px';
    wrap.classList.toggle('kb-scrolls', kw * whites > avail + 1);
    syncNudges();
  }
  function anchorKey() {                  // which key sits at the left edge now
    var x = kbScroll.scrollLeft, best = null;
    Object.keys(keyEls).forEach(function (k) {
      var el = keyEls[k];
      if (el.classList.contains('w') && el.offsetLeft <= x + 1 && (!best || el.offsetLeft > best.left)) best = { k: +k, left: el.offsetLeft, off: x - el.offsetLeft };
    });
    return best;
  }
  function restoreAnchor(a) {
    var el = keyEls[a.k];
    if (el) kbScroll.scrollLeft = el.offsetLeft + a.off;
  }
  function centerOn(k) {
    var el = keyEls[k];
    if (!el) return;
    kbScroll.scrollLeft = el.offsetLeft - (kbScroll.clientWidth - el.offsetWidth) / 2;
    syncNudges();
  }
  function richestKey() {                 // the middle of where most birds sing
    var w = 0, s = 0;
    cur.list.forEach(function (k) { var c = cur.keys[k].length; w += c; s += c * k; });
    return w ? Math.round(s / w) : (cur.lo || 84);
  }
  function defaultBase() { return 12 * Math.floor((richestKey() - 6) / 12); }
  function labelKeys() {
    Object.keys(keyEls).forEach(function (k) {
      var i = +k - kbBase, lab = keyEls[k].lastChild;
      var t = (kbBase != null && i >= 0 && i < CODES.length) ? codeLabel(CODES[i]) : '';
      if (lab.textContent !== t) lab.textContent = t;
    });
  }

  // ‹ › beside the keys: on a phone the keys can't be dragged sideways
  // (dragging plays them), so these move along the keyboard an octave at a
  // time. Shown only when the keyboard is wider than the screen.
  var lowerBtn = $('playLower'), higherBtn = $('playHigher');
  function syncNudges() {
    var max = kbScroll.scrollWidth - kbScroll.clientWidth;
    lowerBtn.disabled = kbScroll.scrollLeft <= 1;
    higherBtn.disabled = kbScroll.scrollLeft >= max - 1;
  }
  function nudge(dir) {
    var kw = parseFloat(kbEl.style.getPropertyValue('--kw')) || 40;
    var to = kbScroll.scrollLeft + dir * 7 * kw;
    try { kbScroll.scrollTo({ left: to, behavior: 'smooth' }); } catch (e) { kbScroll.scrollLeft = to; }
  }
  lowerBtn.addEventListener('click', function () { nudge(-1); });
  higherBtn.addEventListener('click', function () { nudge(1); });
  kbScroll.addEventListener('scroll', syncNudges, { passive: true });

  // Pressing a key.
  var flashT = {};
  function flashKey(k, ms, keep) {
    var el = keyEls[k];
    if (!el) return;
    if (!keep) {
      el.classList.remove('on');
      void el.offsetWidth;                // restart the pop
      el.classList.add('on');
    }
    clearTimeout(flashT[k]);
    flashT[k] = setTimeout(function () { el.classList.remove('on'); }, clamp(ms || 160, 110, 2000));
  }
  // `held`: a finger or a key is down and release(k, v) will follow. In the
  // "sings on" cut the bird then sings for as long as it is held.
  function press(k, held) {
    var n = singerFor(k);
    if (!n) { flashKey(k, 110); return null; }
    claim();
    var v = playNote(n, 0, null, !!held);
    flashKey(k, v ? v.dur * 1000 : 160);
    showNow(k, n);
    return v;
  }
  function release(k, v) {
    if (!v || !v.held || v.gone) return;
    letGo(v);
    flashKey(k, Math.max(60, (v.at + v.dur - ctx.currentTime) * 1000), true);
  }
  (function () {
    var ptr = {};
    function keyAt(e) {
      var el = document.elementFromPoint(e.clientX, e.clientY);
      el = el && el.closest ? el.closest('.pk') : null;
      return el && kbEl.contains(el) ? +el.getAttribute('data-k') : null;
    }
    kbEl.addEventListener('pointerdown', function (e) {
      if (e.button) return;
      var k = keyAt(e);
      if (k == null) return;
      e.preventDefault();
      try { kbEl.setPointerCapture(e.pointerId); } catch (err) {}
      ptr[e.pointerId] = { k: k, v: press(k, true) };
    });
    kbEl.addEventListener('pointermove', function (e) {       // slide across keys = a run of notes
      var p = ptr[e.pointerId];
      if (!p) return;
      var k = keyAt(e);
      if (k != null && k !== p.k) { release(p.k, p.v); ptr[e.pointerId] = { k: k, v: press(k, true) }; }
    });
    ['pointerup', 'pointercancel', 'lostpointercapture'].forEach(function (t) {
      kbEl.addEventListener(t, function (e) {
        var p = ptr[e.pointerId];
        if (!p) return;
        delete ptr[e.pointerId];
        release(p.k, p.v);
      });
    });
    // Tab + Enter/Space on a key (a click with no pointer behind it).
    kbEl.addEventListener('click', function (e) {
      if (e.detail !== 0) return;
      var el = e.target.closest && e.target.closest('.pk');
      if (el) press(+el.getAttribute('data-k'));
    });
    kbEl.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  })();

  var held = {};
  function typingTarget(t) {
    return !!(t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable));
  }
  function modalOpen() { return !!document.querySelector('#detail-modal[aria-hidden="false"], #about-modal[aria-hidden="false"], #menu-dd.open'); }
  document.addEventListener('keydown', function (e) {
    if (!state.visible || e.metaKey || e.ctrlKey || e.altKey || typingTarget(e.target) || modalOpen()) return;
    if (e.code === 'Space') {
      if (e.target && e.target.tagName === 'BUTTON' && !e.target.classList.contains('pk')) return;   // let buttons be buttons
      e.preventDefault();
      if (!e.repeat) toggleSong();
      return;
    }
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      if (kbBase == null || !kbRange) return;
      e.preventDefault();
      kbBase = clamp(kbBase + (e.code === 'ArrowRight' ? 12 : -12), 12 * Math.floor(kbRange[0] / 12) - 12, 12 * Math.floor(kbRange[1] / 12));
      labelKeys();
      centerOn(clamp(kbBase + 12, kbRange[0], kbRange[1]));
      return;
    }
    var i = CODE_AT[e.code];
    if (i == null || kbBase == null) return;
    e.preventDefault();
    if (e.repeat || held[e.code]) return;
    held[e.code] = { k: kbBase + i, v: press(kbBase + i, true) };
  });
  function keyUp(code) {
    var h = held[code];
    if (!h) return;
    delete held[code];
    release(h.k, h.v);
  }
  document.addEventListener('keyup', function (e) { keyUp(e.code); });
  // A key-up that never arrives (the window lost focus mid-press) must not
  // leave a key stuck down.
  window.addEventListener('blur', function () { Object.keys(held).forEach(keyUp); });

  // --------------------------------------------------------- now singing ----
  // Just who is singing and which note. Tap the bird to read about it.
  var nowEl = $('playNow');
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function clipWhen(file) {
    var m = /-(\d{4})-(\d{2})-(\d{2})-birdnet-(\d{2}):(\d{2}):\d{2}\.mp3$/i.exec(file || '');
    if (!m) return '';
    var h = +m[4], ap = h < 12 ? 'am' : 'pm', h12 = (h % 12) || 12;
    return (+m[3]) + ' ' + MONTHS[(+m[2]) - 1] + ' ' + m[1] + ', ' + h12 + ':' + m[5] + ' ' + ap;
  }
  function showNow(k, n) {
    var when = clipWhen(n.clip);
    // Honest about a doubtful credit (sampler-core's rankNotes): the sound is
    // real and from this bird's recording, but perhaps not from this bird.
    var title = (when ? 'recorded ' + when : '') + (n.odd ? (when ? ' · ' : '') + 'may be a neighbour in the background' : '');
    nowEl.innerHTML =
      '<a class="pn-bird" href="#sci=' + encodeURIComponent(n.sci) + '" title="' + esc(title) + '" style="--c:var(--ch-' + species[n.sci].hue + ')">' +
        '<span class="pn-art">' + birdImg(n.sci, n.com) + '</span>' +
        '<span class="pn-name"><small>now singing</small> <b>' + esc(n.com) + '</b><span class="pn-note">' + esc(S.noteName(k)) + '</span></span>' +
      '</a>';
    nowEl.classList.add('live');
  }

  // --------------------------------------------------------------- voices ----
  var padsEl = $('playPads'), padSig = '';
  function renderPads() {
    var list = order.filter(function (sci) { return species[sci].phrase; });
    var sig = list.join('|');
    if (sig === padSig) return;
    padSig = sig;
    var html = '';
    list.forEach(function (sci) {
      var sp = species[sci];
      html += '<button type="button" class="pad" data-sci="' + esc(sci) + '" style="--c:var(--ch-' + sp.hue + ')" title="recorded ' + esc(clipWhen(sp.phrase.clip)) + '">' +
        '<span class="pad-art">' + birdImg(sp.sci, sp.com) + '</span><span class="pad-name">' + esc(sp.com) + '</span></button>';
    });
    padsEl.innerHTML = html;
    $('playVoices').hidden = !list.length;
    var sub = $('playVoicesSub');
    if (sub) sub.textContent = plural(list.length, 'bird') + ' · tap one to hear its call, exactly as the microphone caught it';
  }
  padsEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.pad');
    if (!b) return;
    var sp = species[b.getAttribute('data-sci')];
    if (!sp || !sp.phrase) return;
    claim();
    var v = playPhrase(sp.phrase);
    if (!v) return;
    b.classList.remove('on'); void b.offsetWidth;
    b.style.setProperty('--d', Math.round(v.dur * 1000) + 'ms');
    b.classList.add('on');
    clearTimeout(b._t);
    b._t = setTimeout(function () { b.classList.remove('on'); }, v.dur * 1000 + 60);
  });

  // ---------------------------------------------------------------- songs ----
  var songSel = $('playSong'), goBtn = $('playGo'), tempoEl = $('playTempo');
  var rollEl = $('playRoll'), castEl = $('playCast');
  var ownBox = $('playOwn'), ownText = $('playOwnText'), ownErr = $('playOwnErr');
  var midiBox = $('playMidi'), midiFile = $('playMidiFile'), midiPart = $('playMidiPart'), midiName = $('playMidiName');
  var parsed = {};                         // songbook id → parsed tune
  var midi = null;                         // { name, data, part, top }
  var song = { id: ls('song', 'roll'), notes: [], beats: 0, fit: null, who: [] };
  var bpm = 120, play = null, rafId = 0, visuals = [];

  function tuneNotes(id) {                 // → { notes, beats, bpm, title }
    if (id === 'roll') {
      var rc = S.rollCall(cur.list);
      return { notes: rc, beats: rc.length * 0.5, bpm: 150, title: 'Roll call' };
    }
    if (id === 'own') {
      var o = S.parseMelody(ownText.value);
      return { notes: o.notes, beats: o.beats, bpm: null, title: 'Your tune', errors: o.errors };
    }
    if (id === 'midi') {
      if (!midi) return { notes: [], beats: 0, bpm: null, title: 'MIDI file' };
      var mm = S.midiMelody(midi.data, midi.part, midi.top ? 'top' : 'all');
      return { notes: mm.notes, beats: mm.beats, bpm: midi.data.bpm, title: midi.name };
    }
    for (var i = 0; i < BOOK.length; i++) {
      if (BOOK[i].id !== id) continue;
      var p = parsed[id] || (parsed[id] = S.parseMelody(BOOK[i].notes));
      return { notes: p.notes, beats: p.beats, bpm: BOOK[i].bpm, title: BOOK[i].title };
    }
    return { notes: [], beats: 0, bpm: null, title: '' };
  }
  function hasKey(k) {
    var arr = cur.keys[k];
    return arr && arr.length ? clamp(arr[cur.pick[k] < arr.length ? cur.pick[k] : 0].rank, 0.05, 1) : 0;
  }
  // `shift` pins where the tune sits (the roll call: exactly on its own keys).
  function fitOf(notes, shift) { return S.fitMelody(notes, hasKey, { lo: cur.lo, hi: cur.hi, fill: true, shift: shift }); }

  function buildSongList() {
    var html = '<optgroup label="start here"><option value="roll">Roll call: every note, low to high</option></optgroup><optgroup label="songbook">';
    BOOK.forEach(function (t) { html += '<option value="' + esc(t.id) + '">' + esc(t.title) + '</option>'; });
    html += '</optgroup><optgroup label="your own"><option value="own">Type a tune…</option><option value="midi">Open a MIDI file…</option></optgroup>';
    songSel.innerHTML = html;
    var ok = [].some.call(songSel.options, function (o) { return o.value === song.id; });
    if (!ok || song.id === 'midi') song.id = 'roll';
    songSel.value = song.id;
  }
  function refitAll() { refitSong(); }
  function refitSong() {
    var t = tuneNotes(song.id);
    song.notes = t.notes; song.beats = t.beats; song.title = t.title;
    song.fit = fitOf(t.notes, song.id === 'roll' ? 0 : null);
    // Who sings each note: a note that comes round again passes to the next
    // bird that sings it well (sampler-core's singTurns). The roll call, one of
    // each note, simply plays every key's own bird.
    song.who = S.singTurns(song.fit.notes, cur).map(function (i, j) {
      var k = song.fit.notes[j].key;
      return i == null ? null : cur.keys[k][i];
    });
    if (song.id === 'own') {
      ownErr.textContent = (t.errors && t.errors.length) ? 'Couldn’t read: ' + t.errors.slice(0, 6).join(' ') : '';
    }
    renderRoll();
    renderFit();
  }
  function selectSong(id, keepTempo) {
    stopSong();
    song.id = id; lsSet('song', id);
    ownBox.hidden = id !== 'own';
    midiBox.hidden = id !== 'midi';
    var t = tuneNotes(id);
    if (!keepTempo && t.bpm) setTempo(t.bpm);
    refitSong();
  }
  function setTempo(v) {
    v = clamp(Math.round(v), 40, 240);
    if (play && ctx) {                     // keep our place in the tune as the tempo moves
      var beat = (ctx.currentTime - play.t0) / play.spb;
      play.spb = 60 / v;
      play.t0 = ctx.currentTime - beat * play.spb;
    }
    bpm = v;
    tempoEl.value = v;
  }

  function singerHue(i) { var w = song.who[i]; return w ? species[w.sci].hue : 8; }
  function renderRoll() {
    var fit = song.fit;
    if (!fit || !fit.notes.length) {
      rollEl.innerHTML = '<p class="roll-empty">' + (song.id === 'own' ? 'Type a tune above and it appears here.' : song.id === 'midi' ? 'Choose a MIDI file and the birds will sing it.' : cur.lo == null ? 'The tune appears once the birds have some notes.' : 'Nothing to play yet.') + '</p>';
      return;
    }
    var lo = Infinity, hi = -Infinity;
    fit.notes.forEach(function (n) {
      var y = n.key != null ? n.key : n.m + fit.shift;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    });
    lo -= 1; hi += 1;
    var span = hi - lo + 1, beats = Math.max(1, song.beats);
    var w = Math.max(rollEl.clientWidth || 300, Math.round(beats * 11));
    var html = '';
    fit.notes.forEach(function (n, i) {
      var y = n.key != null ? n.key : n.m + fit.shift;
      html += '<i class="rn ' + n.how + '" data-i="' + i + '" style="left:' + (100 * n.t / beats).toFixed(3) + '%;width:' + Math.max(0.25, 100 * n.d / beats - 0.12).toFixed(3) + '%;top:' + (100 * (hi - y) / span).toFixed(2) + '%;height:' + (100 / span).toFixed(2) + '%;--c:var(--ch-' + singerHue(i) + ')"></i>';
    });
    rollEl.innerHTML = '<div class="roll-in" style="width:' + w + 'px">' + html + '<b class="roll-head"></b></div>';
    rollEl.scrollLeft = 0;
  }
  // Who is in the choir for this tune.
  function renderFit() {
    var count = {}, seq = [];
    song.who.forEach(function (w) {
      if (!w) return;
      if (!count[w.sci]) { count[w.sci] = 0; seq.push(w.sci); }
      count[w.sci]++;
    });
    seq.sort(function (a, b) { return count[b] - count[a]; });
    var html = seq.length ? '<span class="cast-lbl">sung by ' + plural(seq.length, 'bird') + '</span>' : '';
    seq.slice(0, 16).forEach(function (s) {
      var sp = species[s];
      html += '<button type="button" class="cast" data-sci="' + esc(s) + '" title="' + esc(sp.com) + ' · ' + plural(count[s], 'note') + '" style="--c:var(--ch-' + sp.hue + ')">' + birdImg(s, sp.com) + '<small>' + count[s] + '</small></button>';
    });
    if (seq.length > 16) html += '<span class="cast-lbl">+' + (seq.length - 16) + ' more</span>';
    castEl.innerHTML = html;
  }
  castEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('.cast');
    if (b) location.hash = '#sci=' + encodeURIComponent(b.getAttribute('data-sci'));
  });

  // The player: a look-ahead scheduler. Notes are queued on the audio clock a
  // quarter-second ahead, so timing stays tight even if the page stutters.
  function startSong() {
    if (!audio()) { renderStatus('This browser can’t play audio.'); return; }
    refitSong();
    if (!song.fit || !song.fit.notes.length || song.fit.rest === song.fit.total) return;
    stopVoices(); claim();
    play = { t0: ctx.currentTime + 0.15, i: 0, spb: 60 / bpm, timer: 0 };
    visuals = [];
    goBtn.textContent = '■'; goBtn.setAttribute('aria-label', 'stop'); goBtn.classList.add('on');
    wrap.classList.add('is-playing');
    // Bring the keys the tune uses into view.
    var ks = song.fit.notes.filter(function (n) { return n.key != null; }).map(function (n) { return n.key; }).sort(function (a, b) { return a - b; });
    if (ks.length) centerOn(ks[ks.length >> 1]);
    tick();
    play.timer = setInterval(tick, 50);
    cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(frame);
  }
  function stopSong(ringOut) {
    if (!play) return;
    clearInterval(play.timer);
    play = null; visuals = [];
    cancelAnimationFrame(rafId);
    goBtn.textContent = '▶'; goBtn.setAttribute('aria-label', 'play'); goBtn.classList.remove('on');
    wrap.classList.remove('is-playing');
    var head = rollEl.querySelector('.roll-head');
    if (head) head.style.transform = '';
    if (!ringOut) stopVoices();
    // The keys go back to showing their own birds.
    var was = turn; turn = {};
    Object.keys(was).forEach(function (k) { updateKey(+k); });
  }
  function toggleSong() { if (play) stopSong(); else startSong(); }
  function tick() {
    if (!play || !ctx) return;
    var notes = song.fit.notes, horizon = ctx.currentTime + 0.28, guard = 0;
    while (guard++ < 4000) {
      if (play.i >= notes.length) {
        var end = play.t0 + Math.max(song.beats, 0.5) * play.spb;
        if (ctx.currentTime > end + 0.35) stopSong(true);      // the last notes ring out
        break;
      }
      var n = notes[play.i], at = play.t0 + n.t * play.spb;
      if (at > horizon) break;
      if (n.key != null && at > ctx.currentTime - 0.06) {
        var who = song.who[play.i];
        // A note rings for its written length, then fades just into the next
        // one — legato, without a long bird smearing a quick passage. ("Sings
        // on" adds its own ring, and lets the very last note finish its call.)
        var lastOne = play.i === notes.length - 1;
        var v = playNote(who, at, Math.max(0.09, n.d * play.spb) + 0.03 + (lastOne ? SING.last : 0));
        if (v) visuals.push({ at: v.at, key: n.key, i: play.i, note: who, ms: v.dur * 1000 });
      }
      play.i++;
    }
  }
  var lastNowAt = 0;
  // While a song plays, a key wears the face of whichever bird is singing it.
  function showOnKey(k, n) {
    var arr = cur.keys[k], i = arr ? arr.indexOf(n) : -1;
    if (i < 0) return;
    turn[k] = i;
    updateKey(k);
  }
  function frame() {
    if (!play || !ctx) return;
    var now = ctx.currentTime;
    while (visuals.length && visuals[0].at <= now + 0.01) {
      var ev = visuals.shift();
      showOnKey(ev.key, ev.note);
      flashKey(ev.key, ev.ms);
      var rn = rollEl.querySelector('.rn[data-i="' + ev.i + '"]');
      if (rn) { rn.classList.add('on'); (function (el, ms) { setTimeout(function () { el.classList.remove('on'); }, clamp(ms, 120, 900)); })(rn, ev.ms); }
      if (now - lastNowAt > 0.14 || !visuals.length) { lastNowAt = now; showNow(ev.key, ev.note); }
    }
    var inner = rollEl.firstChild, head = inner && inner.querySelector ? inner.querySelector('.roll-head') : null;
    if (head) {
      var beats = Math.max(song.beats, 0.5), beat = (now - play.t0) / play.spb;
      var x = clamp(beat / beats, 0, 1) * inner.offsetWidth;
      head.style.transform = 'translateX(' + x.toFixed(1) + 'px)';
      if (inner.offsetWidth > rollEl.clientWidth + 2) {
        var want = x - rollEl.clientWidth * 0.35;
        if (Math.abs(rollEl.scrollLeft - want) > 2) rollEl.scrollLeft = want;
      }
    }
    rafId = requestAnimationFrame(frame);
  }

  goBtn.addEventListener('click', toggleSong);
  songSel.addEventListener('change', function () { selectSong(songSel.value); });
  tempoEl.addEventListener('input', function () { setTempo(+tempoEl.value); });
  var ownT = 0;
  ownText.addEventListener('input', function () {
    lsSet('mytune', ownText.value);
    clearTimeout(ownT);
    ownT = setTimeout(function () { if (song.id === 'own') { stopSong(); refitSong(); } }, 250);
  });

  // MIDI: choose a file, or drop one on the songs panel.
  function openMidi(file) {
    if (!file) return;
    if (file.size > 3 * 1024 * 1024) { midiName.textContent = 'That file is too big to be a simple MIDI tune.'; return; }
    var fr = new FileReader();
    fr.onerror = function () { midiName.textContent = 'Couldn’t read that file.'; };
    fr.onload = function () {
      var data;
      try { data = S.parseMidi(fr.result); } catch (e) { data = null; }
      if (!data || !data.parts.length) {
        midiName.textContent = '“' + file.name + '” isn’t a MIDI file I can read (it needs to be a standard .mid with notes in it).';
        return;
      }
      midi = { name: file.name.replace(/\.midi?$/i, ''), data: data, part: S.midiTunePart(data), top: true };
      var html = '';
      data.parts.forEach(function (p, i) {
        html += '<option value="' + i + '">' + esc(p.name || ('Part ' + (i + 1))) + ' (' + plural(p.notes.length, 'note') + ')</option>';
      });
      if (data.parts.length > 1) html += '<option value="-1">Every part together</option>';
      midiPart.innerHTML = html;
      midiPart.value = String(midi.part);
      midiPart.hidden = false;
      midiName.textContent = midi.name;
      songSel.value = 'midi';
      selectSong('midi');
    };
    fr.readAsArrayBuffer(file);
  }
  $('playMidiPick').addEventListener('click', function () { midiFile.click(); });
  midiFile.addEventListener('change', function () { openMidi(midiFile.files && midiFile.files[0]); midiFile.value = ''; });
  midiPart.addEventListener('change', function () { if (midi) { midi.part = +midiPart.value; selectSong('midi', true); } });

  var songsPanel = $('playSongs');
  songsPanel.addEventListener('dragover', function (e) { e.preventDefault(); songsPanel.classList.add('drop'); });
  songsPanel.addEventListener('dragleave', function () { songsPanel.classList.remove('drop'); });
  songsPanel.addEventListener('drop', function (e) {
    e.preventDefault(); songsPanel.classList.remove('drop');
    var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) openMidi(f);
  });

  // --------------------------------------------------------------- status ----
  var statusEl = $('playStatus');
  function idleNow() {
    return '<p class="pn-idle">' + (COARSE ? 'Tap a key, or hold one and the bird sings on. Slide along them for a run of notes.' : 'Click a key (hold it and the bird sings on), or play from your keyboard: the Z and Q rows are the keys, ← → move up and down, space plays the tune.') + '</p>';
  }
  function renderStatus(msg) {
    if (!statusEl) return;
    var html;
    if (msg) html = '<span>' + esc(msg) + '</span>';
    else if (state.failed) html = '<span>Couldn’t reach the recordings just now.</span><button type="button" class="pn-btn" data-act="retry">try again</button>';
    else if (!window.AudioContext && !window.webkitAudioContext) html = '<span>This browser can’t play audio, so the instrument is switched off here.</span>';
    else if (state.inited && !order.length && !active) html = '<span>No recordings to play yet. They appear here as the box hears and confirms birds.</span>';
    else {
      var total = stats.want, done = stats.done, busy = queue.length + active > 0;
      var birds = {}, nb = 0;
      cur.list.forEach(function (k) { cur.keys[k].forEach(function (n) { if (!birds[n.sci]) { birds[n.sci] = 1; nb++; } }); });
      var have = cur.list.length ? plural(cur.list.length, 'note') + ' · ' + plural(nb, 'bird') : '';
      if (busy && (state.depth === 0 || !have)) {
        // The first listen: show how far along it is.
        html = '<span>listening to the recordings: ' + done + ' of ' + total + '</span>' +
          '<i class="st-bar"><b style="width:' + (total ? Math.round(100 * done / total) : 0) + '%"></b></i>';
      } else if (busy) {
        // The quiet second listen, for more notes and more birds on each.
        html = '<span>' + have + ' · listening for more</span>';
      } else {
        html = '<span>' + (have || 'no playable notes found yet') + '</span>';
      }
    }
    if (statusEl.innerHTML !== html) statusEl.innerHTML = html;
  }
  statusEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button');
    if (b && b.getAttribute('data-act') === 'retry') loadIndex();
  });

  // ------------------------------------------------------------ lifecycle ----
  function init() {
    state.inited = true;
    nowEl.innerHTML = idleNow();
    ownText.value = ls('mytune', '') || 'C4 C G G A A G:2 | F F E E D D C:2';
    buildSongList();
    ownBox.hidden = song.id !== 'own';
    midiBox.hidden = song.id !== 'midi';
    var t = tuneNotes(song.id);
    setTempo(t.bpm || 120);
    renderKeyboard(); renderPads(); refitSong();
    startWorkers();
    cacheSweep();
    loadIndex();
  }
  function show() {
    state.visible = true;
    if (!state.inited) init();
    requestAnimationFrame(layoutKeyboard);
    pump();
  }
  function hide() {
    state.visible = false;
    stopEverything();
    APP.audioRelease(stopEverything);
  }
  var resizeT = 0;
  window.addEventListener('resize', function () {
    if (!state.inited) return;
    clearTimeout(resizeT);
    resizeT = setTimeout(function () { layoutKeyboard(); if (!play) renderRoll(); }, 120);
  });
  document.addEventListener('visibilitychange', function () {
    if (document.hidden && state.inited) { stopSong(); stopVoices(); }
  });

  window.AvianPlay = { show: show, hide: hide };
  if (APP.view && APP.view() === 4) show();     // arrived by the #play link
})();
