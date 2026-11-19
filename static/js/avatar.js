// Avatar "Pocket Live" : robot expressif (yeux, regard, visemes).
// Composant autonome, sans dependance, pilote par data-state / data-emotion / data-viseme.
const SVG = `
<svg class="av-svg" viewBox="0 0 400 470" aria-hidden="true" focusable="false">
  <defs>
    <radialGradient id="avEyeGlow" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#6ee7b7" stop-opacity="0.5"/>
      <stop offset="100%" stop-color="#6ee7b7" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="avHaloGrad" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#5b8cff" stop-opacity="0.16"/>
      <stop offset="55%" stop-color="#6ee7b7" stop-opacity="0.06"/>
      <stop offset="100%" stop-color="#6ee7b7" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="avVisorGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#0d1620"/>
      <stop offset="100%" stop-color="#070c12"/>
    </linearGradient>
    <linearGradient id="avHeadGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#2b3a4a"/>
      <stop offset="55%" stop-color="#22303e"/>
      <stop offset="100%" stop-color="#19232f"/>
    </linearGradient>
    <linearGradient id="avTorsoGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#263442"/>
      <stop offset="100%" stop-color="#18222d"/>
    </linearGradient>
    <linearGradient id="avSheenGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#ffffff" stop-opacity="0.1"/>
      <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
  </defs>

  <circle class="av-halo" cx="200" cy="252" r="188"/>
  <g class="av-rings">
    <circle class="av-ring av-ring-1" cx="200" cy="252" r="150"/>
    <circle class="av-ring av-ring-2" cx="200" cy="252" r="168"/>
  </g>
  <ellipse class="av-shadow" cx="200" cy="452" rx="96" ry="12"/>

  <g class="av-body">
    <g class="av-head-group">
      <line class="av-antenna" x1="200" y1="98" x2="200" y2="66"/>
      <circle class="av-antenna-glow" cx="200" cy="52" r="30"/>
      <circle class="av-antenna-ball" cx="200" cy="52" r="14"/>

      <rect class="av-head" x="56" y="92" width="288" height="236" rx="88"/>
      <rect class="av-head-edge" x="56" y="92" width="288" height="236" rx="88"/>
      <rect class="av-visor" x="86" y="118" width="228" height="184" rx="64"/>
      <rect class="av-visor-sheen" x="94" y="126" width="212" height="62" rx="54"/>

      <g class="av-eyes">
        <circle class="av-eye-glow" cx="152" cy="198" r="50"/>
        <circle class="av-eye-glow" cx="248" cy="198" r="50"/>
        <g class="av-eye av-eye-left">
          <rect class="av-lens" x="120" y="170" width="64" height="56" rx="26"/>
          <g class="av-pupil">
            <circle class="av-pupil-core" cx="152" cy="198" r="13"/>
            <circle class="av-glint" cx="147" cy="193" r="4"/>
          </g>
        </g>
        <g class="av-eye av-eye-right">
          <rect class="av-lens" x="216" y="170" width="64" height="56" rx="26"/>
          <g class="av-pupil">
            <circle class="av-pupil-core" cx="248" cy="198" r="13"/>
            <circle class="av-glint" cx="243" cy="193" r="4"/>
          </g>
        </g>
      </g>

      <g class="av-eyes-happy">
        <path d="M122 205 q30 -26 60 0"/>
        <path d="M218 205 q30 -26 60 0"/>
      </g>

      <g class="av-mouths">
        <rect class="av-mouth av-mouth-rest" x="174" y="262" width="52" height="10" rx="5"/>
        <path class="av-mouth av-mouth-smile" d="M162 256 q38 30 76 0"/>
        <path class="av-mouth av-mouth-frown" d="M166 280 q34 -26 68 0"/>
        <ellipse class="av-mouth av-mouth-a" cx="200" cy="266" rx="31" ry="23"/>
        <rect class="av-mouth av-mouth-e" x="158" y="252" width="84" height="30" rx="15"/>
        <rect class="av-mouth av-mouth-i" x="183" y="244" width="34" height="48" rx="15"/>
        <circle class="av-mouth av-mouth-o" cx="200" cy="268" r="23"/>
        <circle class="av-mouth av-mouth-u" cx="200" cy="269" r="15"/>
      </g>

      <g class="av-think">
        <circle cx="316" cy="84" r="6"/>
        <circle cx="338" cy="68" r="7"/>
        <circle cx="360" cy="84" r="8"/>
      </g>
    </g>

    <rect class="av-neck" x="182" y="320" width="36" height="28" rx="13"/>
    <rect class="av-torso" x="108" y="344" width="184" height="88" rx="40"/>
    <rect class="av-torso-sheen" x="120" y="350" width="160" height="34" rx="26"/>
    <rect class="av-arm av-arm-left" x="58" y="352" width="32" height="60" rx="16"/>
    <rect class="av-arm av-arm-right" x="310" y="352" width="32" height="60" rx="16"/>
    <circle class="av-chest-ring" cx="200" cy="388" r="16"/>
    <circle class="av-chest" cx="200" cy="388" r="6"/>
  </g>
</svg>`;

