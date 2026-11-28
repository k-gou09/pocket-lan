/*
IRIS — noyau iridescent. Runtime d'avatar, fichier commun (prototype 02).
Script classique (pas de module ES) : double-clic sur le HTML, aucun serveur,
aucun CORS sur file://, aucune librairie.

Contrat identique à Nova / Holo / Pocket LAN :
  setState(idle|listening|thinking|speaking|error)
  setEmotion(neutral|happy|sad|surprised|curious|angry|sleepy [, durée ms])
  setViseme(rest|a|e|i|o|u|smile [, amplitude 0..1])
  look(x, y)  // -1..1, y positif = vers le haut
  blink([délai ms]) · speak(texte, {rate, lang}) -> Promise · setPaused · destroy
L'élément hôte reçoit data-state / data-emotion / data-viseme, la classe
is-blinking et les variables CSS --gaze-x / --gaze-y / --jaw.

Rendu : raymarching SDF en WebGL 1 (verre + plasma fbm + iridescence +
anneaux gyroscopiques + poussière + socle), repli automatique sur un rendu
Canvas 2D équivalent. Une seule boucle requestAnimationFrame, DPR plafonné,
géométrie et programme réutilisés, résolution stable pendant le drag.
Les événements émis pendant la construction sont différés d'un microtask :
l'appelant a toujours fini son initialisation quand il les reçoit.
*/
(function () {
'use strict';

var TAU = Math.PI * 2;
var STATES = ['idle', 'listening', 'thinking', 'speaking', 'error'];
var EMOTIONS = ['neutral', 'happy', 'sad', 'surprised', 'curious', 'angry', 'sleepy'];
var VISEMES = ['rest', 'a', 'e', 'i', 'o', 'u', 'smile'];

/* Bouche : mêmes formes que Holo (rx, ry, courbure). */
var MOUTH = {
  rest:  { rx: 0.20, ry: 0.014, curve: 0 },
  smile: { rx: 0.23, ry: 0.020, curve: 0.075 },
  frown: { rx: 0.21, ry: 0.016, curve: -0.070 },
  a: { rx: 0.17, ry: 0.170, curve: 0 },
  e: { rx: 0.20, ry: 0.100, curve: 0.005 },
  i: { rx: 0.10, ry: 0.155, curve: 0 },
  o: { rx: 0.13, ry: 0.145, curve: 0 },
  u: { rx: 0.085, ry: 0.100, curve: 0 }
};

/* Humeurs : cibles absolues, fusionnées avec la palette via "mix". */
var EMO = {
  neutral:   { a: 189, b: 312, chroma: 0, sat: .92, energy: 1.00, turb: 1.00, glow: 1.00, eyeL: 1.00, eyeR: 1.00, speed: 1.00, jit: 0,   brow: 0,    mouth: 'rest',  pop: 0 },
  happy:     { a: 158, b: 46,  chroma: 1, sat: .95, energy: 1.22, turb: 0.85, glow: 1.35, eyeL: 1.02, eyeR: 1.02, speed: 1.35, jit: 0,   brow: 0,    mouth: 'smile', pop: .05 },
  sad:       { a: 222, b: 262, chroma: 1, sat: .60, energy: 0.68, turb: 0.70, glow: 0.55, eyeL: 0.62, eyeR: 0.62, speed: 0.50, jit: 0,   brow: -.55, mouth: 'frown', pop: 0 },
  surprised: { a: 186, b: 322, chroma: 1, sat: 1.0, energy: 1.32, turb: 1.25, glow: 1.50, eyeL: 1.32, eyeR: 1.32, speed: 0.80, jit: .05, brow: 0,    mouth: 'o',     pop: .12 },
  curious:   { a: 272, b: 318, chroma: 1, sat: .90, energy: 1.08, turb: 1.00, glow: 1.15, eyeL: 0.96, eyeR: 1.16, speed: 0.90, jit: 0,   brow: .12,  mouth: 'u',     pop: .03 },
  angry:     { a: 4,   b: 32,  chroma: 1, sat: .98, energy: 1.40, turb: 1.70, glow: 1.30, eyeL: 0.74, eyeR: 0.74, speed: 2.10, jit: 1,   brow: 1,    mouth: 'frown', pop: .04 },
  sleepy:    { a: 238, b: 210, chroma: 1, sat: .50, energy: 0.50, turb: 0.55, glow: 0.45, eyeL: 0.30, eyeR: 0.28, speed: 0.35, jit: 0,   brow: -.20, mouth: 'rest',  pop: 0 }
};
var PALETTES = {
  neon:        { a: 189, b: 312, bg: 222 },
  solaire:     { a: 36,  b: 348, bg: 258 },
  botanique:   { a: 150, b: 82,  bg: 185 },
  ultraviolet: { a: 268, b: 316, bg: 250 },
  glacier:     { a: 203, b: 170, bg: 215 }
};
var QUALITY = {
  eco:   { scale: 0.55, steps: 32, dprCap: 1.5 },
  std:   { scale: 0.80, steps: 48, dprCap: 2.0 },
  ultra: { scale: 1.00, steps: 72, dprCap: 2.0 }
};
var DEFAULTS = {
  turb: 1, glow: 1, irid: 0.85, ring: 1, dust: 0.6, orbit: 0.55, dist: 4.3,
  mix: 0.85, rate: 1, rings: true, face: true, guides: true,
  palette: 'neon', quality: 'std', engine: 'auto'
};

/* ---------- utilitaires ---------- */
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function rand(a, b) { return a + Math.random() * (b - a); }
function approach(cur, target, k) { return cur + (target - cur) * clamp(k, 0, 1); }
function approachHue(cur, target, k) {
  var d = ((target - cur + 540) % 360) - 180;
  return (cur + d * clamp(k, 0, 1) + 360) % 360;
}
function mixHue(a, b, t) { var d = ((b - a + 540) % 360) - 180; return (a + d * t + 360) % 360; }
function hslToRgb(h, s, l) {
  h = (((h % 360) + 360) % 360) / 360;
  var q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  function f(t) {
    t = ((t % 1) + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  }
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)];
}
/* matrices 3x3 colonnes-major (orientation des anneaux) */
function rotX(a) { var c = Math.cos(a), s = Math.sin(a); return [1,0,0, 0,c,s, 0,-s,c]; }
function rotY(a) { var c = Math.cos(a), s = Math.sin(a); return [c,0,-s, 0,1,0, s,0,c]; }
function rotZ(a) { var c = Math.cos(a), s = Math.sin(a); return [c,s,0, -s,c,0, 0,0,1]; }
function mul3(a, b) {
  var o = new Array(9);
  for (var c = 0; c < 3; c++) for (var r = 0; r < 3; r++) {
    var s = 0; for (var k = 0; k < 3; k++) s += a[k * 3 + r] * b[c * 3 + k];
    o[c * 3 + r] = s;
  }
  return o;
}
function tr3(m) { return [m[0],m[3],m[6], m[1],m[4],m[7], m[2],m[5],m[8]]; }
function ringO1(a) { return mul3(rotY(a * 0.6), rotX(1.05)); }
function ringO2(a) { return mul3(rotY(-a * 0.45), mul3(rotZ(0.85), rotX(0.30))); }

/* ---------- partition visémique (même logique que speech.js / avatar-runtime.js) ---------- */
var VOWEL_VISEME = [
  [/^(ou|où|oû|u|ù|û|ü)/, 'u'],
  [/^(oi|oî|oï)/, 'o'],
  [/^(on|om|o|ô|ö|au|eau)/, 'o'],
  [/^(an|am|en|em|a|à|â|ä)/, 'a'],
  [/^(in|im|ain|ein|un|um|i|î|ï|y)/, 'i'],
  [/^(e|é|è|ê|ë|œ|œu)/, 'e']
];
var VOWEL_CLASS = 'aàâäeéèêëiîïoôöuùûüyœæ';
var VOWEL_GROUP = new RegExp('[' + VOWEL_CLASS + ']+');
var SYLLABLE_PARTS = new RegExp('[' + VOWEL_CLASS + ']+|[^' + VOWEL_CLASS + ']+', 'g');
function roundAmp(a) { return Number(clamp(a, 0.15, 1).toFixed(2)); }
function visemeFor(v) {
  for (var i = 0; i < VOWEL_VISEME.length; i++) if (VOWEL_VISEME[i][0].test(v)) return VOWEL_VISEME[i][1];
  return 'e';
}
function splitSyllables(word) {
  var parts = word.match(SYLLABLE_PARTS) || [], out = [], pending = '';
  for (var i = 0; i < parts.length; i++) {
    if (VOWEL_GROUP.test(parts[i].charAt(0))) { out.push(pending + parts[i]); pending = ''; }
    else pending += parts[i];
  }
  if (pending) { if (out.length) out[out.length - 1] += pending; else out.push(pending); }
  return out.length ? out : [word];
}
function planWord(word, syllableMs) {
  var events = [], t = 0;
  function push(viseme, amp) {
    var prev = events[events.length - 1];
    if (prev && prev.viseme === viseme) { prev.amp = Math.max(prev.amp, roundAmp(amp)); return; }
    events.push({ at: Math.round(t), viseme: viseme, amp: roundAmp(amp) });
  }
  var lower = String(word || '').toLowerCase().normalize('NFC').replace(/[^a-zàâäéèêëîïôöùûüÿœæç'-]/g, '');
  var syllables = lower ? splitSyllables(lower) : [];
  if (!syllables.length) {
    var digits = String(word).replace(/\D/g, '');
    var count = Math.min(4, Math.max(1, digits.length));
    for (var d = 0; d < count; d++) { push('e', 0.7); t += syllableMs; }
  }
  for (var i = 0; i < syllables.length; i++) {
    var vowels = syllables[i].match(VOWEL_GROUP);
    var viseme = visemeFor(vowels ? vowels[0] : syllables[i]);
    var lengthBoost = clamp((vowels ? vowels[0].length : 1) / 2, 0.8, 1.5);
    var accent = i === syllables.length - 1 ? 0.06 : 0;
    var jitter = 0.94 + Math.random() * 0.12;
    var amp = clamp(0.52 * lengthBoost + accent + Math.random() * 0.2, 0.35, 1);
    push(viseme, amp * jitter);
    t += syllableMs * lengthBoost * jitter;
  }
  if (/[.!?]$/.test(word)) { push('rest', 0); t += syllableMs * 2.2; }
  else if (/[,;:…]$/.test(word)) { push('rest', 0); t += syllableMs * 1.2; }
  else t += syllableMs * 0.5;
  return { events: events, duration: t };
}
function buildVisemeScript(text, rate) {
  var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  if (!clean) return [];
  var syllableMs = 200 / clamp(Number(rate) || 1, 0.6, 1.8);
  var events = [], t = 0, words = clean.split(' ');
  for (var w = 0; w < words.length; w++) {
    if (!words[w]) continue;
    var plan = planWord(words[w], syllableMs);
    for (var i = 0; i < plan.events.length; i++) {
      var ev = plan.events[i], prev = events[events.length - 1];
      if (prev && prev.viseme === ev.viseme) prev.amp = Math.max(prev.amp, ev.amp);
      else events.push({ at: Math.round(t + ev.at), viseme: ev.viseme, amp: ev.amp });
    }
    t += plan.duration;
  }
  return events;
}

/* ============================================================
   SIMULATION — état, physique, parole, contrat DOM.
   Autonome : ne dépend d'aucune méthode du runtime.
   ============================================================ */
function Sim(opts) {
  this.opts = opts;
  this.host = opts.host || null;
  this.audio = opts.audio || null;
  this.reduced = opts.reducedMotion != null ? !!opts.reducedMotion
    : (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches);
  this.user = {}; for (var k in DEFAULTS) this.user[k] = DEFAULTS[k];
  this.state = 'idle'; this.emotion = 'neutral'; this.viseme = 'rest';
  this.w = { listen: 0, think: 0, speak: 0, error: 0 };
  this.params = { hueA: 189, hueB: 312, hueBg: 222, sat: 0.92, energy: 0, turb: 1, glow: 1, eyeL: 1, eyeR: 1, speed: 1, jit: 0, brow: 0 };
  this.cam = { yaw: 0, pitch: 0.06, dist: this.user.dist, baseYaw: 0, basePitch: 0.06, distT: this.user.dist, vy: 0, vp: 0 };
  this.gaze = { x: 0, y: 0, tx: 0, ty: 0 };
  this.eyeOpen = { l: 1, r: 1 };
  this.mouth = { rx: MOUTH.rest.rx, ry: MOUTH.rest.ry, curve: 0 };
  this.amp = 0; this.ampT = 0;
  // Duree pendant laquelle un viseme externe (Pocket LAN) doit animer la
  // bouche, meme si le runtime ne joue pas sa propre synthese vocale.
  this.externalSpeech = 0;
  this.t = 0; this.boot = 0; this.pop = 0; this.glitch = 0; this.breath = 0.6;
  this.ringA1 = 0; this.ringA2 = 0;
  this.ripples = []; this.ripClock = 0;
  this.blinkT = 0; this.blinkClock = rand(2.8, 6.6); this.saccClock = rand(1.4, 3.6);
  this.pendingBlinks = []; this.hoverHold = 0; this.emotionClock = 0; this.microGlitch = 0;
  this.shakeX = 0; this.shakeY = 0;
  this.speech = { active: false, script: null, i: 0, start: 0, resolve: null, audioDone: true, prevState: 'idle', lastAt: 0, gen: 0 };
  this.fps = 60; this.dragging = false;
  this.colA = [0.3, 0.8, 1]; this.colB = [1, 0.4, 0.85]; this.colBg = [0.03, 0.05, 0.1]; this.colFace = [1, 1, 1];
  this._defer = true; this._queue = [];
}
Sim.prototype.emit = function (kind, value, extra) {
  if (this._defer) { this._queue.push([kind, value, extra]); return; }
  var cb = this.opts.onEvent;
  if (typeof cb === 'function') {
    try { cb(kind, value, extra); }
    catch (err) { if (typeof console !== 'undefined') console.warn('IRIS onEvent:', err); }
  }
};
Sim.prototype.flush = function () {
  this._defer = false;
  var q = this._queue; this._queue = [];
  for (var i = 0; i < q.length; i++) this.emit(q[i][0], q[i][1], q[i][2]);
};
Sim.prototype.mirror = function () {
  var h = this.host; if (!h) return;
  h.dataset.state = this.state;
  h.dataset.emotion = this.emotion;
  h.dataset.viseme = this.viseme;
  h.style.setProperty('--gaze-x', '0px');
  h.style.setProperty('--gaze-y', '0px');
  h.style.setProperty('--jaw', '0');
};

/* ---------- setters de contrat ---------- */
Sim.prototype.applyState = function (state) {
  if (STATES.indexOf(state) < 0) return;
  var prev = this.state;
  this.state = state;
  if (this.host) this.host.dataset.state = state;
  if (state === 'thinking') this.applyLook(0, 0.75);
  else if (state === 'listening') this.applyLook(0, 0);
  else if (state === 'speaking') this.applyLook(0, -0.08);
  else if (state === 'error') {
    this.applyLook(0, -0.6); this.glitch = 1;
    if (this.audio) this.audio.cue('buzz');
  }
  if (state !== 'speaking') {
    if (this.speech.active) this._finishSpeech(false);
    this.applyViseme('rest', 0);
  }
  if (prev !== state) {
    if (state !== 'error' && this.audio) this.audio.cue('whoosh');
    this.emit('state', state);
  }
};
Sim.prototype.applyEmotion = function (emotion, duration) {
  if (EMOTIONS.indexOf(emotion) < 0) return;
  var changed = this.emotion !== emotion;
  this.emotion = emotion;
  if (this.host) this.host.dataset.emotion = emotion;
  var ms = duration == null ? 2600 : Number(duration);
  this.emotionClock = (emotion !== 'neutral' && ms > 0) ? ms / 1000 : 0;
  if (changed) {
    var pop = EMO[emotion].pop || 0;
    if (pop) this.pop = pop;
    if (emotion !== 'neutral' && this.audio) this.audio.cue('chime');
    this.emit('emotion', emotion);
  }
};
Sim.prototype.applyViseme = function (name, amplitude) {
  var v = VISEMES.indexOf(name) >= 0 ? name : 'rest';
  if (this.viseme !== v) {
    this.viseme = v;
    if (this.host) this.host.dataset.viseme = v;
    this.emit('viseme', v);
  }
  this.ampT = clamp(Number(amplitude) || 0, 0, 1);
  // Le rendu de la bouche suivait uniquement speech.active (synthese interne).
  // On marque une parole externe pour que les visemes de Pocket LAN soient vus.
  this.externalSpeech = (v === 'rest' && this.ampT <= 0.001) ? 0 : 0.7;
};
Sim.prototype.applyLook = function (x, y) {
  this.gaze.tx = clamp(Number(x) || 0, -1, 1);
  this.gaze.ty = clamp(Number(y) || 0, -1, 1);
  this.hoverHold = 2.2;
};
Sim.prototype.applyBlink = function (delay) {
  if (delay > 0) { this.pendingBlinks.push(this.t + delay / 1000); return; }
  this._blinkNow();
};
Sim.prototype._blinkNow = function () {
  this.blinkT = 0.14;
  if (this.host) this.host.classList.add('is-blinking');
};
Sim.prototype._randomGaze = function () {
  switch (this.state) {
    case 'thinking': this.gaze.tx = rand(-0.35, 0.35); this.gaze.ty = rand(0.55, 0.9); break;
    case 'listening': this.gaze.tx = rand(-0.3, 0.3); this.gaze.ty = rand(-0.15, 0.15); break;
    case 'speaking': this.gaze.tx = rand(-0.14, 0.14); this.gaze.ty = rand(-0.2, 0.05); break;
    case 'error': this.gaze.tx = rand(-0.2, 0.2); this.gaze.ty = -0.6; break;
    default:
      if (Math.random() < 0.62) { this.gaze.tx = rand(-0.9, 0.9); this.gaze.ty = rand(-0.25, 0.35); }
      else { this.gaze.tx = rand(-0.35, 0.35); this.gaze.ty = rand(-0.1, 0.1); }
  }
};

/* ---------- mise à jour ---------- */
Sim.prototype.update = function (dt) {
  this.t += dt;
  this.externalSpeech = Math.max(0, this.externalSpeech - dt);
  var u = this.user, p = this.params, e = EMO[this.emotion], pal = PALETTES[u.palette] || PALETTES.neon;
  var k = dt * 3.2;

  this.boot = Math.min(1, this.boot + dt / (this.reduced ? 0.01 : 1.4));
  var bootE = 1 - Math.pow(1 - this.boot, 3);

  if (this.emotion !== 'neutral' && this.emotionClock > 0) {
    this.emotionClock -= dt;
    if (this.emotionClock <= 0) this.applyEmotion('neutral', 0);
  }

  var w = u.mix * e.chroma;
  p.hueA = approachHue(p.hueA, mixHue(pal.a, e.a, w), k);
  p.hueB = approachHue(p.hueB, mixHue(pal.b, e.b, w), k);
  p.hueBg = approachHue(p.hueBg, pal.bg, k);
  p.sat = approach(p.sat, e.sat, k);
  p.energy = approach(p.energy, e.energy * bootE, k);
  p.turb = approach(p.turb, e.turb, k);
  p.glow = approach(p.glow, e.glow, k);
  p.eyeL = approach(p.eyeL, e.eyeL, k);
  p.eyeR = approach(p.eyeR, e.eyeR, k);
  p.speed = approach(p.speed, e.speed, k);
  p.jit = approach(p.jit, e.jit, k);
  p.brow = approach(p.brow, e.brow, k);

  var kw = dt * 5;
  this.w.listen = approach(this.w.listen, this.state === 'listening' ? 1 : 0, kw);
  this.w.think = approach(this.w.think, this.state === 'thinking' ? 1 : 0, kw);
  this.w.speak = approach(this.w.speak, this.state === 'speaking' ? 1 : 0, kw);
  this.w.error = approach(this.w.error, this.state === 'error' ? 1 : 0, kw);

  this.glitch *= Math.exp(-dt * 3.2);
  if (this.state === 'error') {
    this.microGlitch -= dt;
    if (this.microGlitch <= 0) { this.glitch = Math.max(this.glitch, 0.35); this.microGlitch = rand(0.9, 1.8); }
  }
  var g = this.glitch;
  this.shakeX = g > 0.02 ? rand(-1, 1) * g * 7 : 0;
  this.shakeY = g > 0.02 ? rand(-1, 1) * g * 4 : 0;

  var spin = 0.55 * p.speed * u.ring * (1 + this.w.think * 2.4) * (this.reduced ? 0.35 : 1);
  this.ringA1 += dt * spin * 1.2;
  this.ringA2 -= dt * spin * 0.8;

  this.pop *= Math.exp(-dt * 4);
  this.breath = bootE * (1 + 0.02 * Math.sin(this.t * 1.35) * p.energy + this.amp * this.w.speak * 0.06 + this.pop);

  this.amp = approach(this.amp, this.ampT, dt * (this.ampT > this.amp ? 18 : 8));

  var speaking = this.speech.active || this.externalSpeech > 0;
  var shape = speaking ? (MOUTH[this.viseme] || MOUTH.rest) : (MOUTH[e.mouth] || MOUTH.rest);
  var km = dt * 14;
  this.mouth.rx = approach(this.mouth.rx, shape.rx, km);
  this.mouth.ry = approach(this.mouth.ry, shape.ry, km);
  this.mouth.curve = approach(this.mouth.curve, shape.curve, km);

  for (var pb = this.pendingBlinks.length - 1; pb >= 0; pb--) {
    if (this.t >= this.pendingBlinks[pb]) { this.pendingBlinks.splice(pb, 1); this._blinkNow(); }
  }
  var wasBlinking = this.blinkT > 0;
  this.blinkT -= dt;
  if (wasBlinking && this.blinkT <= 0 && this.host) this.host.classList.remove('is-blinking');
  this.eyeOpen.l = approach(this.eyeOpen.l, this.blinkT > 0 ? 0.07 : p.eyeL, dt * 22);
  this.eyeOpen.r = approach(this.eyeOpen.r, this.blinkT > 0 ? 0.07 : p.eyeR, dt * 22);
  if (!this.reduced) {
    this.blinkClock -= dt;
    if (this.blinkClock <= 0) {
      this._blinkNow();
      if (Math.random() < 0.16) this.pendingBlinks.push(this.t + 0.23);
      this.blinkClock = rand(2.8, 6.6);
    }
    this.hoverHold -= dt;
    this.saccClock -= dt;
    if (this.saccClock <= 0 && this.hoverHold <= 0) { this._randomGaze(); this.saccClock = rand(1.4, 3.6); }
  }
  this.gaze.x = approach(this.gaze.x, this.gaze.tx, dt * 3);
  this.gaze.y = approach(this.gaze.y, this.gaze.ty, dt * 3);

  var c = this.cam;
  if (!this.dragging) {
    c.baseYaw += c.vy; c.vy *= 0.92;
    c.basePitch = clamp(c.basePitch + c.vp, -0.55, 0.55); c.vp *= 0.90;
  }
  var sway = this.reduced ? 0 : Math.sin(this.t * 0.10) * 0.30 * u.orbit;
  var swayP = this.reduced ? 0 : Math.sin(this.t * 0.073) * 0.05 * u.orbit;
  var kc = dt * (this.dragging ? 16 : 6);
  c.yaw = approach(c.yaw, c.baseYaw + sway, kc);
  c.pitch = approach(c.pitch, clamp(c.basePitch + swayP, -0.6, 0.6), kc);
  c.dist = approach(c.dist, c.distT, dt * 6);

  this.ripClock -= dt;
  if ((this.state === 'speaking' || this.state === 'listening') && this.ripClock <= 0) {
    var strong = this.state === 'speaking';
    this.ripples.push({ age: 0, strong: strong ? 1 : 0, dir: strong ? 1 : -1 });
    this.ripClock = strong ? 0.30 : 0.78;
    if (!strong && this.audio) this.audio.cue('ping');
  }
  for (var r = this.ripples.length - 1; r >= 0; r--) {
    this.ripples[r].age += dt / 1.15;
    if (this.ripples[r].age > 1) this.ripples.splice(r, 1);
  }
  while (this.ripples.length > 5) this.ripples.shift();

  if (this.speech.active) this._speechTick();

  this.colA = hslToRgb(p.hueA, p.sat, 0.62);
  this.colB = hslToRgb(p.hueB, p.sat, 0.64);
  this.colBg = hslToRgb(p.hueBg, 0.5, 0.07);
  this.colFace = [lerp(1, this.colA[0], 0.18), lerp(1, this.colA[1], 0.18), lerp(1, this.colA[2], 0.18)];
};

/* ---------- parole ---------- */
Sim.prototype.speak = function (text, options) {
  options = options || {};
  var self = this;
  var clean = String(text == null ? '' : text).trim();
  var rate = clamp(Number(options.rate) || this.user.rate || 1, 0.6, 1.8);
  this._finishSpeech(true);
  if (!clean) return Promise.resolve();

  var sp = this.speech;
  var prevState = this.state !== 'speaking' ? this.state : (sp.prevState || 'idle');
  sp.gen += 1;
  var gen = sp.gen;
  sp.active = true;
  sp.script = buildVisemeScript(clean, rate);
  sp.i = 0; sp.start = this.t; sp.prevState = prevState || 'idle';
  sp.lastAt = sp.script.length ? sp.script[sp.script.length - 1].at : 0;
  sp.audioDone = true;
  this.applyState('speaking');
  this.emit('speak-start', null, clean);

  return new Promise(function (resolve) {
    sp.resolve = resolve;
    var mute = self.audio && self.audio.muted;
    if (!mute && typeof window !== 'undefined' && 'speechSynthesis' in window
        && typeof window.SpeechSynthesisUtterance === 'function') {
      sp.audioDone = false;
      var u = new SpeechSynthesisUtterance(clean);
      u.lang = options.lang || 'fr-FR';
      u.rate = rate;
      var v = self.audio && self.audio.pickVoice();
      if (v) u.voice = v;
      u.onend = function () { if (sp.gen === gen) sp.audioDone = true; };
      u.onerror = function () { if (sp.gen === gen) sp.audioDone = true; };
      try { window.speechSynthesis.cancel(); window.speechSynthesis.speak(u); }
      catch (err) { sp.audioDone = true; }
    }
  });
};
Sim.prototype._speechTick = function () {
  var sp = this.speech;
  var elapsed = (this.t - sp.start) * 1000;
  while (sp.i < sp.script.length && sp.script[sp.i].at <= elapsed) {
    var ev = sp.script[sp.i++];
    this.applyViseme(ev.viseme, ev.amp);
  }
  var scriptDone = sp.i >= sp.script.length && elapsed > sp.lastAt + 220;
  /* chien de garde : certains navigateurs n'émettent jamais onend en arrière-plan */
  if (scriptDone && elapsed > sp.lastAt + 5000) sp.audioDone = true;
  if (scriptDone && sp.audioDone) this._finishSpeech(false);
};
Sim.prototype._finishSpeech = function (silent) {
  var sp = this.speech;
  sp.gen += 1; /* invalide les callbacks de l'utterance précédente */
  var wasActive = sp.active;
  sp.active = false; sp.script = null; sp.i = 0;
  var resolve = sp.resolve; sp.resolve = null;
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) { /* déjà arrêté */ }
  }
  if (wasActive) {
    this.applyViseme('rest', 0);
    if (this.state === 'speaking') this.applyState(sp.prevState || 'idle');
    if (!silent) this.emit('speak-end');
  }
  if (resolve) resolve();
};

/* ============================================================
   MOTEUR WEBGL — raymarching SDF, un triangle plein écran
   ============================================================ */
var FRAG = [
'#ifdef GL_FRAGMENT_PRECISION_HIGH',
'precision highp float;',
'#else',
'precision mediump float;',
'#endif',
'uniform vec2 uRes; uniform float uTime;',
'uniform float uYaw, uPitch, uDist;',
'uniform vec3 uColA, uColB, uColBg, uColFace;',
'uniform float uEnergy, uGlow, uTurb, uIrid, uBreath, uAmp, uJit;',
'uniform vec2 uEye, uGaze;',
'uniform vec3 uMouth; uniform float uFace, uBrow;',
'uniform mat3 uR1, uR2; uniform float uRing; uniform vec2 uRingR;',
'uniform vec4 uW; uniform float uGlitch, uBoot;',
'uniform float uDust, uGuides, uSteps;',
'uniform vec2 uCenter, uShake; uniform float uPxScale;',
'uniform vec3 uRip[5];',
'float sq(float x){ return x*x; }',
'float hash(vec3 p){ p=fract(p*0.3183099+vec3(0.1,0.2,0.3)); p*=17.0; return fract(p.x*p.y*p.z*(p.x+p.y+p.z)); }',
'float noise(vec3 p){ vec3 i=floor(p); vec3 f=fract(p); f=f*f*(3.0-2.0*f);',
' return mix(mix(mix(hash(i),hash(i+vec3(1.0,0.0,0.0)),f.x),mix(hash(i+vec3(0.0,1.0,0.0)),hash(i+vec3(1.0,1.0,0.0)),f.x),f.y),',
'            mix(mix(hash(i+vec3(0.0,0.0,1.0)),hash(i+vec3(1.0,0.0,1.0)),f.x),mix(hash(i+vec3(0.0,1.0,1.0)),hash(i+vec3(1.0,1.0,1.0)),f.x),f.y),f.z); }',
'float fbm(vec3 p){ float a=0.5; float s=0.0; for(int i=0;i<3;i++){ s+=a*noise(p); p=p*2.13+vec3(7.7); a*=0.5; } return s; }',
'float sdCore(vec3 p){',
' p.x+=uJit*sin(uTime*37.0)*0.02; p.y+=uJit*cos(uTime*29.0)*0.02;',
' float r=length(p);',
' float maxR=uBreath*1.08+0.24*uTurb+0.06;',
' float bound=r-maxR;',
' if(bound>0.15) return bound;',
' float n=fbm(p*2.4+vec3(0.0,uTime*0.22,uTime*0.13));',
' float swell=uBreath*(1.0+uW.z*uAmp*0.06);',
' return r-swell-(n-0.5)*0.24*uTurb; }',
'vec2 sdRings(vec3 p){',
' if(uRing<0.5) return vec2(1000.0,0.0);',
' vec3 q=uR1*p; float d1=length(vec2(length(q.xz)-uRingR.x,q.y))-0.018;',
' vec3 q2=uR2*p; float d2=length(vec2(length(q2.xz)-uRingR.y,q2.y))-0.013;',
' vec3 qq=d1<d2?q:q2;',
' float dash=0.55+0.45*sin(atan(qq.z,qq.x)*22.0);',
' return vec2(min(d1,d2),dash); }',
'vec3 nrm(vec3 p){ vec2 e=vec2(0.003,-0.003);',
' return normalize(e.xyy*sdCore(p+e.xyy)+e.yyx*sdCore(p+e.yyx)+e.yxy*sdCore(p+e.yxy)+e.xxx*sdCore(p+e.xxx)); }',
'vec3 faceAt(vec2 fp){',
' vec3 acc=vec3(0.0);',
' for(int i=0;i<2;i++){',
'  float sx=i==0?-1.0:1.0;',
'  float op=i==0?uEye.x:uEye.y;',
'  vec2 c=vec2(0.36*sx,0.22)+uGaze*vec2(0.05,0.04);',
'  vec2 q=(fp-c)/vec2(0.155,0.105*max(op,0.06));',
'  float l=length(q);',
'  float ring=1.0-smoothstep(0.06,0.30,abs(l-1.0));',
'  float halo=exp(-l*l*1.4)*0.5;',
'  vec2 pc=q-uGaze*vec2(0.5,0.4);',
'  float pup=1.0-smoothstep(0.30,0.55,length(pc));',
'  float spark=1.0-smoothstep(0.02,0.16,length(pc-vec2(-0.18,0.20)));',
'  vec3 ey=uColFace*(ring*1.15+halo*(0.5+0.5*uGlow));',
'  ey+=vec3(1.0)*spark*0.9*op;',
'  ey*=1.0-pup*0.85;',
'  acc+=ey;',
'  vec2 bq=fp-vec2(0.36*sx,0.44);',
'  float ra=uBrow*0.42*sx; float ca=cos(ra); float sa=sin(ra);',
'  bq=mat2(ca,-sa,sa,ca)*bq;',
'  float bd=length(vec2(max(abs(bq.x)-0.13,0.0),bq.y));',
'  acc+=uColFace*(1.0-smoothstep(0.010,0.028,bd))*abs(uBrow)*0.9;',
' }',
' vec2 mc=vec2(0.0,-0.42)+uGaze*vec2(0.02,0.015);',
' float ry=max(uMouth.y,0.012);',
' vec2 mq=(fp-mc)/vec2(max(uMouth.x,0.02),ry);',
' mq.y-=clamp(uMouth.z/ry,-3.0,3.0)*mq.x*mq.x;',
' float ml=length(mq);',
' float outline=1.0-smoothstep(0.08,0.35,abs(ml-1.0));',
' float inner=(1.0-smoothstep(0.45,1.0,ml))*uAmp*uW.z;',
' acc+=uColFace*(outline*(0.75+0.45*uGlow)+inner*0.8);',
' return acc; }',
'vec3 faceCol(vec3 p){',
' if(uFace<0.5) return vec3(0.0);',
' vec3 sp=normalize(p);',
' float front=smoothstep(0.12,0.42,sp.z);',
' if(front<0.002) return vec3(0.0);',
' vec2 fp=sp.xy/(0.42+0.58*sp.z);',
' vec3 f=faceAt(fp);',
' if(uGlitch>0.01){',
'  vec2 o=vec2(uGlitch*0.035,0.0);',
'  f=vec3(faceAt(fp+o).r,f.g,faceAt(fp-o).b);',
' }',
' return f*front; }',
'vec3 shadeCore(vec3 p, vec3 rd){',
' vec3 n=nrm(p);',
' float ndv=clamp(dot(n,-rd),0.0,1.0);',
' float fres=pow(1.0-ndv,3.0);',
' float pl=fbm(p*3.1-vec3(0.0,uTime*0.35,uTime*0.20));',
' pl=smoothstep(0.32,0.85,pl);',
' vec3 col=mix(uColBg*2.0,uColA*0.30,0.35+0.65*pl)*(0.35+0.65*uEnergy);',
' col+=uColA*pl*(1.0-fres)*0.55*uEnergy;',
' vec3 key=normalize(vec3(0.6,0.85,0.5));',
' vec3 rim=normalize(vec3(-0.7,-0.15,-0.6));',
' float spec=pow(clamp(dot(reflect(rd,n),key),0.0,1.0),64.0);',
' float rl=pow(clamp(dot(n,rim)*0.5+0.5,0.0,1.0),2.0);',
' vec3 irid=0.5+0.5*cos(6.28318*(fres*1.35+pl*0.30)+vec3(0.0,2.1,4.2)+uTime*0.25);',
' vec3 tint=mix(uColA,uColB,0.5);',
' col+=mix(irid,irid*tint*2.0,0.45)*fres*(0.5+0.5*uGlow)*uIrid*1.5;',
' col+=uColB*rl*0.30;',
' col+=vec3(1.0,0.98,0.92)*spec*0.85;',
' col+=faceCol(p);',
' return col; }',
'vec3 ringCol(float dash){',
' return mix(uColB,uColA,0.3)*(0.7+1.1*dash)*(0.9+0.7*uGlow)+vec3(0.9)*pow(dash,6.0)*0.4; }',
'vec3 background(vec3 rd, vec2 uv){',
' float g=uv.y*0.5+0.5;',
' vec3 col=mix(uColBg*0.5,uColBg*1.5+vec3(0.010,0.015,0.030),g);',
' float neb=fbm(vec3(rd.xy*2.3,uTime*0.03));',
' col+=uColB*neb*neb*0.10;',
' col+=uColA*pow(clamp(1.0-length(uv*vec2(0.75,1.0)),0.0,1.0),2.5)*0.10;',
' float ang=atan(uv.y,uv.x); float rad=length(uv);',
' float rays=pow(0.5+0.5*sin(ang*9.0+uTime*0.18),6.0)*exp(-rad*1.6);',
' col+=uColA*rays*(0.05+0.10*uW.y)*uGlow;',
' vec3 sd=rd*140.0; vec3 cell=floor(sd);',
' float h=hash(cell); vec3 f=fract(sd)-0.5;',
' float star=(1.0-smoothstep(0.0,0.12,length(f)))*step(0.982,h);',
' col+=vec3(0.8,0.9,1.0)*star*(0.35+0.35*sin(uTime*2.0+h*40.0));',
' return col; }',
'float dust(vec2 uv){',
' float s=0.0;',
' for(int i=0;i<3;i++){',
'  float fi=float(i);',
'  vec2 p=uv*(3.5+fi*2.5)+vec2(uYaw*(0.35+fi*0.2),uPitch*0.3+uTime*(0.015+fi*0.010));',
'  vec2 c=floor(p); vec2 f=fract(p)-0.5;',
'  float h=fract(sin(dot(c,vec2(127.1,311.7)))*43758.5453);',
'  vec2 off=vec2(fract(h*7.0)-0.5,fract(h*13.0)-0.5)*0.6;',
'  s+=(1.0-smoothstep(0.0,0.06,length(f-off)))*step(1.0-uDust*0.35,h)*(0.4+0.6*fract(h*3.7));',
' }',
' return s; }',
'vec3 pedestal(vec3 col, vec2 frag){',
' vec2 q=(frag-uCenter)/uPxScale;',
' vec2 pq=q; pq.y+=1.55; pq.y/=0.22;',
' float pr=length(pq);',
' float pulse=0.5+0.5*sin(uTime*(1.5+uW.x*1.7));',
' col+=uColA*exp(-pr*pr*1.1)*(0.10+0.10*pulse)*uGlow;',
' if(uGuides>0.5){',
'  for(int i=0;i<3;i++){ float r=0.62+0.30*float(i);',
'   col+=uColA*(1.0-smoothstep(0.0,0.045,abs(pr-r)))*(0.10-0.025*float(i))*(0.7+0.3*pulse); }',
' }',
' vec2 rq=q; rq.y/=0.55;',
' for(int i=0;i<5;i++){',
'  vec3 r=uRip[i];',
'  if(r.x<=1.0){',
'   float rad=r.z>0.0?mix(0.35,1.6,r.x):mix(1.6,0.35,r.x);',
'   float a=(1.0-r.x)*(r.y>0.5?0.30:0.18);',
'   col+=mix(uColA,uColB,0.35)*(1.0-smoothstep(0.0,0.07,abs(length(rq)-rad)))*a;',
'  }',
' }',
' float sy=uCenter.y+(fract(uTime*0.22)*2.3-1.15)*uPxScale;',
' float band=exp(-sq((frag.y-sy)/(uPxScale*0.075)));',
' col+=uColA*band*0.16*uW.y;',
' col+=uColA*(1.0-smoothstep(0.0,1.5,abs(frag.y-sy)))*0.10*uW.y;',
' return col; }',
'vec3 aces(vec3 x){ return clamp((x*(2.51*x+0.03))/(x*(2.43*x+0.59)+0.14),0.0,1.0); }',
'void main(){',
' vec2 frag=gl_FragCoord.xy+uShake;',
' vec2 uv=(frag-0.5*uRes)/uRes.y;',
' if(uGlitch>0.003){',
'  float row=floor(frag.y/7.0);',
'  float tr=hash(vec3(row,floor(uTime*24.0),3.7))-0.5;',
'  uv.x+=tr*uGlitch*0.14*step(0.72,fract(row*0.371+floor(uTime*18.0)*0.618));',
' }',
' vec3 ro=uDist*vec3(sin(uYaw)*cos(uPitch),sin(uPitch),cos(uYaw)*cos(uPitch));',
' vec3 fw=normalize(-ro);',
' vec3 rt=normalize(cross(fw,vec3(0.0,1.0,0.0)));',
' vec3 up=cross(rt,fw);',
' vec3 rd=normalize(fw*1.9+uv.x*rt+uv.y*up);',
' vec3 col=background(rd,uv);',
' float b=dot(ro,rd); float c=dot(ro,ro)-5.76; float h=b*b-c;',
' float gA=0.0; float gB=0.0; float hit=0.0; vec3 hp=vec3(0.0); float hd=0.0;',
' if(h>0.0){',
'  float tN=max(-b-sqrt(h),0.0); float tF=-b+sqrt(h); float t=tN;',
'  for(int i=0;i<80;i++){',
'   if(float(i)>=uSteps||t>tF) break;',
'   vec3 p=ro+rd*t;',
'   float dC=sdCore(p); vec2 rr=sdRings(p); float dR=rr.x;',
'   gA+=exp(-max(dC,0.0)*5.5)*0.020;',
'   gB+=exp(-max(dR,0.0)*8.0)*0.026;',
'   float d=min(dC,dR);',
'   if(d<0.0012+0.0007*t){ hit=dC<dR?1.0:2.0; hp=p; hd=rr.y; break; }',
'   t+=d*0.8;',
'  }',
' }',
' gA=min(gA,1.2); gB=min(gB,1.2);',
' if(hit>0.5){ col=hit<1.5?shadeCore(hp,rd):ringCol(hd); }',
' col+=(uColA*gA+uColB*gB)*(0.45+0.55*uGlow)*uBoot;',
' col+=mix(uColA,uColB,0.4)*dust(uv)*0.30;',
' col=pedestal(col,frag);',
' col+=vec3(1.0,0.15,0.2)*uGlitch*0.10*(0.5+0.5*sin(frag.y*1.7+uTime*40.0));',
' col*=mix(0.15,1.0,uBoot);',
' col+=uColA*exp(-sq((length(uv)-(1.0-uBoot)*1.9)*7.0))*(1.0-uBoot)*0.8;',
' col=aces(col*1.3);',
' col=pow(col,vec3(0.4545));',
' float vig=1.0-0.34*sq(length((frag/uRes-0.5)*vec2(uRes.x/uRes.y,1.0)*1.15));',
' col*=clamp(vig,0.0,1.0);',
' col+=(hash(vec3(frag,fract(uTime)*97.0))-0.5)*0.028;',
' gl_FragColor=vec4(col,1.0);',
'}'
].join('\n');

var VERT = 'attribute vec2 aPos; void main(){ gl_Position=vec4(aPos,0.0,1.0); }';

function GLBackend(canvas) {
  this.canvas = canvas; this.ok = false; this.lost = false;
  this.gl = null;
  var attrs = { antialias: false, alpha: false, depth: false, stencil: false, preserveDrawingBuffer: false, powerPreference: 'high-performance' };
  try {
    this.gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs);
  } catch (e) { this.gl = null; }
  if (!this.gl) return;
  this._init();
}
GLBackend.prototype._init = function () {
  var gl = this.gl;
  function compile(type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      var info = gl.getShaderInfoLog(s); gl.deleteShader(s);
      throw new Error(info || 'shader');
    }
    return s;
  }
  try {
    var fs = compile(gl.FRAGMENT_SHADER, FRAG);
    var vs = compile(gl.VERTEX_SHADER, VERT);
    var prog = gl.createProgram();
    gl.attachShader(prog, vs); gl.attachShader(prog, fs); gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) || 'link');
    gl.deleteShader(vs); gl.deleteShader(fs);
    this.prog = prog;
    gl.useProgram(prog);
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 3,-1, -1,3]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'aPos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.disable(gl.DEPTH_TEST);
    this.u = {};
    var names = ['uRes','uTime','uYaw','uPitch','uDist','uColA','uColB','uColBg','uColFace',
      'uEnergy','uGlow','uTurb','uIrid','uBreath','uAmp','uJit','uEye','uGaze','uMouth','uFace','uBrow',
      'uR1','uR2','uRing','uRingR','uW','uGlitch','uBoot','uDust','uGuides','uSteps','uCenter','uShake','uPxScale','uRip[0]'];
    for (var i = 0; i < names.length; i++) this.u[names[i]] = gl.getUniformLocation(prog, names[i]);
    this.ripArr = new Float32Array(15);
    this.m1 = new Float32Array(9); this.m2 = new Float32Array(9);
    this.ok = true; this.lost = false;
  } catch (err) {
    this.ok = false;
    if (typeof console !== 'undefined') console.warn('IRIS WebGL indisponible:', err);
  }
};
GLBackend.prototype.resize = function (w, h, dpr) {
  if (!this.ok || this.lost) return;
  var W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (this.canvas.width !== W || this.canvas.height !== H) {
    this.canvas.width = W; this.canvas.height = H;
  }
  this.gl.viewport(0, 0, W, H);
  this.w = W; this.h = H;
};
GLBackend.prototype.render = function (sim, steps) {
  if (!this.ok || this.lost) return;
  var gl = this.gl, u = this.u, p = sim.params, c = sim.cam, usr = sim.user;
  var w = this.w, h = this.h;
  gl.useProgram(this.prog);
  gl.uniform2f(u.uRes, w, h);
  gl.uniform1f(u.uTime, sim.t);
  gl.uniform1f(u.uYaw, c.yaw); gl.uniform1f(u.uPitch, c.pitch); gl.uniform1f(u.uDist, c.dist);
  gl.uniform3fv(u.uColA, sim.colA); gl.uniform3fv(u.uColB, sim.colB);
  gl.uniform3fv(u.uColBg, sim.colBg); gl.uniform3fv(u.uColFace, sim.colFace);
  gl.uniform1f(u.uEnergy, p.energy);
  gl.uniform1f(u.uGlow, clamp(p.glow * usr.glow, 0, 2.5));
  gl.uniform1f(u.uTurb, clamp(p.turb * usr.turb, 0, 3));
  gl.uniform1f(u.uIrid, usr.irid);
  gl.uniform1f(u.uBreath, sim.breath);
  gl.uniform1f(u.uAmp, sim.amp);
  gl.uniform1f(u.uJit, p.jit);
  gl.uniform2f(u.uEye, sim.eyeOpen.l, sim.eyeOpen.r);
  gl.uniform2f(u.uGaze, sim.gaze.x, sim.gaze.y);
  gl.uniform3f(u.uMouth, sim.mouth.rx, sim.mouth.ry, sim.mouth.curve);
  gl.uniform1f(u.uFace, usr.face ? 1 : 0);
  gl.uniform1f(u.uBrow, p.brow);
  var pulse = sim.amp * sim.w.speak * 0.10 + sim.w.think * 0.02;
  var a1 = tr3(ringO1(sim.ringA1)), a2 = tr3(ringO2(sim.ringA2));
  for (var i = 0; i < 9; i++) { this.m1[i] = a1[i]; this.m2[i] = a2[i]; }
  gl.uniformMatrix3fv(u.uR1, false, this.m1);
  gl.uniformMatrix3fv(u.uR2, false, this.m2);
  gl.uniform1f(u.uRing, usr.rings ? 1 : 0);
  gl.uniform2f(u.uRingR, (1.42 + pulse) * sim.boot, (1.66 + pulse * 0.6) * sim.boot);
  gl.uniform4f(u.uW, sim.w.listen, sim.w.think, sim.w.speak, sim.w.error);
  gl.uniform1f(u.uGlitch, sim.glitch);
  gl.uniform1f(u.uBoot, 1 - Math.pow(1 - sim.boot, 3));
  gl.uniform1f(u.uDust, usr.dust);
  gl.uniform1f(u.uGuides, usr.guides ? 1 : 0);
  gl.uniform1f(u.uSteps, steps);
  var pxScale = 0.5 * h * 1.9 / Math.sqrt(Math.max(0.1, c.dist * c.dist - 1));
  gl.uniform2f(u.uCenter, w * 0.5, h * 0.5);
  gl.uniform2f(u.uShake, sim.shakeX, sim.shakeY);
  gl.uniform1f(u.uPxScale, pxScale);
  var ra = this.ripArr;
  for (var j = 0; j < 5; j++) {
    var r = sim.ripples[j];
    ra[j * 3] = r ? r.age : 2; ra[j * 3 + 1] = r ? r.strong : 0; ra[j * 3 + 2] = r ? r.dir : 1;
  }
  gl.uniform3fv(u['uRip[0]'], ra);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
};

