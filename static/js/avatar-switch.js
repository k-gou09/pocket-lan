// Bascule d'avatar sans casser le pipe existant : le client, le lip-sync et la
// voix gardent toujours la meme reference. Seule l'implementation interne change.

import { Avatar } from './avatar.js';
import { NovaAvatar } from './avatar-nova.js';
import { IrisAvatar } from './avatar-iris.js';

export const AVATARS = [
  { id: 'pocket', label: 'Pocket' },
  { id: 'nova', label: 'Nova · voix féminine' },
  { id: 'iris', label: 'Iris · la lucide' },
];

function createAvatar(id, el, options) {
  if (id === 'nova') return new NovaAvatar(el, options);
  if (id === 'iris') return new IrisAvatar(el, options);
  return new Avatar(el, options);
}

export class AvatarSwitch {
  constructor(el, options = {}) {
    if (!el) throw new Error('AvatarSwitch : conteneur manquant');
    this.el = el;
    this.options = options;
    this.id = '';
    this.current = null;
    this.use(options.avatar || 'pocket');
  }

  use(id) {
    const next = AVATARS.some((avatar) => avatar.id === id) ? id : 'pocket';
    if (next === this.id && this.current) return;

    const snapshot = this.current
      ? { state: this.current.state, emotion: this.current.emotion, viseme: this.current.viseme }
      : null;
    if (this.current) this.current.destroy();

    this.current = createAvatar(next, this.el, this.options);
    this.id = next;

    // On restaure l'etat visible pour ne pas faire clignoter l'avatar au changement.
    if (snapshot) {
      this.current.setState(snapshot.state);
      this.current.setEmotion(snapshot.emotion, 0);
      this.current.setViseme(snapshot.viseme, snapshot.viseme === 'rest' ? 0 : 1);
    }
    this.onChange?.(next);
  }

  setState(state) { this.current.setState(state); }
  setEmotion(emotion, duration) { this.current.setEmotion(emotion, duration); }
  setViseme(name, amplitude) { this.current.setViseme(name, amplitude); }
  look(x, y) { this.current.look(x, y); }
  blink(delay) { this.current.blink(delay); }
  setPaused(paused) { this.current.setPaused(paused); }
  destroy() { this.current.destroy(); }
}
