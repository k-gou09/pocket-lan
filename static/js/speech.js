// Partition visemique et lecteur d'enveloppe labiale.
// Utilise par la maquette, puis par le TTS : le lecteur ne produit aucun son,
// il anime uniquement la bouche de l'avatar a partir d'un script temporel.

const VOWEL_VISEME = [
  [/^(ou|où|oû|u|ù|û|ü)/, 'u'],
  [/^(oi|oî|oï)/, 'o'],
  [/^(on|om|o|ô|ö|au|eau)/, 'o'],
  [/^(an|am|en|em|a|à|â|ä)/, 'a'],
  [/^(in|im|ain|ein|un|um|i|î|ï|y)/, 'i'],
  [/^(e|é|è|ê|ë|œ|œu)/, 'e'],
];

const VOWEL_CLASS = 'aàâäeéèêëiîïoôöuùûüyœæ';
const VOWEL_GROUP = new RegExp(`[${VOWEL_CLASS}]+`);
const SYLLABLE_PARTS = new RegExp(`[${VOWEL_CLASS}]+|[^${VOWEL_CLASS}]+`, 'g');

function visemeFor(vowels) {
  for (const [pattern, viseme] of VOWEL_VISEME) {
    if (pattern.test(vowels)) return viseme;
  }
  return 'e';
}

// Decoupe un mot en syllabes approximatives : une consonne (ou groupe)
// suivie d'un groupe de voyelles. Suffisant pour donner un rythme juste.
function splitSyllables(word) {
  const parts = word.match(SYLLABLE_PARTS) ?? [];
  const syllables = [];
  let pending = '';

  for (const part of parts) {
    if (VOWEL_GROUP.test(part[0])) {
      syllables.push(pending + part);
      pending = '';
    } else {
      pending += part;
    }
  }
  if (pending) {
    if (syllables.length) syllables[syllables.length - 1] += pending;
    else syllables.push(pending);
  }
  return syllables.length ? syllables : [word];
}

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const roundAmp = (amp) => Number(clamp(amp, 0.15, 1).toFixed(2));

// Duree d'une syllabe au debit demande. Calibrage sur le moteur vocal reel :
// le texte de demonstration (57 syllabes) dure 14,2 s sur Chrome Android.
const syllableMsFor = (rate) => 200 / clamp(Number(rate) || 1, 0.6, 1.8);