/* ============================================================
   MOTEUR CANVAS 2D — secours complet, même simulation
   ============================================================ */
function C2DBackend(canvas) {
  this.canvas = canvas;
  this.ctx = canvas.getContext('2d');
  this.ok = !!this.ctx;
  this.w = 1; this.h = 1; this.dpr = 1;
  this.stars = []; this.dustP = [];
  var i;
  for (i = 0; i < 90; i++) this.stars.push({ x: Math.random(), y: Math.random(), r: rand(0.4, 1.3), tw: rand(0, TAU) });
  for (i = 0; i < 70; i++) this.dustP.push({ x: Math.random(), y: Math.random(), z: rand(0.3, 1), s: rand(0.6, 1.8), ph: rand(0, TAU) });
  this.plasma = [];
  for (var k = 0; k < 3; k++) {
    var off = document.createElement('canvas'); off.width = off.height = 160;
    var oc = off.getContext('2d');
    if (oc) {
      for (var b = 0; b < 34; b++) {
        var x = rand(20, 140), y = rand(20, 140), r = rand(8, 34);
        var g = oc.createRadialGradient(x, y, 0, x, y, r);
        g.addColorStop(0, 'rgba(255,255,255,' + rand(0.05, 0.16).toFixed(3) + ')');
        g.addColorStop(1, 'rgba(255,255,255,0)');
        oc.fillStyle = g; oc.beginPath(); oc.arc(x, y, r, 0, TAU); oc.fill();
      }
    }
    this.plasma.push(off);
  }
  this.ringPts = [];
  for (i = 0; i < 72; i++) this.ringPts.push(i / 72 * TAU);
}
C2DBackend.prototype.resize = function (w, h, dpr) {
  var W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
  if (this.canvas.width !== W || this.canvas.height !== H) { this.canvas.width = W; this.canvas.height = H; }
  this.w = W; this.h = H; this.dpr = dpr;
};
C2DBackend.prototype._basis = function (cam) {
  var cy = Math.cos(cam.yaw), sy = Math.sin(cam.yaw), cp = Math.cos(cam.pitch), sp = Math.sin(cam.pitch);
  return {
    ro: [cam.dist * sy * cp, cam.dist * sp, cam.dist * cy * cp],
    fw: [-sy * cp, -sp, -cy * cp],
    rt: [cy, 0, -sy],
    up: [-sy * sp, cp, -cy * sp]
  };
};
C2DBackend.prototype.render = function (sim) {
  var ctx = this.ctx; if (!ctx) return;
  var w = this.w, h = this.h, p = sim.params, usr = sim.user, c = sim.cam;
  var hueA = p.hueA, hueB = p.hueB, sat = Math.round(p.sat * 100);
  var glow = clamp(p.glow * usr.glow, 0, 2.5), turb = clamp(p.turb * usr.turb, 0, 3);
  var boot = 1 - Math.pow(1 - sim.boot, 3);
  var dpr = this.dpr;
  var cx = w * 0.5 + sim.shakeX * dpr, cy = h * 0.5 + sim.shakeY * dpr;
  var S = 0.5 * h * 1.9 / Math.sqrt(Math.max(0.1, c.dist * c.dist - 1));
  var B = this._basis(c);
  var i;
  function col(hue, l, a) { return 'hsla(' + hue.toFixed(0) + ',' + sat + '%,' + l + '%,' + a.toFixed(3) + ')'; }
  function proj(x, y, z) {
    var dx = x - B.ro[0], dy = y - B.ro[1], dz = z - B.ro[2];
    var zz = dx * B.fw[0] + dy * B.fw[1] + dz * B.fw[2];
    if (zz < 0.2) return null;
    var s = 1.9 / zz * h * 0.5;
    return { x: cx + (dx * B.rt[0] + dy * B.rt[1] + dz * B.rt[2]) * s, y: cy - (dx * B.up[0] + dy * B.up[1] + dz * B.up[2]) * s, z: zz, s: s };
  }
  /* fond */
  var bg = ctx.createRadialGradient(cx, cy * 0.9, 0, cx, cy, Math.max(w, h) * 0.75);
  bg.addColorStop(0, col(p.hueBg, 12, 1)); bg.addColorStop(0.5, '#070b16'); bg.addColorStop(1, '#04060d');
  ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
  /* étoiles */
  for (i = 0; i < this.stars.length; i++) {
    var st = this.stars[i];
    var sx = (((st.x + c.yaw * 0.05) % 1) + 1) % 1 * w;
    var sy2 = (((st.y + c.pitch * 0.05) % 1) + 1) % 1 * h;
    ctx.fillStyle = 'rgba(200,225,255,' + (0.15 + 0.2 * Math.abs(Math.sin(sim.t * 1.5 + st.tw))).toFixed(3) + ')';
    ctx.fillRect(sx, sy2, st.r * dpr, st.r * dpr);
  }
  /* poussière */
  var dustN = Math.round(this.dustP.length * usr.dust);
  for (i = 0; i < dustN; i++) {
    var d = this.dustP[i];
    var dx2 = (((d.x + c.yaw * 0.08 * d.z + sim.t * 0.008 * d.z) % 1) + 1) % 1 * w;
    var dy2 = (((d.y + Math.sin(sim.t * 0.3 + d.ph) * 0.01) % 1) + 1) % 1 * h;
    ctx.fillStyle = col(lerp(hueA, hueB, d.z), 75, 0.10 + 0.16 * d.z);
    ctx.beginPath(); ctx.arc(dx2, dy2, d.s * dpr * d.z, 0, TAU); ctx.fill();
  }
  /* socle */
  if (usr.guides) {
    var by = cy + S * 1.55;
    var pulse = 0.5 + 0.5 * Math.sin(sim.t * (1.5 + sim.w.listen * 1.7));
    var gl2 = ctx.createRadialGradient(cx, by, 0, cx, by, S * 1.25);
    gl2.addColorStop(0, col(hueA, 60, (0.10 + 0.10 * pulse) * glow)); gl2.addColorStop(1, col(hueA, 50, 0));
    ctx.fillStyle = gl2; ctx.beginPath(); ctx.ellipse(cx, by, S * 1.25, S * 0.28, 0, 0, TAU); ctx.fill();
    ctx.lineWidth = dpr;
    for (i = 0; i < 3; i++) {
      var rr = S * (0.62 + i * 0.30);
      ctx.strokeStyle = col(hueA, 65, (0.12 - i * 0.03) * (0.7 + 0.3 * pulse));
      ctx.beginPath(); ctx.ellipse(cx, by, rr, rr * 0.22, 0, 0, TAU); ctx.stroke();
    }
  }
  /* ondes */
  for (i = 0; i < sim.ripples.length; i++) {
    var rp = sim.ripples[i];
    var rad = rp.dir > 0 ? lerp(0.35, 1.6, rp.age) : lerp(1.6, 0.35, rp.age);
    ctx.strokeStyle = col(lerp(hueA, hueB, 0.35), 70, (1 - rp.age) * (rp.strong ? 0.30 : 0.18));
    ctx.lineWidth = (rp.strong ? 1.8 : 1.2) * dpr;
    ctx.beginPath(); ctx.ellipse(cx, cy, S * rad, S * rad * 0.55, 0, 0, TAU); ctx.stroke();
  }
  /* anneaux */
  var self = this;
  var zCenter = c.dist;
  var rings = [
    { R: (1.42 + sim.amp * sim.w.speak * 0.10) * sim.boot, O: ringO1(sim.ringA1), hue: hueB, lw: 1.7 },
    { R: (1.66 + sim.amp * sim.w.speak * 0.06) * sim.boot, O: ringO2(sim.ringA2), hue: hueA, lw: 1.2 }
  ];
  function ringPoint(rg, a) {
    var lx = rg.R * Math.cos(a), lz = rg.R * Math.sin(a), O = rg.O;
    return [O[0] * lx + O[6] * lz, O[1] * lx + O[7] * lz, O[2] * lx + O[8] * lz];
  }
  function ringPass(front) {
    if (!usr.rings) return;
    for (var r = 0; r < rings.length; r++) {
      var rg = rings[r];
      ctx.lineWidth = rg.lw * dpr;
      for (var s2 = 0; s2 < self.ringPts.length; s2++) {
        var a0 = self.ringPts[s2], a1 = self.ringPts[(s2 + 1) % self.ringPts.length];
        var p0 = ringPoint(rg, a0), p1 = ringPoint(rg, a1);
        var q0 = proj(p0[0], p0[1], p0[2]), q1 = proj(p1[0], p1[1], p1[2]);
        if (!q0 || !q1) continue;
        var isFront = (q0.z + q1.z) * 0.5 < zCenter;
        if (isFront !== front) continue;
        var dash = 0.55 + 0.45 * Math.sin(a0 * 22);
        ctx.strokeStyle = col(rg.hue, 70, (0.25 + 0.55 * dash) * (front ? 1 : 0.45) * (0.6 + 0.4 * glow) * boot);
        ctx.beginPath(); ctx.moveTo(q0.x, q0.y); ctx.lineTo(q1.x, q1.y); ctx.stroke();
      }
    }
  }
  ringPass(false);
  /* noyau */
  var R = Math.max(2, S * sim.breath);
  var core = ctx.createRadialGradient(cx - R * 0.25, cy - R * 0.3, R * 0.1, cx, cy, R);
  core.addColorStop(0, col(hueA, 30 + 20 * p.energy, 1));
  core.addColorStop(0.55, col(p.hueBg, 14, 1));
  core.addColorStop(0.85, col(hueA, 22, 1));
  core.addColorStop(1, col(hueA, 45, 1));
  ctx.save();
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, TAU); ctx.clip();
  ctx.fillStyle = core; ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
  ctx.globalCompositeOperation = 'lighter';
  for (i = 0; i < 3; i++) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(sim.t * (0.1 + i * 0.07) * (i % 2 ? -1 : 1) * p.speed);
    var sc = R * 2 / 160 * (1 + 0.08 * turb * Math.sin(sim.t * 0.7 + i * 2));
    ctx.scale(sc, sc);
    ctx.globalAlpha = clamp((0.25 + 0.35 * p.energy) * boot, 0, 1);
    ctx.drawImage(this.plasma[i], -80, -80);
    ctx.restore();
  }
  ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over';
  ctx.restore();
  /* halo + fresnel + iridescence */
  var halo = ctx.createRadialGradient(cx, cy, R * 0.8, cx, cy, R * 1.7);
  halo.addColorStop(0, col(hueA, 60, clamp(0.14 * glow * boot, 0, 1))); halo.addColorStop(1, col(hueA, 50, 0));
  ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(cx, cy, R * 1.7, 0, TAU); ctx.fill();
  ctx.lineWidth = R * 0.05;
  ctx.strokeStyle = col(hueB, 70, clamp(0.35 * glow * boot, 0, 1));
  ctx.beginPath(); ctx.arc(cx, cy, R * 0.985, 0, TAU); ctx.stroke();
  for (i = 0; i < 3; i++) {
    ctx.lineWidth = R * 0.02;
    ctx.strokeStyle = 'hsla(' + ((hueA + 40 + i * 45) % 360).toFixed(0) + ',95%,72%,' + (0.28 * usr.irid * boot).toFixed(3) + ')';
    ctx.beginPath(); ctx.arc(cx, cy, R * (0.90 + i * 0.03), sim.t * 0.2 + i * 2.1, sim.t * 0.2 + i * 2.1 + 1.1); ctx.stroke();
  }
  /* visage */
  var facing = Math.cos(c.yaw) * Math.cos(c.pitch);
  if (usr.face && facing > 0.15) {
    var fa = clamp((facing - 0.15) / 0.5, 0, 1) * boot;
    var faceCol = 'rgba(235,248,255,';
    var fproj = function (x, y) {
      var z = Math.sqrt(Math.max(0.05, 1 - x * x - y * y));
      return proj(x * sim.breath, y * sim.breath, z * sim.breath * 1.02);
    };
    for (i = 0; i < 2; i++) {
      var sgn = i === 0 ? -1 : 1;
      var open = i === 0 ? sim.eyeOpen.l : sim.eyeOpen.r;
      var ex = 0.34 * sgn + sim.gaze.x * 0.05, ey = 0.21 + sim.gaze.y * 0.04;
      var ec = fproj(ex, ey); if (!ec) continue;
      var erx = ec.s * 0.15, ery = ec.s * 0.10 * Math.max(open, 0.06);
      var eg = ctx.createRadialGradient(ec.x, ec.y, 0, ec.x, ec.y, erx * 2.2);
      eg.addColorStop(0, faceCol + (0.22 * fa * glow).toFixed(3) + ')'); eg.addColorStop(1, faceCol + '0)');
      ctx.fillStyle = eg; ctx.beginPath(); ctx.arc(ec.x, ec.y, erx * 2.2, 0, TAU); ctx.fill();
      ctx.strokeStyle = faceCol + (0.9 * fa).toFixed(3) + ')';
      ctx.lineWidth = 1.6 * dpr;
      ctx.beginPath(); ctx.ellipse(ec.x, ec.y, erx, ery, 0, 0, TAU); ctx.stroke();
      var px = ec.x + sim.gaze.x * erx * 0.45, py = ec.y - sim.gaze.y * ery * 0.4;
      ctx.fillStyle = 'rgba(3,7,16,' + (0.9 * fa).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(px, py, erx * 0.4 * Math.max(open, 0.1), 0, TAU); ctx.fill();
      ctx.fillStyle = faceCol + (0.95 * fa * open).toFixed(3) + ')';
      ctx.beginPath(); ctx.arc(px - erx * 0.15, py - ery * 0.2, Math.max(1, erx * 0.09), 0, TAU); ctx.fill();
      if (Math.abs(p.brow) > 0.05) {
        var bc = fproj(0.34 * sgn, 0.42);
        if (bc) {
          ctx.save(); ctx.translate(bc.x, bc.y); ctx.rotate(p.brow * 0.42 * sgn);
          ctx.strokeStyle = faceCol + (0.8 * fa * Math.abs(p.brow)).toFixed(3) + ')';
          ctx.lineWidth = 2 * dpr;
          ctx.beginPath(); ctx.moveTo(-bc.s * 0.12, 0); ctx.lineTo(bc.s * 0.12, 0); ctx.stroke();
          ctx.restore();
        }
      }
    }
    var m = sim.mouth;
    ctx.beginPath();
    var started = false;
    for (var mi = 0; mi <= 26; mi++) {
      var ma = mi / 26 * TAU;
      var mx = m.rx * Math.cos(ma);
      var my = -0.40 + m.ry * Math.sin(ma) + m.curve * Math.cos(ma) * Math.cos(ma);
      var mq = fproj(mx, my); if (!mq) continue;
      if (!started) { ctx.moveTo(mq.x, mq.y); started = true; } else ctx.lineTo(mq.x, mq.y);
    }
    if (started) {
      ctx.closePath();
      if (sim.amp > 0.1) { ctx.fillStyle = col(hueB, 75, 0.35 * sim.amp * fa); ctx.fill(); }
      ctx.strokeStyle = faceCol + (0.85 * fa).toFixed(3) + ')';
      ctx.lineWidth = 1.5 * dpr; ctx.stroke();
      var mc = fproj(0, -0.40);
      if (mc) {
        var mglow = ctx.createRadialGradient(mc.x, mc.y, 0, mc.x, mc.y, mc.s * 0.24);
        mglow.addColorStop(0, col(hueB, 72, clamp((0.10 + 0.22 * sim.amp) * fa * glow, 0, 1)));
        mglow.addColorStop(1, col(hueB, 60, 0));
        ctx.fillStyle = mglow; ctx.beginPath(); ctx.arc(mc.x, mc.y, mc.s * 0.24, 0, TAU); ctx.fill();
      }
    }
  }
  ringPass(true);
  /* balayage réflexion */
  if (sim.w.think > 0.02) {
    var scanY = cy - S * 1.15 + ((sim.t * 0.22) % 1) * S * 2.3;
    var band = ctx.createLinearGradient(0, scanY - S * 0.09, 0, scanY + S * 0.09);
    band.addColorStop(0, col(hueA, 70, 0));
    band.addColorStop(0.5, col(hueA, 78, 0.13 * sim.w.think));
    band.addColorStop(1, col(hueA, 70, 0));
    ctx.fillStyle = band; ctx.fillRect(cx - S * 1.25, scanY - S * 0.09, S * 2.5, S * 0.18);
  }
  /* glitch */
  if (sim.glitch > 0.02) {
    for (i = 0; i < 5; i++) {
      var gy = rand(h * 0.15, h * 0.85), gh = rand(1, 5) * dpr;
      ctx.fillStyle = 'hsla(2,95%,65%,' + (rand(0.06, 0.18) * sim.glitch).toFixed(3) + ')';
      ctx.fillRect(rand(0, w * 0.2), gy, w * rand(0.4, 0.85), gh);
    }
  }
  /* vignette */
  var vig = ctx.createRadialGradient(cx, cy, Math.min(w, h) * 0.35, cx, cy, Math.max(w, h) * 0.75);
  vig.addColorStop(0, 'rgba(0,0,0,0)'); vig.addColorStop(1, 'rgba(2,4,10,0.55)');
  ctx.fillStyle = vig; ctx.fillRect(0, 0, w, h);
  if (boot < 1) { ctx.fillStyle = 'rgba(4,6,13,' + (1 - boot).toFixed(3) + ')'; ctx.fillRect(0, 0, w, h); }
};

