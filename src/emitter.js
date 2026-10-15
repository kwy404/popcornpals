// A tiny event emitter shared by the mesh, the relays and the pairing code.
// A handler that throws is reported as an 'error' event instead of breaking the others.

export class Emitter {
  constructor() {
    this._handlers = new Map();
  }

  on(type, fn) {
    if (!this._handlers.has(type)) this._handlers.set(type, new Set());
    this._handlers.get(type).add(fn);
    return () => this._handlers.get(type)?.delete(fn);
  }

  emit(type, ...args) {
    for (const fn of this._handlers.get(type) || []) {
      try {
        fn(...args);
      } catch (err) {
        if (type !== 'error') this.emit('error', err);
      }
    }
  }
}
