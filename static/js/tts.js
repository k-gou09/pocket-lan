// Voix : lecture phrase par phrase via speechSynthesis.
// La synchronisation labiale estimee est recalee par les evenements
// "boundary" quand le moteur vocal veut bien les emettre. Aucun acces
// au flux audio n'existe : on ne pretend jamais analyser le son.

import { LipSync } from './speech.js';

const SPLIT_SENTENCES = /(?<=[.!?…])\s+/;
const SENTENCE_END = /[.!?…](?:["')\]]+)?\s*$/;

export function splitSentences(text) {
  return String(text ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(SPLIT_SENTENCES)
    .map((s) => s.trim())
    .filter(Boolean);
}

function extractCompleteSentences(buffer) {
  const text = String(buffer ?? '').replace(/\s+/g, ' ').trimStart();
  if (!text) return { ready: [], rest: '' };
  const parts = text.split(SPLIT_SENTENCES);
  // si le texte ne se termine pas par une ponctuation de fin, le dernier morceau est incomplet
  if (parts.length === 0) return { ready: [], rest: text };
  const last = parts[parts.length - 1] || '';
  if (SENTENCE_END.test(text)) {
    return { ready: parts.map((s) => s.trim()).filter(Boolean), rest: '' };
  }
  const ready = parts.slice(0, -1).map((s) => s.trim()).filter(Boolean);
  return { ready, rest: last };
}

export class Speaker {
  constructor(avatar, { lang = 'fr-FR', rate = 1, pitch = 1.02, volume = 1, preferredVoice = '' } = {}) {
    this.avatar = avatar;
    this.lang = lang;
    // Voix choisie par l'utilisateur dans les reglages. refreshVoices() la remet
    // en avant a chaque lecture, sinon le choix serait ecrase par la voix par defaut.
    this.preferredVoice = preferredVoice || '';
    this.rate = Math.min(1.5, Math.max(0.7, Number(rate) || 1));
    this.pitch = pitch;
    this.volume = volume;

    this.speaking = false;
    this.voice = null;
    this.voices = [];
    this.onStateChange = null;
    this._token = 0;
    this._utterance = null;
    this._watchdog = 0;
    this._resolveOne = null;
    this._onEnd = null;
    this._lip = avatar
      ? new LipSync(avatar, { onSyncChange: (mode) => (this.sync = mode) })
      : null;
    this.sync = 'idle';
    this._voicesBound = false;
    // Mesures reelles du moteur vocal (aucune analyse du son, seulement des
    // evenements emis par le navigateur).
    this.lastStartLatencyMs = -1;
    this.estimateFallbackCount = 0;
    this.graceMs = 1200;
    this._grace = 0;
    this.maxRetries = 1;
    this._lastText = '';
    this._lastTextAt = 0;
    this.retryDelayMs = 140;
    this.retryCount = 0;
    this.breatheMs = 120;

    this._stream = null; // { queue: string[], done: boolean, notify: fn|null, buffer: string, hooks }

    this.refreshVoices();
  }

  // La partition est jouee par LipSync : on expose son etat pour la garde d'etat.
  get lipActive() { return Boolean(this._lip?.active); }

  get supported() {
    return typeof window !== 'undefined' && 'speechSynthesis' in window
      && typeof window.SpeechSynthesisUtterance === 'function';
  }

  // Les voix arrivent en asynchrone sur Chrome : on recharge a chaque lecture.
  refreshVoices() {
    if (!this.supported) return [];
    const all = window.speechSynthesis.getVoices() || [];
    this.voices = all.filter((v) => /^fr/i.test(v.lang));
    const preferred = this.preferredVoice ? this.voices.find((v) => v.name === this.preferredVoice) : null;
    const local = this.voices.find((v) => v.localService && /fr[-_]FR/i.test(v.lang));
    const anyFrench = this.voices.find((v) => /fr[-_]FR/i.test(v.lang)) || this.voices[0];
    this.voice = preferred || local || anyFrench || null;

    if (!this._voicesBound) {
      this._voicesBound = true;
      window.speechSynthesis.addEventListener?.('voiceschanged', () => this.refreshVoices());
    }
    return this.voices;
  }

  get voiceLabel() {
    if (!this.supported) return 'voix indisponible';
    if (!this.voice) return 'voix par defaut';
    return this.voice.name;
  }

  get voiceIsLocal() {
    return Boolean(this.voice && this.voice.localService);
  }

  // Lecture complete (non streamée).
  speak(text, { onStart = null, onEnd = null, onBoundary = null, onSentence = null } = {}) {
    const sentences = splitSentences(text);
    if (sentences.length === 0 || !this.supported) {
      onEnd?.({ reason: this.supported ? 'empty' : 'unsupported', cancelled: false });
      return;
    }

    // Garde anti-doublon : le meme texte relance alors qu'il est deja en train
    // d'etre lu (deux evenements "reply" par exemple) ne doit pas s'empiler.
    const requestedAt = performance.now();
    const sameText = String(text ?? '') === this._lastText;
    if (this.speaking && sameText && requestedAt - this._lastTextAt < 1500) {
      onEnd?.({ reason: 'duplicate', cancelled: false });
      return;
    }
    this._lastText = String(text ?? '');
    this._lastTextAt = requestedAt;

    const wasSpeaking = this.speaking;
    this.stop('restart', { silent: true });
    const token = ++this._token;
    this.refreshVoices();
    this.speaking = true;
    this.onStateChange?.('speaking');
    this._onEnd = onEnd;

    const hooks = { onStart, onEnd, onBoundary, onSentence };
    this._stream = { queue: [...sentences], done: true, notify: null, buffer: '', hooks };
    // Meme respiration apres un arret : le moteur vocal du navigateur ignore
    // parfois une enonce emise juste apres cancel().
    window.setTimeout(
      () => this.#run(token),
      wasSpeaking ? Math.max(90, this.breatheMs) : this.breatheMs,
    );
  }

  // Démarre une lecture au fil de l'eau : on alimente via feed(), puis endStream().
  beginStream({ onStart = null, onEnd = null, onBoundary = null, onSentence = null } = {}) {
    if (!this.supported) {
      onEnd?.({ reason: 'unsupported', cancelled: false });
      return false;
    }
    const wasSpeaking = this.speaking;
    this.stop('restart', { silent: true });
    const token = ++this._token;
    this.refreshVoices();
    this.speaking = true;
    this.onStateChange?.('speaking');
    this._onEnd = onEnd;
    const hooks = { onStart, onEnd, onBoundary, onSentence };
    this._stream = { queue: [], done: false, notify: null, buffer: '', hooks };
    window.setTimeout(
      () => this.#run(token),
      wasSpeaking ? Math.max(90, this.breatheMs) : this.breatheMs,
    );
    return true;
  }

  // Ajoute du texte brut (delta) : les phrases complètes sont mises en file.
  feed(delta) {
    const stream = this._stream;
    if (!stream || stream.done && stream.queue.length === 0 && !stream.buffer) {
      // si pas de stream actif, ignorer (sécurité)
    }
    if (!stream || this._token === 0) return;
    stream.buffer += String(delta ?? '');
    const { ready, rest } = extractCompleteSentences(stream.buffer);
    stream.buffer = rest;
    if (ready.length) {
      stream.queue.push(...ready);
      const notify = stream.notify;
      stream.notify = null;
      notify?.();
    }
  }

  // Signale la fin du flux : flush le reliquat et laisse la file se vider.
  endStream() {
    const stream = this._stream;
    if (!stream) return;
    const rest = String(stream.buffer || '').trim();
    if (rest) stream.queue.push(rest);
    stream.buffer = '';
    stream.done = true;
    const notify = stream.notify;
    stream.notify = null;
    notify?.();
  }

  stop(reason = 'cancelled', { silent = false } = {}) {
    this._token += 1;
    const stream = this._stream;
    if (stream) {
      stream.done = true;
      const notify = stream.notify;
      stream.notify = null;
      notify?.();
    }
    this._stream = null;
    clearTimeout(this._watchdog);
    this._watchdog = 0;
    clearTimeout(this._grace);
    this._grace = 0;
    if (this.supported && this.speaking) {
      try {
        window.speechSynthesis.cancel();
      } catch {
        /* deja arrete */
      }
    }
    if (this._utterance) {
      this._utterance.onend = null;
      this._utterance.onerror = null;
      this._utterance.onboundary = null;
      this._utterance = null;
    }
    // Debloque la chaine en cours : le tour de boucle verra le jeton perime.
    this._resolveOne?.('cancelled');
    this._resolveOne = null;
    this._lip?.stop();
    const wasSpeaking = this.speaking;
    this.speaking = false;
    if (wasSpeaking) this.onStateChange?.('idle');

    const callback = this._onEnd;
    this._onEnd = null;
    if (callback && !silent) callback({ reason, cancelled: true });
  }

  async #nextSentence(token) {
    while (token === this._token) {
      const stream = this._stream;
      if (!stream) return null;
      if (stream.queue.length > 0) return stream.queue.shift();
      if (stream.done) return null;
      await new Promise((resolve) => {
        stream.notify = resolve;
        // sécurité : si stop() a déjà invalidé le token, resolve immédiat au prochain tick
        if (token !== this._token) resolve();
      });
    }
    return null;
  }

  async #run(token) {
    while (token === this._token) {
      const sentence = await this.#nextSentence(token);
      if (token !== this._token) return;
      if (sentence == null) break;
      const stream = this._stream;
      const hooks = stream?.hooks || {};
      hooks.onSentence?.(sentence);
      const outcome = await this.#speakOne(sentence, token, hooks);
      if (token !== this._token) return;
      if (outcome === 'cancelled') return;
    }

    this._lip?.stop();
    const wasSpeaking = this.speaking;
    this.speaking = false;
    this._stream = null;
    if (wasSpeaking) this.onStateChange?.('idle');
    const callback = this._onEnd;
    this._onEnd = null;
    callback?.({ reason: 'end', cancelled: false });
  }

  #speakOne(text, token, hooks, attemptNo = 1) {
    return new Promise((resolve) => {
      let done = false;
      let started = false;
      let lipStarted = false;
      let current = null;
      const submittedAt = performance.now();

      const startLip = () => {
        if (lipStarted || token !== this._token) return;
        lipStarted = true;
        this._lip?.start(text, { rate: this.rate });
      };

      const clearTimers = () => {
        clearTimeout(this._watchdog);
        this._watchdog = 0;
        clearTimeout(this._grace);
        this._grace = 0;
      };

      const finish = (outcome) => {
        if (done) return;
        done = true;
        this._resolveOne = null;
        clearTimers();
        if (current) {
          current.onstart = null;
          current.onend = null;
          current.onerror = null;
          current.onboundary = null;
        }
        if (token === this._token) {
          this._lip?.stop();
          this._utterance = null;
        }
        resolve(outcome);
      };
      this._resolveOne = finish;

      // Ne jamais retenter sur un 'end' sans 'start' : Chrome (Windows) emet
      // parfois 'end' avant 'start' alors que la phrase a bien ete prononcee.
      // C'est ce retry qui faisait lire chaque phrase deux fois.
      const failFast = (outcome) => {
        const swallowed = !started && outcome === 'timeout'
          && attemptNo < this.maxRetries && token === this._token;
        if (swallowed) {
          this.retryCount += 1;
          clearTimers();
          // L'enonce perime est neutralise puis retire de la file : il ne peut
          // plus demarrer en douce pendant que la relance parle.
          if (current) {
            current.onstart = null;
            current.onend = null;
            current.onerror = null;
            current.onboundary = null;
          }
          try {
            window.speechSynthesis.cancel();
          } catch {
            /* deja arrete */
          }
          setTimeout(() => {
            if (done || token !== this._token) return;
            this.#speakOne(text, token, hooks, attemptNo + 1).then(resolve);
          }, this.retryDelayMs);
          return;
        }
        finish(outcome);
      };

      // Filet de securite : certains moteurs n'emettent jamais "end".
      this._watchdog = setTimeout(
        () => failFast('timeout'),
        Math.min(30000, 2000 + text.length * 140),
      );

      // Fichier de securite pour la bouche : sur Android le moteur n'emet pas
      // "start" (mesure : 0 start sur certains enonces, 6,9 s de latence). Si
      // rien ne demarre dans graceMs, on lance la partition estimee, sans
      // pretendre savoir quand la voix a commence.
      this._grace = setTimeout(() => {
        if (done || started) return;
        this.estimateFallbackCount += 1;
        startLip();
      }, this.graceMs);

      const arm = () => {
        const utterance = new SpeechSynthesisUtterance(text);
        utterance.lang = this.lang;
        utterance.rate = this.rate;
        utterance.pitch = this.pitch;
        utterance.volume = this.volume;
        if (this.voice) utterance.voice = this.voice;

        utterance.onstart = () => {
          if (token !== this._token) return;
          started = true;
          this.lastStartLatencyMs = performance.now() - submittedAt;
          // Ancrage exact : la partition repart du moment ou la voix demarre.
          lipStarted = false;
          startLip();
          hooks.onStart?.(text);
        };
        utterance.onboundary = (event) => {
          if (token !== this._token) return;
          if (typeof event.charIndex === 'number') this._lip?.boundary(event.charIndex);
          hooks.onBoundary?.(event);
        };
        utterance.onend = () => failFast('end');
        utterance.onerror = (event) => failFast(event?.error || 'error');

        current = utterance;
        this._utterance = utterance;
        try {
          window.speechSynthesis.speak(utterance);
        } catch (error) {
          finish('error');
        }
      };

      arm();
    });
  }
}
