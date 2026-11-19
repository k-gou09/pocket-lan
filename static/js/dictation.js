// Dictation (mode Avatar) : transcription par le moteur de reconnaissance en ligne du
// navigateur. Rien n'est simule : sans SpeechRecognition ni webkitSpeechRecognition
// l'etat reste 'unsupported' et start() ne produit aucun texte. start() doit partir d'un
// geste utilisateur (clic ou touche) : sans geste, le module refuse d'appeler le moteur
// (code 'requires-activation') parce que le navigateur refuserait l'acces au micro.
// Evenements : 'result' { text, isFinal, ts } (partiels : isFinal = false), 'state',
// 'error' { code, message }, 'usage' emis une seule fois au premier start().
// Etas : 'idle', 'listening', 'stopped', 'error', 'unsupported'.

const MAX_ATTEMPTS = 3;  // reprises consecutives autorisees par session
const BASE_DELAY = 600;  // 600 / 1200 / 2400 ms
const FATAL_CODES = new Set(['not-allowed', 'not-allowed-external', 'audio-capture', 'language-not-supported']);
const RETRY_CODES = new Set(['no-speech', 'network', 'network-error', 'audio', 'aborted', 'error']); // non fatals

const MESSAGES = {
  unsupported: 'Reconnaissance vocale indisponible dans ce navigateur : la dictee passe par un service en ligne.',
  'not-allowed': 'Acces au microphone refuse : autorisez le micro, puis relancez la dictee.',
  'audio-capture': 'Microphone introuvable : verifiez le peripherique d enregistrement.',
  'language-not-supported': 'Langue de dictee non prise en charge par le moteur en ligne du navigateur.',
  max: 'Trois tentatives de reprise sans succes : la dictee est arretee, relancez-la.',
  'requires-activation': 'La dictee doit etre lancee par un clic ou une touche : le navigateur refuse la reconnaissance sans geste utilisateur.',
  generic: 'Le service de reconnaissance en ligne a interrompu la dictee.',
};

// On ne choisit pas le moteur : on prend celui que le navigateur expose.
const engine = () => globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition || null;
const messageFor = (code) => MESSAGES[code] || MESSAGES.generic;

export class Dictation {
  #options;
  #state = 'unsupported';
  #handlers = new Map();
  #listeners = [];
  #recognition = null;
  #closing = false;       // drapeau interne : un cycle clos ne relance pas via 'end'
  #stoppedByUser = false; // stop() volontaire : aucune reprise
  #pendingRetry = null;   // erreur non fatale en attente du 'end'
  #attempt = 0;           // tentatives consecutives depuis le dernier start()
  #timer = 0;
  #usageSent = false;
  #activationSeen = false;
  #destroyed = false;

  constructor({ lang = 'fr-FR', continuous = true, interimResults = true } = {}) {
    this.#options = { lang, continuous, interimResults };
    this.#state = engine() ? 'idle' : 'unsupported';
  }

  static get supported() { return Boolean(engine()); }

