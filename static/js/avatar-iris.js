// Troisième avatar : avatar/Qwen_iris.html charge dans une iframe.
// Iris utilise son propre runtime (WebGL/Canvas) mais expose le même contrat que
// Pocket et Nova : setState / setEmotion / setViseme / look / blink / pause.

import { AVATAR_STATES, AVATAR_EMOTIONS, AVATAR_VISEMES } from './avatar.js';

const IRIS_URL = '/avatar/Qwen_iris.html?embed=1';

export class IrisAvatar {
  constructor(el, { reducedMotion = false } = {}) {
    if (!el) throw new Error('Iris : conteneur manquant');
    this.el = el;
    this.reduced = reducedMotion;
    this.state = 'idle';
    this.emotion = 'neutral';
    this.viseme = 'rest';
    this._ready = false;
    this._pending = [];
    this.el.classList.add('avatar-iris-active');
    this.el.innerHTML =
      '<iframe class="iris-frame" src="' + IRIS_URL + '" title="Avatar Iris" tabindex="-1" aria-hidden="true"></iframe>' +
      '<div class="iris-error" hidden>Iris est indisponible sur ce serveur.</div>';
    this.frame = this.el.querySelector('.iris-frame');
    this.error = this.el.querySelector('.iris-error');

    this._onMessage = (event) => {
      if (event.source !== this.frame.contentWindow) return;
      if (event.origin !== window.location.origin) return;
      const data = event.data;
      if (!data || data.type !== 'pocket-avatar' || data.action !== 'ready') return;
      this._ready = true;
      clearTimeout(this._timeout);
      this._timeout = 0;
      this._flush();
    };
    window.addEventListener('message', this._onMessage);

    this._timeout = setTimeout(() => {
      if (!this._ready && this.error) this.error.hidden = false;
    }, 8000);
  }

  _send(action, payload = {}) {
    const message = Object.assign({ type: 'pocket-avatar', action }, payload);
    if (!this._ready || !this.frame.contentWindow) {
      this._pending.push(message);
      return;
    }
    this.frame.contentWindow.postMessage(message, window.location.origin);
  }

  _flush() {
    if (!this._ready || !this.frame.contentWindow) return;
    for (const message of this._pending.splice(0)) {
      this.frame.contentWindow.postMessage(message, window.location.origin);
    }
  }

  setState(state) {
    if (!AVATAR_STATES.includes(state)) return;
    this.state = state;
    this.el.dataset.state = state;
    this._send('state', { value: state });
  }

  setEmotion(emotion, duration = 2400) {
    if (!AVATAR_EMOTIONS.includes(emotion)) return;
    this.emotion = emotion;
    this.el.dataset.emotion = emotion;
    this._send('emotion', { value: emotion, duration });
  }

  setViseme(name, amplitude = 1) {
    const viseme = AVATAR_VISEMES.includes(name) ? name : 'rest';
    this.viseme = viseme;
    this.el.dataset.viseme = viseme;
    this._send('viseme', { value: viseme, amplitude });
  }

  look(x, y) {
    // Iris compte y positif vers le haut, Pocket vers le bas : on inverse.
    this._send('look', { x, y: -y });
  }

  blink(delay = 0) {
    if (this.reduced) return;
    this._send('blink', { delay });
  }

  setPaused(paused) {
    this._send('pause', { value: !!paused });
  }

  destroy() {
    clearTimeout(this._timeout);
    window.removeEventListener('message', this._onMessage);
    this.el.classList.remove('avatar-iris-active');
    this.el.innerHTML = '';
  }
}