/* ============================================================
   AUDIO — ambiance + cues, chaque son est lié à un événement visible
   ============================================================ */
function IrisAudio() {
  this.muted = false; this.ctx = null; this.voice = null; this._duck = 1;
  var self = this;
  this._voicesHandler = function () { self._pick(); };
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try {
      window.speechSynthesis.addEventListener('voiceschanged', this._voicesHandler);
      this._pick();
    } catch (e) { /* anciens navigateurs */ }
  }
}
IrisAudio.prototype._pick = function () {
  try {
    var vs = window.speechSynthesis.getVoices();
    this.voice = null;
    for (var i = 0; i < vs.length; i++) if (/^fr/i.test(vs[i].lang)) { this.voice = vs[i]; break; }
  } catch (e) { /* ignoré */ }
};
IrisAudio.prototype.pickVoice = function () { return this.voice; };
IrisAudio.prototype.ensure = function () {
  if (this.ctx || this.muted) return;
  var AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    var ctx = this.ctx = new AC();
    this.master = ctx.createGain(); this.master.gain.value = 0.8;
    var comp = ctx.createDynamicsCompressor();
    this.master.connect(comp); comp.connect(ctx.destination);
    this.ambGain = ctx.createGain(); this.ambGain.gain.value = 0.0;
    this.ambFilter = ctx.createBiquadFilter();
    this.ambFilter.type = 'lowpass'; this.ambFilter.frequency.value = 240; this.ambFilter.Q.value = 0.7;
    this.ambGain.connect(this.ambFilter); this.ambFilter.connect(this.master);
    var o1 = ctx.createOscillator(); o1.type = 'sine'; o1.frequency.value = 55;
    var o2 = ctx.createOscillator(); o2.type = 'sine'; o2.frequency.value = 82.41; o2.detune.value = 6;
    var g1 = ctx.createGain(); g1.gain.value = 0.5;
    var g2 = ctx.createGain(); g2.gain.value = 0.35;
    o1.connect(g1); g1.connect(this.ambGain);
    o2.connect(g2); g2.connect(this.ambGain);
    o1.start(); o2.start();
    this.ambGain.gain.setTargetAtTime(0.05, ctx.currentTime, 1.2);
  } catch (e) { this.ctx = null; }
};
IrisAudio.prototype.resume = function () {
  if (this.ctx && this.ctx.state === 'suspended') { try { this.ctx.resume(); } catch (e) { /* ignoré */ } }
};
IrisAudio.prototype.update = function (sim) {
  if (!this.ctx || this.muted) return;
  var t = this.ctx.currentTime;
  var cutoff = 220 + sim.params.energy * 120 + sim.w.think * 380 + sim.w.speak * 160;
  this.ambFilter.frequency.setTargetAtTime(cutoff, t, 0.4);
  var breath = 0.040 + 0.014 * Math.sin(sim.t * 1.35) + sim.w.listen * 0.012;
  this.ambGain.gain.setTargetAtTime(Math.max(0.0001, breath * this._duck), t, 0.5);
};
IrisAudio.prototype.setMuted = function (m) {
  this.muted = m;
  if (!m) { this.ensure(); this.resume(); }
  if (this.ctx) this.master.gain.setTargetAtTime(m ? 0 : 0.8, this.ctx.currentTime, 0.08);
  if (m && typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.cancel(); } catch (e) { /* ignoré */ }
  }
};
IrisAudio.prototype.duck = function (d) { this._duck = d; };
IrisAudio.prototype.cue = function (name) {
  if (!this.ctx || this.muted) return;
  var ctx = this.ctx, t = ctx.currentTime, self = this;
  function env(node, peak, dur) {
    var g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    node.connect(g); g.connect(self.master);
    return g;
  }
  try {
    if (name === 'ping') {
      var o = ctx.createOscillator(); o.type = 'sine';
      o.frequency.setValueAtTime(660, t); o.frequency.exponentialRampToValueAtTime(330, t + 0.18);
      env(o, 0.035, 0.2); o.start(t); o.stop(t + 0.22);
    } else if (name === 'whoosh') {
      var len = Math.floor(ctx.sampleRate * 0.3), buf = ctx.createBuffer(1, len, ctx.sampleRate);
      var ch = buf.getChannelData(0);
      for (var i = 0; i < len; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / len);
      var src = ctx.createBufferSource(); src.buffer = buf;
      var f = ctx.createBiquadFilter(); f.type = 'bandpass'; f.Q.value = 1.2;
      f.frequency.setValueAtTime(300, t); f.frequency.exponentialRampToValueAtTime(1400, t + 0.25);
      src.connect(f); env(f, 0.05, 0.3); src.start(t);
    } else if (name === 'chime') {
      [523.25, 784.9].forEach(function (fr, idx) {
        var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
        var g = ctx.createGain(); var tt = t + idx * 0.06;
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.03, tt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.3);
        o.connect(g); g.connect(self.master); o.start(tt); o.stop(tt + 0.32);
      });
    } else if (name === 'buzz') {
      var ob = ctx.createOscillator(); ob.type = 'square';
      ob.frequency.setValueAtTime(110, t); ob.frequency.exponentialRampToValueAtTime(70, t + 0.3);
      var fb = ctx.createBiquadFilter(); fb.type = 'lowpass'; fb.frequency.value = 500;
      ob.connect(fb); env(fb, 0.05, 0.32); ob.start(t); ob.stop(t + 0.34);
    } else if (name === 'click') {
      var oc = ctx.createOscillator(); oc.type = 'triangle'; oc.frequency.value = 1200;
      env(oc, 0.03, 0.07); oc.start(t); oc.stop(t + 0.08);
    } else if (name === 'arp') {
      [392, 523.25, 659.25].forEach(function (fr, idx) {
        var o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = fr;
        var g = ctx.createGain(); var tt = t + idx * 0.09;
        g.gain.setValueAtTime(0.0001, tt);
        g.gain.exponentialRampToValueAtTime(0.035, tt + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, tt + 0.25);
        o.connect(g); g.connect(self.master); o.start(tt); o.stop(tt + 0.27);
      });
    }
  } catch (e) { /* jamais bloquant */ }
};
IrisAudio.prototype.destroy = function () {
  if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
    try { window.speechSynthesis.removeEventListener('voiceschanged', this._voicesHandler); } catch (e) { /* ignoré */ }
  }
  if (this.ctx) { try { this.ctx.close(); } catch (e) { /* ignoré */ } this.ctx = null; }
};