  get state() { return this.#state; }

  // True : la dictee passe toujours par le service en ligne du navigateur.
  get onlineService() { return true; }

  on(event, handler) {
    if (typeof handler !== 'function') return this;
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return this;
  }

  off(event, handler) {
    const set = this.#handlers.get(event);
    if (set) (handler ? set.delete(handler) : this.#handlers.delete(event));
    return this;
  }

  async start() {
    if (this.#destroyed) return false;
    const Ctor = engine();
    if (!Ctor) {
      this.#setState('unsupported');
      this.#emit('error', { code: 'unsupported', message: MESSAGES.unsupported });
      return false;
    }

    // Le service en ligne est annonce une seule fois, au premier start().
    if (!this.#usageSent) {
      this.#usageSent = true;
      this.#emit('usage', {
        service: 'navigateur',
        network: true,
        message: 'La dictee utilise le service de reconnaissance en ligne du navigateur.',
      });
    }

    if (!this.#activationSeen) {
      if (!globalThis.navigator?.userActivation?.isActive) {
        // Mesure sur Android : sans geste en cours, le navigateur refuse l'acces au
        // micro (error 'not-allowed' constatee). On ne simule pas la reconnaissance :
        // on annonce qu'un clic est necessaire, l'etat ne change pas.
        this.#emit('error', { code: 'requires-activation', message: MESSAGES['requires-activation'] });
        return false;
      }
      this.#activationSeen = true;
    }

    if (!this.#recognition) this.#recognition = this.#open(Ctor);
    this.#stoppedByUser = false;
    this.#closing = false;
    this.#pendingRetry = null;
    this.#attempt = 0;
    try {
      this.#recognition.start();
    } catch {
      /* instance deja active : on reste sur le cycle en cours */
      this.#setState('listening');
    }
    return true;
  }

  // Arret volontaire : etat 'stopped', aucune relance.
  stop() {
    this.#stoppedByUser = true;
    this.#closing = true;
    this.#pendingRetry = null;
    clearTimeout(this.#timer);
    this.#timer = 0;
    try {
      this.#recognition?.stop();
    } catch {
      /* deja arrete */
    }
    if (this.#state !== 'unsupported') this.#setState('stopped');
  }

  // Detache les listeners et arrete proprement.
  destroy() {
    this.#destroyed = true;
    this.stop();
    for (const [target, name, handler] of this.#listeners) target.removeEventListener(name, handler);
    this.#listeners = [];
    this.#handlers = new Map();
    this.#recognition = null;
    this.#attempt = 0;
  }

  #open(Ctor) {
    const recognition = new Ctor();
    recognition.lang = this.#options.lang;
    recognition.continuous = this.#options.continuous;
    recognition.interimResults = this.#options.interimResults;
    recognition.maxAlternatives = 1;
    const handlers = {
      start: () => { if (!this.#closing) this.#setState('listening'); },
      result: (event) => this.#onResult(event),
      error: (event) => this.#onError(event),
      end: () => this.#onEnd(),
    };
    for (const [name, handler] of Object.entries(handlers)) {
      recognition.addEventListener(name, handler);
      this.#listeners.push([recognition, name, handler]);
    }
    return recognition;
  }

  #onResult(event) {
    const results = event?.results;
    if (!results || results.length === 0) return;
    this.#attempt = 0; // un mot dit prouve que le service repond : le compteur repart
    for (let i = event?.resultIndex ?? 0; i < results.length; i += 1) {
      const result = results[i];
      const text = String(result?.[0]?.transcript ?? '').trim();
      if (text) this.#emit('result', { text, isFinal: Boolean(result.isFinal), ts: Date.now() });
    }
  }

  #onError(event) {
    const code = String(event?.error || 'error');
    if (this.#destroyed || this.#stoppedByUser || this.#closing) return;
    if (FATAL_CODES.has(code)) {
      this.#closing = true;
      this.#setState('error');
      this.#emit('error', { code, message: messageFor(code) });
      return;
    }
    if (!RETRY_CODES.has(code) || this.#attempt >= MAX_ATTEMPTS) {
      this.#closing = true;
      this.#setState('error');
      this.#emit('error', { code, message: this.#attempt >= MAX_ATTEMPTS ? MESSAGES.max : messageFor(code) });
      return;
    }
    // La reprise se declenche au 'end' : l'instance est encore active, relancer tout
    // de suite leverait une InvalidStateError.
    this.#attempt += 1;
    this.#pendingRetry = code;
    this.#closing = true;
  }

  #onEnd() {
    if (this.#destroyed || this.#stoppedByUser) return;
    if (this.#pendingRetry) {
      const code = this.#pendingRetry;
      const delay = BASE_DELAY * 2 ** (this.#attempt - 1);
      this.#pendingRetry = null;
      this.#timer = setTimeout(() => {
        this.#timer = 0;
        this.#closing = false;
        try {
          this.#recognition?.start();
        } catch {
          this.#closing = true;
          this.#setState('error');
          this.#emit('error', { code, message: messageFor(code) });
        }
      }, delay);
      return;
    }
    // Un 'end' sans reprise ne relance jamais : l'etat est deja decide par stop(),
    // par une erreur bloquante ou par la fin naturelle de la session.
    if (this.#closing) return;
    this.#setState('idle');
  }

  #setState(next) {
    if (this.#state === next) return;
    this.#state = next;
    this.#emit('state', next);
  }

  #emit(event, payload) {
    const set = this.#handlers.get(event);
    if (!set) return;
    for (const handler of [...set]) {
      try {
        handler(payload);
      } catch {
        /* un listener ne doit pas casser la dictee */
      }
    }
  }
}
