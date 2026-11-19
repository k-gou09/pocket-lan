// Petit gestionnaire d'evenements partage entre les modules.
// Pas de dependance, pas de DOM : les modules parlent entre eux via cet objet.

export class Bus {
  constructor() {
    this.handlers = new Map();
  }

  on(event, handler) {
    if (typeof handler !== 'function') return () => {};
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    const set = this.handlers.get(event);
    if (!set) return;
    set.delete(handler);
    if (!set.size) this.handlers.delete(event);
  }

  emit(event, payload) {
    const set = this.handlers.get(event);
    if (!set) return;
    for (const handler of set) {
      try {
        handler(payload);
      } catch (err) {
        console.error('[bus] handler', event, err);
      }
    }
  }

  clear() {
    this.handlers.clear();
  }
}
