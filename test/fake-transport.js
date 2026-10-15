// In-memory links with the same surface as the WebRTC links, for protocol tests.
// Messages are delivered asynchronously and in order. Pairs can be blocked to
// simulate two peers behind strict NATs that cannot reach each other.

export class FakeHub {
  constructor() {
    this.offers = new Map();
    this.blocked = new Set();
    this.count = 0;
    this.sent = 0;
  }

  block(a, b) {
    this.blocked.add([a, b].sort().join('|'));
  }

  isBlocked(a, b) {
    return this.blocked.has([a, b].sort().join('|'));
  }

  transport(owner) {
    return { createLink: () => new FakeLink(this, owner) };
  }
}

const tick = () => new Promise((r) => setImmediate(r));

export class FakeLink {
  constructor(hub, owner) {
    this.hub = hub;
    this.owner = owner;
    this.open = false;
    this.closed = false;
    this.remote = null;
    this.onopen = null;
    this.onmessage = null;
    this.onclose = null;
    this.onfail = null;
  }

  async offer() {
    await tick();
    this.token = `t${++this.hub.count}`;
    this.hub.offers.set(this.token, this);
    return `fake-offer ${this.token} ${this.owner}`;
  }

  async answer(sdp) {
    await tick();
    const [kind, token] = sdp.split(' ');
    const offerer = this.hub.offers.get(token);
    if (kind !== 'fake-offer' || !offerer) throw new Error('unknown offer');
    this.remote = offerer;
    offerer.answerer = this;
    return `fake-answer ${token} ${this.owner}`;
  }

  async complete(sdp) {
    await tick();
    if (this.completed) return false;
    this.completed = true;
    const [kind, token] = sdp.split(' ');
    if (kind !== 'fake-answer' || token !== this.token || !this.answerer) throw new Error('unknown answer');
    const other = this.answerer;
    this.remote = other;
    this.hub.offers.delete(token);
    if (this.hub.isBlocked(this.owner, other.owner)) {
      setTimeout(() => {
        this.onfail?.('failed');
        other.onfail?.('failed');
      }, 5);
      return;
    }
    setImmediate(() => {
      if (this.closed || other.closed) return;
      this.open = other.open = true;
      this.onopen?.();
      other.onopen?.();
    });
  }

  send(data) {
    if (!this.open) throw new Error('link is not open');
    const other = this.remote;
    this.hub.sent++;
    setImmediate(() => {
      if (other.open) other.onmessage?.(data);
    });
  }

  close() {
    if (this.closed) return;
    const wasOpen = this.open;
    this.closed = true;
    this.open = false;
    if (wasOpen) this.onclose?.();
    if (this.remote && !this.remote.closed) setImmediate(() => this.remote.close());
  }
}

/** Resolve after pending timers settle. */
export async function settle(rounds = 200) {
  for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
}