/* ============================================================
   DÉMO — chorégraphie pilotée par l'horloge de simulation
   ============================================================ */
var DEMO = [
  { wait: 0.1, run: function (rt) { rt.sim.applyState('listening'); } },
  { wait: 1.2, run: function (rt) { rt.setEmotion('curious', 2200); } },
  { wait: 1.1, run: function (rt) { rt.sim.applyState('thinking'); } },
  { wait: 1.6, speech: true, run: function (rt) { rt.speak("Bonjour ! Je suis Iris, un noyau de verre vivant."); } },
  { wait: 0.3, run: function (rt) { rt.setEmotion('happy', 2600); } },
  { wait: 2.2, run: function (rt) { rt.sim.applyState('thinking'); } },
  { wait: 1.4, speech: true, run: function (rt) { rt.speak("Je peux écouter, réfléchir, et parler avec vous."); } },
  { wait: 0.4, run: function (rt) { rt.setEmotion('sleepy', 2600); } },
  { wait: 2.6, run: function (rt) { rt.sim.applyState('idle'); rt.look(0, 0); } },
  { wait: 1.2, run: function (rt) { rt.setEmotion('neutral', 0); } }
];

/* ============================================================
   RUNTIME — API publique, moteurs, entrées, boucle unique
   ============================================================ */