// Construit la partition d'un seul mot, en temps relatif au debut du mot.
// Entre deux mots la bouche reste entrouverte : seules la ponctuation et la
// fin de phrase la referment. Chaque mot porte donc sa duree totale.
function planWord(word, syllableMs) {
  const events = [];
  let t = 0;

  const push = (viseme, amp) => {
    const prev = events[events.length - 1];
    // Deux syllabes voisines de meme viseme sont fusionnees : sans cela la
    // bouche claque trop vite pour etre lue comme une parole.
    if (prev && prev.viseme === viseme) {
      prev.amp = Math.max(prev.amp, roundAmp(amp));
      return;
    }
    events.push({ at: Math.round(t), viseme, amp: roundAmp(amp) });
  };

  const lower = word
    .toLowerCase()
    .normalize('NFC')
    .replace(/[^a-zàâäéèêëîïôöùûüÿœæç'-]/g, '');

  const syllables = lower ? splitSyllables(lower) : [];

  if (syllables.length === 0) {
    // Nombres, sigles, emoji : une ouverture par chiffre, sans inventer de mot.
    const digits = word.replace(/\D/g, '');
    const count = Math.min(4, Math.max(1, digits.length));
    for (let i = 0; i < count; i += 1) {
      push('e', 0.7);
      t += syllableMs;
    }
  }

  syllables.forEach((syllable, index) => {
    const vowels = syllable.match(VOWEL_GROUP);
    const viseme = visemeFor(vowels ? vowels[0] : syllable);
    // Les syllabes longues (diphthongues, groupes) durent un peu plus.
    const lengthBoost = clamp((vowels ? vowels[0].length : 1) / 2, 0.8, 1.5);
    const accent = index === syllables.length - 1 ? 0.06 : 0;
    const jitter = 0.94 + Math.random() * 0.12;
    const amp = clamp(0.52 * lengthBoost + accent + Math.random() * 0.2, 0.35, 1);

    push(viseme, amp * jitter);
    t += syllableMs * lengthBoost * jitter;
  });

  const trailing = word.match(/[,;:…]$/);
  const ending = word.match(/[.!?]$/);

  if (ending) {
    push('rest', 0);
    t += syllableMs * 2.2;
  } else if (trailing) {
    push('rest', 0);
    t += syllableMs * 1.2;
  } else {
    t += syllableMs * 0.5;
  }

  return { events, duration: t };
}

// Transforme un texte en evenements { at (ms), viseme, amp }.
// Approximation syllabique : suffisante pour une bouche expressive,
// sans jamais pretendre analyser le son du TTS.
export function buildVisemeScript(text, { rate = 1 } = {}) {
  const clean = String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return [];

  const syllableMs = syllableMsFor(rate);
  const events = [];
  let t = 0;

  for (const word of clean.split(' ')) {
    if (!word) continue;
    const plan = planWord(word, syllableMs);
    const offset = t;

    for (const event of plan.events) {
      const prev = events[events.length - 1];
      if (prev && prev.viseme === event.viseme) {
        prev.amp = Math.max(prev.amp, event.amp);
      } else {
        events.push({
          at: Math.round(offset + event.at),
          viseme: event.viseme,
          amp: event.amp,
        });
      }
    }

    t += plan.duration;
  }

  return events;
}

// Joue un script visemique en temps reel (requestAnimationFrame).
export class VisemePlayer {
  constructor(avatar) {
    this.avatar = avatar;
    this.playing = false;
    this._events = [];
    this._index = 0;
    this._startedAt = 0;
    this._raf = 0;
    this._onEnd = null;
    this._onEvent = null;
  }

  play(script, onEnd = null, onEvent = null) {
    this.stop();
    if (!Array.isArray(script) || script.length === 0) {
      onEnd?.();
      return;
    }
    this._events = script;
    this._index = 0;
    this._startedAt = performance.now();
    this._onEnd = onEnd;
    this._onEvent = onEvent;
    this.playing = true;

    const tick = (now) => {
      if (!this.playing) return;
      const elapsed = now - this._startedAt;

      while (this._index < this._events.length && this._events[this._index].at <= elapsed) {
        const event = this._events[this._index];
        this._index += 1;
        this.avatar.setViseme(event.viseme, event.amp);
        this._onEvent?.(event, this._index);
      }

      const last = this._events[this._events.length - 1];
      if (this._index >= this._events.length && elapsed > last.at + 170) {
        this.#finish();
        return;
      }
      this._raf = requestAnimationFrame(tick);
    };

    this._raf = requestAnimationFrame(tick);
  }

  playText(text, options, onEnd) {
    this.play(buildVisemeScript(text, options), onEnd);
  }

  stop() {
    if (this.playing) this.playing = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._onEnd = null;
    this._onEvent = null;
    this.avatar?.setViseme('rest', 0);
  }

  #finish() {
    this.playing = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this.avatar.setViseme('rest', 0);
    const callback = this._onEnd;
    this._onEnd = null;
    this._onEvent = null;
    callback?.();
  }
}

// ---------- LipSync ----------
// Bouche pilotee par le TTS, sans jamais analyser le son (impossible :
// speechSynthesis n'expose aucun flux). Deux regimes :
//  - "estimate" : partition syllabique jouee au rythme estime.
//  - "boundary" : chaque evenement boundary du TTS recale la partition
//    sur le mot reellement prononce. Les mots suivants restent estimes
//    jusqu'au prochain boundary : la synchro se corrige en continu.

const tokenizeWords = (text, rate = 1) => {
  const words = [];
  const syllableMs = syllableMsFor(rate);
  const re = /[^\s]+/g;
  let match;
  while ((match = re.exec(text)) !== null) {
    const raw = match[0];
    // Meme plan que l'estimation : le recalage sur boundary ne peut donc pas
    // reintroduire des fermetures entre les mots.
    const plan = planWord(raw, syllableMs);
    words.push({
      word: raw,
      start: match.index,
      end: match.index + raw.length,
      events: plan.events,
      duration: plan.duration,
    });
  }
  return words;
};

export class LipSync {
  constructor(avatar, { onSyncChange = null } = {}) {
    this.avatar = avatar;
    this.onSyncChange = onSyncChange;
    this.sync = 'idle';
    this.active = false;
    this.words = [];
    this._queue = [];
    this._cursor = 0;
    this._endAt = 0;
    this._lastIndex = -1;
    this._raf = 0;
  }

  // Demarre une partition estimee pour un texte complet (une phrase).
  // durationMs, quand il est connu (audio synthetise), etale la partition sur la
  // duree reelle : la bouche suit le son au lieu de l'estimer.
  start(text, { rate = 1, durationMs = 0 } = {}) {
    this.stop();
    const clean = String(text ?? '');
    this.words = tokenizeWords(clean, rate);
    if (this.words.length === 0) return;

    this.active = true;
    this.#setSync('estimate');

    let t = performance.now() + 40;
    const startAt = t;
    this._queue = [];
    for (const word of this.words) {
      for (const event of word.events) {
        this._queue.push({ at: t + event.at, viseme: event.viseme, amp: event.amp });
      }
      t += word.duration;
    }
    this._cursor = 0;
    this._endAt = t;
    this._lastIndex = -1;

    const natural = this._endAt - startAt;
    if (durationMs > 200 && natural > 0) {
      const scale = durationMs / natural;
      for (const event of this._queue) event.at = startAt + (event.at - startAt) * scale;
      this._endAt = startAt + natural * scale;
    }

    this.#loop();
  }

  // Recale la partition sur le mot annonce par le TTS (charIndex).
  boundary(charIndex) {
    if (!this.active || this.words.length === 0) return;
    let index = this.words.findIndex((w) => charIndex >= w.start && charIndex < w.end);
    if (index < 0) index = this.words.findIndex((w) => w.start >= charIndex);
    if (index < 0) return;
    // Ignore les evenements qui reviennent en arriere ou se repetent :
    // rejouer le meme mot donnerait un hoquet visible.
    if (index <= this._lastIndex) return;
    this._lastIndex = index;

    const now = performance.now() + 20;
    const queue = [];
    let t = now;
    for (let i = index; i < this.words.length; i += 1) {
      const word = this.words[i];
      for (const event of word.events) {
        queue.push({ at: t + event.at, viseme: event.viseme, amp: event.amp });
      }
      t += word.duration;
    }
    this._queue = queue;
    this._cursor = 0;
    this._endAt = t;
    this.#setSync('boundary');
  }

  stop() {
    this.active = false;
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._queue = [];
    this._cursor = 0;
    this._lastIndex = -1;
    this.#setSync('idle');
    this.avatar?.setViseme('rest', 0);
  }

  #setSync(mode) {
    if (this.sync === mode) return;
    this.sync = mode;
    this.onSyncChange?.(mode);
  }

  #loop() {
    const tick = (now) => {
      if (!this.active) return;
      while (this._cursor < this._queue.length && this._queue[this._cursor].at <= now) {
        const event = this._queue[this._cursor];
        this._cursor += 1;
        this.avatar.setViseme(event.viseme, event.amp);
      }
      if (now >= this._endAt + 60) {
        this.active = false;
        this.avatar.setViseme('rest', 0);
        cancelAnimationFrame(this._raf);
        this._raf = 0;
        this.#setSync('idle');
        return;
      }
      this._raf = requestAnimationFrame(tick);
    };
    this._raf = requestAnimationFrame(tick);
  }
}

