/*
 * Runtime d'avatar — fichier commun à tous les exemples de avatar/*.html.
 *
 * Script classique (pas de module ES) : on peut ouvrir directement un fichier
 * HTML avec un double-clic, sans serveur local ni problème CORS sur file://.
 *
 * Contrat identique à l'avatar de Pocket LAN :
 *   data-state  : idle | listening | thinking | speaking | error
 *   data-emotion: neutral | happy | sad | surprised | curious | angry | sleepy
 *   data-viseme : rest | a | e | i | o | u | smile
 *   classe is-blinking
 *   variables CSS --gaze-x, --gaze-y, --jaw
 *
 * Ce fichier ne contient aucun SVG : il pilote uniquement le balisage déjà
 * présent dans le HTML. N'importe quel avatar respectant le contrat peut donc
 * réutiliser exactement ce même fichier JS.
 */
(function () {
  'use strict';

  var STATES = ['idle', 'listening', 'thinking', 'speaking', 'error'];
  var EMOTIONS = ['neutral', 'happy', 'sad', 'surprised', 'curious', 'angry', 'sleepy'];
  var VISEMES = ['rest', 'a', 'e', 'i', 'o', 'u', 'smile'];

  // ---------- partition visémique (même logique que static/js/speech.js) ----------

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

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function roundAmp(amp) {
    return Number(clamp(amp, 0.15, 1).toFixed(2));
  }

  function visemeFor(vowels) {
    for (var i = 0; i < VOWEL_VISEME.length; i += 1) {
      if (VOWEL_VISEME[i][0].test(vowels)) return VOWEL_VISEME[i][1];
    }
    return 'e';
  }

  function splitSyllables(word) {
    var parts = word.match(SYLLABLE_PARTS) || [];
    var syllables = [];
    var pending = '';
    for (var i = 0; i < parts.length; i += 1) {
      var part = parts[i];
      if (VOWEL_GROUP.test(part.charAt(0))) {
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

  function syllableMsFor(rate) {
    return 200 / clamp(Number(rate) || 1, 0.6, 1.8);
  }

  function planWord(word, syllableMs) {
    var events = [];
    var t = 0;

    function push(viseme, amp) {
      var prev = events[events.length - 1];
      if (prev && prev.viseme === viseme) {
        prev.amp = Math.max(prev.amp, roundAmp(amp));
        return;
      }
      events.push({ at: Math.round(t), viseme: viseme, amp: roundAmp(amp) });
    }

    var lower = String(word || '')
      .toLowerCase()
      .normalize('NFC')
      .replace(/[^a-zàâäéèêëîïôöùûüÿœæç'-]/g, '');
    var syllables = lower ? splitSyllables(lower) : [];

    if (!syllables.length) {
      var digits = String(word).replace(/\D/g, '');
      var count = Math.min(4, Math.max(1, digits.length));
      for (var d = 0; d < count; d += 1) {
        push('e', 0.7);
        t += syllableMs;
      }
    }

    for (var i = 0; i < syllables.length; i += 1) {
      var syllable = syllables[i];
      var vowels = syllable.match(VOWEL_GROUP);
      var viseme = visemeFor(vowels ? vowels[0] : syllable);
      var lengthBoost = clamp((vowels ? vowels[0].length : 1) / 2, 0.8, 1.5);
      var accent = i === syllables.length - 1 ? 0.06 : 0;
      var jitter = 0.94 + Math.random() * 0.12;
      var amp = clamp(0.52 * lengthBoost + accent + Math.random() * 0.2, 0.35, 1);
      push(viseme, amp * jitter);
      t += syllableMs * lengthBoost * jitter;
    }

    if (/[.!?]$/.test(word)) {
      push('rest', 0);
      t += syllableMs * 2.2;
    } else if (/[,;:…]$/.test(word)) {
      push('rest', 0);
      t += syllableMs * 1.2;
    } else {
      t += syllableMs * 0.5;
    }

    return { events: events, duration: t };
  }

  function buildVisemeScript(text, rate) {
    var clean = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
    if (!clean) return [];
    var syllableMs = syllableMsFor(rate);
    var events = [];
    var t = 0;
    var words = clean.split(' ');

    for (var w = 0; w < words.length; w += 1) {
      if (!words[w]) continue;
      var plan = planWord(words[w], syllableMs);
      for (var i = 0; i < plan.events.length; i += 1) {
        var event = plan.events[i];
        var prev = events[events.length - 1];
        if (prev && prev.viseme === event.viseme) {
          prev.amp = Math.max(prev.amp, event.amp);
        } else {
          events.push({
            at: Math.round(t + event.at),
            viseme: event.viseme,
            amp: event.amp
          });
        }
      }
      t += plan.duration;
    }
    return events;
  }

  // ---------- runtime ----------

  function rand(min, max) {
    return min + Math.random() * (max - min);
  }

  function AvatarRuntime(el, options) {
    if (!el) throw new Error('AvatarRuntime : conteneur manquant');
    options = options || {};
    this.el = el;
    this.reduced = options.reducedMotion != null
      ? !!options.reducedMotion
      : (typeof window.matchMedia === 'function'
        ? window.matchMedia('(prefers-reduced-motion: reduce)').matches
        : false);

    this.state = 'idle';
    this.emotion = 'neutral';
    this.viseme = 'rest';
    this._paused = typeof document !== 'undefined' ? !!document.hidden : false;
    this._blinkTimer = null;
    this._blinkOffTimer = null;
    this._saccadeTimer = null;
    this._emotionTimer = null;
    this._speechRaf = 0;
    this._speechFinish = null;

    this.el.dataset.state = this.state;
    this.el.dataset.emotion = this.emotion;
    this.el.dataset.viseme = this.viseme;
    this.el.style.setProperty('--gaze-x', '0px');
    this.el.style.setProperty('--gaze-y', '0px');
    this.el.style.setProperty('--jaw', '0');

    this._onVisibility = this.setPaused.bind(this, null);
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', this._onVisibility);
      if (!this._paused) {
        this._scheduleBlink();
        this._scheduleSaccade();
      }
    }
  }

  AvatarRuntime.STATES = STATES;
  AvatarRuntime.EMOTIONS = EMOTIONS;
  AvatarRuntime.VISEMES = VISEMES;

  AvatarRuntime.prototype.setState = function (state) {
    if (STATES.indexOf(state) < 0) return;
    this.state = state;
    this.el.dataset.state = state;
    if (state === 'speaking') this.look(0, 0.1);
    else if (state === 'thinking') this.look(0, -0.75);
    else if (state === 'listening') this.look(0, 0);
    else if (state === 'error') this.look(0, 0.65);
    if (state !== 'speaking') this.setViseme('rest', 0);
  };

  AvatarRuntime.prototype.setEmotion = function (emotion, duration) {
    if (EMOTIONS.indexOf(emotion) < 0) return;
    this.emotion = emotion;
    this.el.dataset.emotion = emotion;
    if (this._emotionTimer) {
      clearTimeout(this._emotionTimer);
      this._emotionTimer = null;
    }
    var ms = duration == null ? 2400 : Number(duration);
    if (emotion !== 'neutral' && ms > 0) {
      var self = this;
      this._emotionTimer = setTimeout(function () {
        self._emotionTimer = null;
        self.setEmotion('neutral', 0);
      }, ms);
    }
  };

  AvatarRuntime.prototype.setViseme = function (name, amplitude) {
    var viseme = VISEMES.indexOf(name) >= 0 ? name : 'rest';
    if (this.viseme !== viseme) {
      this.viseme = viseme;
      this.el.dataset.viseme = viseme;
    }
    var amp = clamp(Number(amplitude) || 0, 0, 1);
    this.el.style.setProperty('--jaw', amp.toFixed(2));
  };

  AvatarRuntime.prototype.look = function (x, y) {
    var gx = clamp(Number(x) || 0, -1, 1) * 6;
    var gy = clamp(Number(y) || 0, -1, 1) * 5;
    this.el.style.setProperty('--gaze-x', gx.toFixed(1) + 'px');
    this.el.style.setProperty('--gaze-y', gy.toFixed(1) + 'px');
  };

  AvatarRuntime.prototype.blink = function (delay) {
    if (this.reduced) return;
    var self = this;
    if (delay > 0) {
      setTimeout(function () { self.blink(0); }, delay);
      return;
    }
    this.el.classList.add('is-blinking');
    if (this._blinkOffTimer) clearTimeout(this._blinkOffTimer);
    this._blinkOffTimer = setTimeout(function () {
      self.el.classList.remove('is-blinking');
      self._blinkOffTimer = null;
    }, 140);
  };

  AvatarRuntime.prototype.setPaused = function (paused) {
    if (paused == null) paused = typeof document !== 'undefined' && !!document.hidden;
    this._paused = !!paused;
    if (this._paused) {
      if (this._blinkTimer) clearTimeout(this._blinkTimer);
      if (this._saccadeTimer) clearTimeout(this._saccadeTimer);
      this._blinkTimer = null;
      this._saccadeTimer = null;
      return;
    }
    this._scheduleBlink();
    this._scheduleSaccade();
  };

  AvatarRuntime.prototype.speak = function (text, options) {
    options = options || {};
    var self = this;
    var clean = String(text == null ? '' : text).trim();
    var rate = clamp(Number(options.rate) || 1, 0.6, 1.8);
    var lang = options.lang || 'fr-FR';

    this._cancelSpeak();
    if (!clean) return Promise.resolve();

    this.setState('speaking');
    var script = buildVisemeScript(clean, rate);

    return new Promise(function (resolve) {
      var visemesDone = false;
      var audioDone = typeof window !== 'undefined' && 'speechSynthesis' in window ? false : true;
      var finished = false;
      var start = (typeof performance !== 'undefined' ? performance.now() : Date.now());
      var index = 0;
      var lastAt = script.length ? script[script.length - 1].at : 0;

      function now() {
        return typeof performance !== 'undefined' ? performance.now() : Date.now();
      }

      function finish() {
        if (finished) return;
        finished = true;
        if (self._speechRaf) cancelAnimationFrame(self._speechRaf);
        self._speechRaf = 0;
        self._speechFinish = null;
        self.setViseme('rest', 0);
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          try { window.speechSynthesis.cancel(); } catch (e) { /* déjà arrêté */ }
        }
        resolve();
      }

      function maybeFinish() {
        if (visemesDone && audioDone) finish();
      }

      self._speechFinish = finish;

      if (script.length) {
        var tick = function () {
          if (finished) return;
          var elapsed = now() - start;
          while (index < script.length && script[index].at <= elapsed) {
            self.setViseme(script[index].viseme, script[index].amp);
            index += 1;
          }
          if (index >= script.length && elapsed > lastAt + 220) {
            visemesDone = true;
            maybeFinish();
            return;
          }
          self._speechRaf = requestAnimationFrame(tick);
        };
        self._speechRaf = requestAnimationFrame(tick);
      } else {
        visemesDone = true;
      }

      if (typeof window !== 'undefined' && 'speechSynthesis' in window
          && typeof window.SpeechSynthesisUtterance === 'function') {
        var utterance = new SpeechSynthesisUtterance(clean);
        utterance.lang = lang;
        utterance.rate = rate;
        utterance.onend = function () { audioDone = true; maybeFinish(); };
        utterance.onerror = function () { audioDone = true; maybeFinish(); };
        try {
          window.speechSynthesis.cancel();
          window.speechSynthesis.speak(utterance);
        } catch (e) {
          audioDone = true;
          maybeFinish();
        }
      }

      maybeFinish();
    });
  };

  AvatarRuntime.prototype._cancelSpeak = function () {
    if (this._speechFinish) this._speechFinish();
  };

  AvatarRuntime.prototype.destroy = function () {
    if (this._blinkTimer) clearTimeout(this._blinkTimer);
    if (this._blinkOffTimer) clearTimeout(this._blinkOffTimer);
    if (this._saccadeTimer) clearTimeout(this._saccadeTimer);
    if (this._emotionTimer) clearTimeout(this._emotionTimer);
    this._cancelSpeak();
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this._onVisibility);
    }
    this.el.classList.remove('is-blinking');
  };

  AvatarRuntime.prototype._scheduleBlink = function () {
    if (this.reduced || this._paused) return;
    var self = this;
    if (this._blinkTimer) clearTimeout(this._blinkTimer);
    this._blinkTimer = setTimeout(function () {
      self._blinkTimer = null;
      self.blink(0);
      if (Math.random() < 0.16) self.blink(230);
      self._scheduleBlink();
    }, rand(2800, 6600));
  };

  AvatarRuntime.prototype._scheduleSaccade = function () {
    if (this.reduced || this._paused) return;
    var self = this;
    if (this._saccadeTimer) clearTimeout(this._saccadeTimer);
    this._saccadeTimer = setTimeout(function () {
      self._saccadeTimer = null;
      self._randomGaze();
      self._scheduleSaccade();
    }, rand(1400, 3600));
  };

  AvatarRuntime.prototype._randomGaze = function () {
    switch (this.state) {
      case 'thinking':
        this.look(rand(-0.35, 0.35), rand(-0.9, -0.55));
        break;
      case 'listening':
        this.look(rand(-0.3, 0.3), rand(-0.15, 0.15));
        break;
      case 'speaking':
        this.look(rand(-0.14, 0.14), rand(-0.05, 0.2));
        break;
      case 'error':
        this.look(rand(-0.2, 0.2), 0.65);
        break;
      default:
        if (Math.random() < 0.62) this.look(rand(-0.9, 0.9), rand(-0.35, 0.25));
        else this.look(rand(-0.35, 0.35), rand(-0.1, 0.1));
    }
  };

  window.PocketAvatarRuntime = AvatarRuntime;
  window.PocketAvatarVisemes = { buildVisemeScript: buildVisemeScript };
})();