export const AVATAR_STATES = ['idle', 'listening', 'thinking', 'speaking', 'error'];
export const AVATAR_EMOTIONS = [
  'neutral',
  'happy',
  'sad',
  'surprised',
  'curious',
  'angry',
  'sleepy',
];
export const AVATAR_VISEMES = ['rest', 'a', 'e', 'i', 'o', 'u', 'smile'];

const rand = (min, max) => min + Math.random() * (max - min);

export class Avatar {
  constructor(el, { reducedMotion = false } = {}) {
    if (!el) throw new Error('Avatar : conteneur manquant');
    this.el = el;
    this.reduced = reducedMotion;
    this.el.innerHTML = SVG;
    this.el.dataset.state = 'idle';
    this.el.dataset.emotion = 'neutral';
    this.el.dataset.viseme = 'rest';
    this.el.style.setProperty('--gaze-x', '0px');
    this.el.style.setProperty('--gaze-y', '0px');
    this.el.style.setProperty('--jaw', '0');

    this.state = 'idle';
    this.emotion = 'neutral';
    this.viseme = 'rest';
    this._paused = document.hidden;
    this._blinkTimer = null;
    this._saccadeTimer = null;
    this._emotionTimer = null;

    this._onVisibility = () => this.setPaused(document.hidden);
    document.addEventListener('visibilitychange', this._onVisibility);
    if (!this._paused) {
      this.#scheduleBlink();
      this.#scheduleSaccade();
    }
  }

  // ---------- etats ----------

  setState(state) {
    if (!AVATAR_STATES.includes(state)) return;
    this.state = state;
    this.el.dataset.state = state;
    if (state === 'speaking') this.look(0, 0.1);
    else if (state === 'thinking') this.look(0, -0.75);
    else if (state === 'listening') this.look(0, 0);
    else if (state === 'error') this.look(0, 0.65);
    if (state !== 'speaking') this.setViseme('rest', 0);
  }

  setEmotion(emotion, duration = 2400) {
    if (!AVATAR_EMOTIONS.includes(emotion)) return;
    this.emotion = emotion;
    this.el.dataset.emotion = emotion;
    clearTimeout(this._emotionTimer);
    this._emotionTimer = null;
    if (emotion !== 'neutral' && duration > 0) {
      this._emotionTimer = setTimeout(() => {
        this._emotionTimer = null;
        this.setEmotion('neutral', 0);
      }, duration);
    }
  }

  // ---------- regard ----------

  // x et y dans [-1, 1] : decalage doux des pupilles.
  look(x, y) {
    const gx = Math.max(-1, Math.min(1, x)) * 6;
    const gy = Math.max(-1, Math.min(1, y)) * 5;
    this.el.style.setProperty('--gaze-x', gx.toFixed(1) + 'px');
    this.el.style.setProperty('--gaze-y', gy.toFixed(1) + 'px');
  }

  // ---------- bouche ----------

  setViseme(name, amplitude = 1) {
    const viseme = AVATAR_VISEMES.includes(name) ? name : 'rest';
    if (this.viseme !== viseme) {
      this.viseme = viseme;
      this.el.dataset.viseme = viseme;
    }
    const amp = Math.max(0, Math.min(1, Number(amplitude) || 0));
    this.el.style.setProperty('--jaw', amp.toFixed(2));
  }

  // ---------- clignement ----------

  blink(delay = 0) {
    // Mouvement reduit : aucun clignement n'est applique, et le minuterie reste inactive.
    if (this.reduced) return;
    if (delay > 0) {
      setTimeout(() => this.blink(), delay);
      return;
    }
    this.el.classList.add('is-blinking');
    clearTimeout(this._blinkOffTimer);
    this._blinkOffTimer = setTimeout(() => {
      this.el.classList.remove('is-blinking');
    }, 140);
  }

  // ---------- cycle de vie ----------

  setPaused(paused) {
    this._paused = paused;
    if (paused) {
      clearTimeout(this._blinkTimer);
      clearTimeout(this._saccadeTimer);
      this._blinkTimer = null;
      this._saccadeTimer = null;
      return;
    }
    this.#scheduleBlink();
    this.#scheduleSaccade();
  }

  destroy() {
    clearTimeout(this._blinkTimer);
    clearTimeout(this._saccadeTimer);
    clearTimeout(this._emotionTimer);
    clearTimeout(this._blinkOffTimer);
    document.removeEventListener('visibilitychange', this._onVisibility);
    this.el.innerHTML = '';
  }

  #scheduleBlink() {
    if (this.reduced) return;
    clearTimeout(this._blinkTimer);
    this._blinkTimer = setTimeout(() => {
      this._blinkTimer = null;
      this.blink();
      if (Math.random() < 0.16) this.blink(230);
      this.#scheduleBlink();
    }, rand(2800, 6600));
  }

  #scheduleSaccade() {
    if (this.reduced) return;
    clearTimeout(this._saccadeTimer);
    this._saccadeTimer = setTimeout(() => {
      this._saccadeTimer = null;
      this.#randomGaze();
      this.#scheduleSaccade();
    }, rand(1400, 3600));
  }

  #randomGaze() {
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
  }
}
