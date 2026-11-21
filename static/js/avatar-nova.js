// Second avatar : avatar/nova.html charge dans une iframe.
//nova.html utilise exactement le meme runtime et le meme contrat que l'avatar
//integral (data-state / data-emotion / data-viseme, --gaze-x/y, --jaw). Ce module
//se contente de relayer les appels du client vers le runtime de l'iframe.

import { AVATAR_STATES, AVATAR_EMOTIONS, AVATAR_VISEMES } from './avatar.js';

const NOVA_URL = '/avatar/nova.html?embed=1';

export class NovaAvatar {
  constructor(el, { reducedMotion = false } = {}) {
    if (!el) throw new Error('Nova : conteneur manquant');
    this.el = el;
    this.reduced = reducedMotion;
    this.state = 'idle';
    this.emotion = 'neutral';
    this.viseme = 'rest';
    this._ready = false;
    this._pending = [];
    this.el.classList.add('avatar-nova-active');
    this.el.innerHTML =
      '<iframe class="nova-frame" src="' + NOVA_URL + '" title="Avatar Nova" tabindex="-1" aria-hidden="true"></iframe>' +
      '<div class="nova-error" hidden>Nova est indisponible sur ce serveur.</div>';
    this.frame = this.el.querySelector('.nova-frame');
    this.error = this.el.querySelector('.nova-error');

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
    this._send('look', { x, y });
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
    this.el.classList.remove('avatar-nova-active');
    this.el.innerHTML = '';
  }
}