function IrisAvatarRuntime(host, options) {
  if (!host) throw new Error('IrisAvatarRuntime : conteneur manquant');
  options = options || {};
  this.host = host;
  var self = this;

  this.glCanvas = document.createElement('canvas');
  this.fxCanvas = document.createElement('canvas');
  this.glCanvas.setAttribute('aria-hidden', 'true');
  this.fxCanvas.setAttribute('aria-hidden', 'true');
  host.insertBefore(this.fxCanvas, host.firstChild);
  host.insertBefore(this.glCanvas, host.firstChild);
  if (typeof getComputedStyle === 'function' && getComputedStyle(host).position === 'static') host.style.position = 'relative';
  host.style.touchAction = 'none';

  this.audio = new IrisAudio();
  options.audio = this.audio;
  options.host = host;
  this.sim = new Sim(options);
  this.sim.mirror();
  this.soundOn = true;

  this.gl = new GLBackend(this.glCanvas);
  this.c2d = null;
  this.engine = '2d';
  this._renderErrors = 0;
  this._lostHandler = function (e) {
    e.preventDefault(); self.gl.lost = true;
    self._useEngine('2d');
    self.sim.emit('log', 'moteur', 'contexte WebGL perdu — bascule Canvas 2D');
  };
  this._restoredHandler = function () {
    self.gl._init();
    if (self.gl.ok && (self.sim.user.engine === 'auto' || self.sim.user.engine === 'gl')) self._useEngine('webgl');
  };
  this.glCanvas.addEventListener('webglcontextlost', this._lostHandler);
  this.glCanvas.addEventListener('webglcontextrestored', this._restoredHandler);
  this._useEngine(this.gl.ok ? 'webgl' : '2d');
  if (!this.gl.ok) this.sim.emit('log', 'moteur', 'WebGL indisponible — moteur Canvas 2D');

  /* pointeurs : orbite, inertie, pincement, regard au survol */
  this._pointers = new Map();
  this._pinchDist = 0;
  this._onDown = function (e) {
    self.audio.ensure(); self.audio.resume();
    self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (self._pointers.size === 1) {
      self.sim.dragging = true; self.sim.cam.vy = 0; self.sim.cam.vp = 0;
      host.classList.add('is-dragging');
    } else if (self._pointers.size === 2) {
      var pts = Array.from(self._pointers.values());
      self._pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    }
    try { host.setPointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
  };
  this._onMove = function (e) {
    var rect = host.getBoundingClientRect();
    if (!self._pointers.has(e.pointerId)) {
      if (rect.width > 0 && e.pointerType !== 'touch') {
        var nx = (e.clientX - rect.left) / rect.width * 2 - 1;
        var ny = (e.clientY - rect.top) / rect.height * 2 - 1;
        self.sim.gaze.tx = clamp(nx * 0.6, -1, 1);
        self.sim.gaze.ty = clamp(-ny * 0.45, -1, 1);
        self.sim.hoverHold = 1.4;
      }
      return;
    }
    var prev = self._pointers.get(e.pointerId);
    var dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    self._pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (self._pointers.size === 2) {
      var pts = Array.from(self._pointers.values());
      var d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      if (self._pinchDist > 0 && d > 0) {
        self.sim.cam.distT = clamp(self.sim.cam.distT * self._pinchDist / d, 2.5, 7.5);
        self.sim.user.dist = self.sim.cam.distT;
      }
      self._pinchDist = d;
      return;
    }
    var cam = self.sim.cam;
    cam.baseYaw += dx * 0.0052;
    cam.basePitch = clamp(cam.basePitch + dy * 0.0042, -0.55, 0.55);
    cam.vy = dx * 0.0013; cam.vp = dy * 0.0007;
  };
  this._onUp = function (e) {
    self._pointers.delete(e.pointerId);
    if (self._pointers.size === 0) { self.sim.dragging = false; host.classList.remove('is-dragging'); }
    self._pinchDist = 0;
    try { host.releasePointerCapture(e.pointerId); } catch (err) { /* ignoré */ }
  };
  this._onWheel = function (e) {
    e.preventDefault();
    var cam = self.sim.cam;
    cam.distT = clamp(cam.distT * Math.exp(e.deltaY * 0.0012), 2.5, 7.5);
    self.sim.user.dist = cam.distT;
  };
  this._onDbl = function () { self.resetView(); };
  host.addEventListener('pointerdown', this._onDown);
  host.addEventListener('pointermove', this._onMove);
  host.addEventListener('pointerup', this._onUp);
  host.addEventListener('pointercancel', this._onUp);
  host.addEventListener('wheel', this._onWheel, { passive: false });
  host.addEventListener('dblclick', this._onDbl);

  /* dimensionnement */
  this._w = 0; this._h = 0; this._dpr = 0;
  this._onResize = function () { self._resize(true); };
  if (typeof ResizeObserver === 'function') {
    this._ro = new ResizeObserver(this._onResize);
    this._ro.observe(host);
  } else {
    window.addEventListener('resize', this._onResize);
  }
  this._resize(true);

  /* visibilité + prefers-reduced-motion */
  this._paused = typeof document !== 'undefined' && !!document.hidden;
  this._onVis = function () { self.setPaused(document.hidden); };
  document.addEventListener('visibilitychange', this._onVis);
  if (typeof matchMedia === 'function') {
    this._mq = matchMedia('(prefers-reduced-motion: reduce)');
    this._onMq = function () { self.sim.reduced = self._mq.matches; };
    if (this._mq.addEventListener) this._mq.addEventListener('change', this._onMq);
  }
  this._gesture = function () { if (self.soundOn) { self.audio.ensure(); self.audio.resume(); } };
  window.addEventListener('pointerdown', this._gesture, { once: true });
  window.addEventListener('keydown', this._gesture, { once: true });

  /* démo + boucle unique */
  this.demo = { active: false, i: 0, timer: 0, waitSpeech: false };
  this._last = 0; this._frameCount = 0; this._audioClock = 0;
  this._boundLoop = function (ts) { self._loop(ts); };
  this._raf = requestAnimationFrame(this._boundLoop);

  /* les événements émis pendant la construction partent après le script appelant */
  var flush = function () { self.sim.flush(); };
  if (typeof Promise === 'function') Promise.resolve().then(flush);
  else setTimeout(flush, 0);
}

IrisAvatarRuntime.STATES = STATES;
IrisAvatarRuntime.EMOTIONS = EMOTIONS;
IrisAvatarRuntime.VISEMES = VISEMES;

IrisAvatarRuntime.prototype._useEngine = function (name) {
  if (name === 'webgl' && (!this.gl.ok || this.gl.lost)) name = '2d';
  if (name === '2d' && !this.c2d) this.c2d = new C2DBackend(this.fxCanvas);
  if (name === '2d' && !this.c2d.ok) name = 'webgl';
  this.engine = name;
  this.glCanvas.style.display = name === 'webgl' ? 'block' : 'none';
  this.fxCanvas.style.display = name === '2d' ? 'block' : 'none';
  this._resize(true);
  this.sim.emit('engine', name);
};
IrisAvatarRuntime.prototype.engineName = function () { return this.engine; };

IrisAvatarRuntime.prototype._resize = function (force) {
  var rect = this.host.getBoundingClientRect();
  var w = Math.max(1, Math.round(rect.width || this.host.clientWidth || 300));
  var h = Math.max(1, Math.round(rect.height || this.host.clientHeight || 300));
  var q = QUALITY[this.sim.user.quality] || QUALITY.std;
  var dpr = Math.min(q.dprCap, window.devicePixelRatio || 1) * q.scale;
  if (!force && w === this._w && h === this._h && Math.abs(dpr - this._dpr) < 0.001) return;
  this._w = w; this._h = h; this._dpr = dpr;
  if (this.gl.ok && !this.gl.lost) this.gl.resize(w, h, dpr);
  if (this.c2d) this.c2d.resize(w, h, dpr);
};

IrisAvatarRuntime.prototype._loop = function (ts) {
  if (this._paused) { this._raf = 0; return; }
  if (!this._last) this._last = ts;
  var dt = clamp((ts - this._last) / 1000, 0, 0.05);
  this._last = ts;
  this.sim.fps = lerp(this.sim.fps, dt > 0 ? 1 / dt : 60, 0.06);
  this.sim.update(dt);
  if (this.demo.active) this._demoTick(dt);
  this._frameCount++;
  if (this._frameCount % 45 === 0) this._resize(false);
  var q = QUALITY[this.sim.user.quality] || QUALITY.std;
  try {
    if (this.engine === 'webgl') this.gl.render(this.sim, q.steps);
    else this.c2d.render(this.sim);
  } catch (err) {
    this._renderErrors++;
    if (this._renderErrors < 4 && typeof console !== 'undefined') console.warn('IRIS rendu:', err);
    if (this.engine === 'webgl') { this.gl.ok = false; this._useEngine('2d'); }
  }
  this.host.style.setProperty('--jaw', this.sim.amp.toFixed(2));
  this.host.style.setProperty('--gaze-x', (this.sim.gaze.x * 6).toFixed(1) + 'px');
  this.host.style.setProperty('--gaze-y', (-this.sim.gaze.y * 5).toFixed(1) + 'px');
  this._audioClock -= dt;
  if (this._audioClock <= 0) { this.audio.update(this.sim); this._audioClock = 0.12; }
  var cb = this.sim.opts.onFrame;
  if (typeof cb === 'function') {
    var active = this.engine === 'webgl' ? this.gl : this.c2d;
    try {
      cb(this.sim, { fps: this.sim.fps, engine: this.engine, steps: q.steps, w: active.w || 1, h: active.h || 1 });
    } catch (err2) { if (typeof console !== 'undefined') console.warn('IRIS onFrame:', err2); }
  }
  this._raf = requestAnimationFrame(this._boundLoop);
};

/* ---------- démo ---------- */
IrisAvatarRuntime.prototype._demoTick = function (dt) {
  var d = this.demo;
  d.timer -= dt;
  if (d.timer > 0) return;
  if (d.waitSpeech && this.sim.speech.active) return;
  d.waitSpeech = false;
  if (d.i >= DEMO.length) { d.active = false; this.sim.emit('demo', false); return; }
  var step = DEMO[d.i++];
  try { step.run(this); } catch (e) { if (typeof console !== 'undefined') console.warn('IRIS démo:', e); }
  d.waitSpeech = !!step.speech;
  d.timer = d.i < DEMO.length ? DEMO[d.i].wait : 0.5;
};
IrisAvatarRuntime.prototype.toggleDemo = function () {
  var d = this.demo;
  if (d.active) { this.cancelDemo(); return; }
  this.audio.ensure(); this.audio.resume(); this.audio.cue('arp');
  d.active = true; d.i = 0; d.timer = 0; d.waitSpeech = false;
  this.sim.emit('demo', true);
};
IrisAvatarRuntime.prototype.cancelDemo = function () {
  if (this.demo && this.demo.active) { this.demo.active = false; this.sim.emit('demo', false); }
};

/* ---------- API contrat ---------- */
IrisAvatarRuntime.prototype.setState = function (state) { this.cancelDemo(); this.sim.applyState(state); };
IrisAvatarRuntime.prototype.setEmotion = function (emotion, duration) { this.sim.applyEmotion(emotion, duration); };
IrisAvatarRuntime.prototype.setViseme = function (name, amplitude) { this.sim.applyViseme(name, amplitude); };
IrisAvatarRuntime.prototype.look = function (x, y) { this.sim.applyLook(x, y); };
IrisAvatarRuntime.prototype.blink = function (delay) { this.sim.applyBlink(delay); };
IrisAvatarRuntime.prototype.speak = function (text, options) {
  this.audio.ensure(); this.audio.resume();
  return this.sim.speak(text, options);
};
IrisAvatarRuntime.prototype.setPaused = function (paused) {
  if (paused == null) paused = typeof document !== 'undefined' && !!document.hidden;
  this._paused = !!paused;
  this.audio.duck(this._paused ? 0 : 1);
  if (this._paused) {
    if (this._raf) cancelAnimationFrame(this._raf);
    this._raf = 0;
  } else if (!this._raf) {
    this._last = 0;
    this._raf = requestAnimationFrame(this._boundLoop);
  }
};

/* ---------- contrôles étendus ---------- */
IrisAvatarRuntime.prototype.getParams = function () {
  var u = this.sim.user, out = {};
  for (var k in u) out[k] = u[k];
  return out;
};
IrisAvatarRuntime.prototype.setParam = function (key, value) {
  var u = this.sim.user;
  if (!(key in DEFAULTS)) return;
  if (key === 'palette') {
    if (!PALETTES[value]) return;
    u.palette = value; this.sim.emit('log', 'palette', value); return;
  }
  if (key === 'quality') {
    if (!QUALITY[value]) return;
    u.quality = value; this._resize(true);
    this.sim.emit('log', 'qualité', value); return;
  }
  if (key === 'engine') {
    u.engine = value;
    this._useEngine(value === 'gl' ? 'webgl' : value === '2d' ? '2d' : (this.gl.ok && !this.gl.lost ? 'webgl' : '2d'));
    return;
  }
  if (key === 'rings' || key === 'face' || key === 'guides') {
    u[key] = !!value;
    this.sim.emit('log', key === 'rings' ? 'anneaux' : key === 'face' ? 'visage' : 'socle', value ? 'activé' : 'masqué');
    return;
  }
  var v = Number(value);
  if (!isFinite(v)) return;
  if (key === 'dist') { u.dist = clamp(v, 2.5, 7.5); this.sim.cam.distT = u.dist; return; }
  if (key === 'rate') { u.rate = clamp(v, 0.6, 1.8); return; }
  var ranges = { turb: [0, 2], glow: [0, 2], irid: [0, 1.5], ring: [0, 3], dust: [0, 1], orbit: [0, 2], mix: [0, 1] };
  if (ranges[key]) u[key] = clamp(v, ranges[key][0], ranges[key][1]);
};
IrisAvatarRuntime.prototype.resetView = function () {
  var c = this.sim.cam;
  c.baseYaw = 0; c.basePitch = 0.06; c.vy = 0; c.vp = 0;
  c.distT = this.sim.user.dist = DEFAULTS.dist;
  this.sim.emit('log', 'caméra', 'recentrée');
};
IrisAvatarRuntime.prototype.reset = function () {
  this.cancelDemo();
  for (var k in DEFAULTS) this.sim.user[k] = DEFAULTS[k];
  this.resetView();
  this.sim.applyEmotion('neutral', 0);
  this.sim.applyState('idle');
  this._resize(true);
  this._useEngine(this.gl.ok && !this.gl.lost ? 'webgl' : '2d');
  this.sim.emit('params');
  this.sim.emit('log', 'système', 'paramètres réinitialisés');
  this.audio.cue('click');
};
IrisAvatarRuntime.prototype.randomize = function () {
  var u = this.sim.user;
  u.turb = rand(0.4, 1.8); u.glow = rand(0.6, 1.6); u.irid = rand(0.3, 1.4);
  u.ring = rand(0.4, 2.2); u.dust = rand(0.2, 0.9); u.orbit = rand(0, 1.2);
  u.mix = rand(0.5, 1);
  var keys = Object.keys(PALETTES);
  u.palette = keys[Math.floor(Math.random() * keys.length)];
  this.sim.emit('params');
  this.sim.emit('log', 'aléatoire', 'palette ' + u.palette);
  this.audio.cue('click');
};
IrisAvatarRuntime.prototype.exportPNG = function () {
  try {
    var q = QUALITY[this.sim.user.quality] || QUALITY.std;
    var canvas;
    if (this.engine === 'webgl') { this.gl.render(this.sim, q.steps); canvas = this.glCanvas; }
    else { this.c2d.render(this.sim); canvas = this.fxCanvas; }
    var url = canvas.toDataURL('image/png');
    var a = document.createElement('a');
    var d = new Date();
    function pad(n) { return String(n).padStart(2, '0'); }
    a.download = 'iris-' + this.sim.state + '-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate())
      + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + '.png';
    a.href = url;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    this.sim.emit('log', 'export', a.download);
    this.audio.cue('click');
  } catch (e) {
    this.sim.emit('log', 'export', 'échec — ' + (e.message || 'inconnu'));
  }
};
IrisAvatarRuntime.prototype.setSound = function (on) {
  this.soundOn = !!on;
  this.audio.setMuted(!on);
  if (on) this.audio.cue('click');
  this.sim.emit('sound', this.soundOn);
};
IrisAvatarRuntime.prototype.isSoundOn = function () { return this.soundOn; };

/* ---------- nettoyage complet ---------- */
IrisAvatarRuntime.prototype.destroy = function () {
  if (this._raf) cancelAnimationFrame(this._raf);
  this._raf = 0;
  this.cancelDemo();
  this.sim._finishSpeech(true);
  this.host.removeEventListener('pointerdown', this._onDown);
  this.host.removeEventListener('pointermove', this._onMove);
  this.host.removeEventListener('pointerup', this._onUp);
  this.host.removeEventListener('pointercancel', this._onUp);
  this.host.removeEventListener('wheel', this._onWheel);
  this.host.removeEventListener('dblclick', this._onDbl);
  this.glCanvas.removeEventListener('webglcontextlost', this._lostHandler);
  this.glCanvas.removeEventListener('webglcontextrestored', this._restoredHandler);
  document.removeEventListener('visibilitychange', this._onVis);
  window.removeEventListener('pointerdown', this._gesture);
  window.removeEventListener('keydown', this._gesture);
  if (this._ro) this._ro.disconnect();
  else window.removeEventListener('resize', this._onResize);
  if (this._mq && this._mq.removeEventListener) this._mq.removeEventListener('change', this._onMq);
  this.audio.destroy();
  this.host.classList.remove('is-blinking', 'is-dragging');
  if (this.glCanvas.parentNode) this.glCanvas.parentNode.removeChild(this.glCanvas);
  if (this.fxCanvas.parentNode) this.fxCanvas.parentNode.removeChild(this.fxCanvas);
};

window.IrisAvatarRuntime = IrisAvatarRuntime;
window.IrisVisemes = { buildVisemeScript: buildVisemeScript };
})();