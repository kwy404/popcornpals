import { describe, expect, it } from 'vitest';
import { Emitter, MAX_MEMBERS, Mesh, cleanAvatar, cleanExtras, electRelay, forwardTargets } from '../src/mesh.js';
import { FakeHub, settle } from './fake-transport.js';

const ROOM = { id: 'room000000000001', name: 'Movie night' };
let clock = 1000;
const now = () => clock++;

function peer(hub, id, opts = {}) {
  const mesh = new Mesh({ self: { id, name: id.toUpperCase(), avatar: `a-${id}` }, room: ROOM, transport: hub.transport(id), now, introTimeout: 200, ...opts });
  mesh.inbox = [];
  mesh.on('message', (m) => mesh.inbox.push(m));
  return mesh;
}

// The one round trip the six word handshake carries: the invite and the reply.
async function join(introducer, guest) {
  const { inviteId, sdp } = await introducer.createInvite();
  const reply = await guest.acceptInvite({ inviteId, room: introducer.room, host: introducer.self, sdp });
  await introducer.acceptReply(JSON.parse(JSON.stringify(reply)));
  await settle();
}

const linked = (mesh) => [...mesh.links.keys()].sort();
const online = (mesh) => mesh.memberList().filter((m) => m.online).map((m) => m.id).sort();

describe('pure helpers', () => {
  it('elects the online member who joined first', () => {
    const members = [
      { id: 'b', joinedAt: 5, online: true },
      { id: 'a', joinedAt: 3, online: false },
      { id: 'c', joinedAt: 5, online: true },
      { id: 'd', joinedAt: null, online: true },
    ];
    expect(electRelay(members)).toBe('b');
    expect(electRelay([{ id: 'x', joinedAt: 1, online: false }])).toBe(null);
  });

  it('forwards only to peers the origin cannot reach', () => {
    expect(forwardTargets({ origin: 'a', via: 'a', linked: ['a', 'b', 'c', 'd'], originLinks: new Set(['r', 'b']) })).toEqual(['c', 'd']);
    expect(forwardTargets({ origin: 'a', via: 'b', linked: ['a', 'b', 'c'], originLinks: undefined })).toEqual(['c']);
  });

  it('isolates emitter handler errors', () => {
    const e = new Emitter();
    const errors = [];
    e.on('error', (err) => errors.push(err.message));
    e.on('x', () => {
      throw new Error('boom');
    });
    const off = e.on('x', (v) => errors.push(`got ${v}`));
    e.emit('x', 1);
    off();
    e.emit('x', 2);
    expect(errors).toEqual(['boom', 'got 1', 'boom']);
  });
});

describe('mesh introduction', () => {
  it('connects a guest through one invite and one reply', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const guest = peer(hub, 'bb');
    const welcomes = [];
    guest.on('welcome', (w) => welcomes.push(w));
    await join(host, guest);
    expect(linked(host)).toEqual(['bb']);
    expect(linked(guest)).toEqual(['aa']);
    expect(welcomes).toHaveLength(1);
    expect(welcomes[0].expected).toEqual([]);
    expect(guest.relay).toBe('aa');
    expect(guest.self.joinedAt).toBeGreaterThan(host.self.joinedAt);
    expect(online(guest)).toEqual(['aa', 'bb']);
    expect(guest.memberList().find((m) => m.id === 'aa').name).toBe('AA');
  });

  it('builds a full mesh where only the host paired with each guest', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const guests = ['bb', 'cc', 'dd', 'ee'].map((id) => peer(hub, id));
    for (const g of guests) await join(host, g);
    await settle();
    const all = [host, ...guests];
    const ids = all.map((m) => m.self.id).sort();
    for (const m of all) {
      expect(linked(m)).toEqual(ids.filter((id) => id !== m.self.id));
      expect(online(m)).toEqual(ids);
      expect(m.relay).toBe('aa');
    }
    const order = host.memberList().map((m) => m.id);
    for (const m of all) expect(m.memberList().map((x) => x.id)).toEqual(order);
  });

  it('holds at most five people, the host included, and tells the sixth why', async () => {
    expect(MAX_MEMBERS).toBe(5);
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const rejected = [];
    host.on('rejected', (r) => rejected.push(r));
    for (const id of ['bb', 'cc', 'dd', 'ee']) await join(host, peer(hub, id));
    expect(host.onlineCount()).toBe(5);
    expect(host.full).toBe(true);
    const sixth = peer(hub, 'ff');
    const told = [];
    sixth.on('full', (f) => told.push(f));
    const invite = await host.createInvite();
    expect(invite.full).toBe(true);
    const reply = await sixth.acceptInvite({ inviteId: invite.inviteId, room: ROOM, host: host.self, sdp: invite.sdp });
    await host.acceptReply(reply);
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(told).toEqual([{ max: 5, count: 5 }]);
    expect(rejected).toEqual([{ peer: { id: 'ff', name: 'FF' }, max: 5, count: 5 }]);
    expect(host.onlineCount()).toBe(5);
    expect(host.members.has('ff')).toBe(false);
    expect(linked(sixth)).toEqual([]);
  });

  it('lets a new person in once someone leaves a full room', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const guests = [];
    for (const id of ['bb', 'cc', 'dd', 'ee']) {
      const g = peer(hub, id);
      guests.push(g);
      await join(host, g);
    }
    const invite = await host.createInvite();
    expect(invite.full).toBe(true);
    guests[3].leave();
    await settle();
    const late = peer(hub, 'ff');
    const reply = await late.acceptInvite({ inviteId: invite.inviteId, room: ROOM, host: host.self, sdp: invite.sdp });
    await host.acceptReply(reply);
    await settle(400);
    expect(linked(late)).toEqual(['aa', 'bb', 'cc', 'dd']);
    expect(host.onlineCount()).toBe(5);
  });

  it('honors a smaller limit', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true, max: 2 });
    await join(host, peer(hub, 'bb'));
    const third = peer(hub, 'cc');
    const told = [];
    third.on('full', (f) => told.push(f));
    const invite = await host.createInvite();
    await host.acceptReply(await third.acceptInvite({ inviteId: invite.inviteId, room: ROOM, host: host.self, sdp: invite.sdp }));
    await new Promise((r) => setTimeout(r, 300));
    await settle();
    expect(told).toEqual([{ max: 2, count: 2 }]);
  });

  it('ignores a full notice from anyone but the introducer', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    const c = peer(hub, 'cc');
    await join(host, b);
    await join(host, c);
    const told = [];
    c.on('full', (f) => told.push(f));
    b.links.get('cc').send(JSON.stringify({ t: 'full', max: 1 }));
    await settle();
    expect(told).toEqual([]);
  });

  it('delivers broadcasts once to everyone and direct messages to one peer', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    const c = peer(hub, 'cc');
    await join(host, b);
    await join(host, c);
    const id = c.broadcast({ text: 'hi all' });
    b.sendTo('aa', { text: 'just you' });
    await settle();
    expect(host.inbox.map((m) => m.body.text).sort()).toEqual(['hi all', 'just you']);
    expect(b.inbox.map((m) => [m.body.text, m.from, m.id, m.direct])).toEqual([['hi all', 'cc', id, true]]);
    expect(c.inbox).toHaveLength(0);
  });

  it('elects a new relay when the host leaves and keeps working', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    const c = peer(hub, 'cc');
    await join(host, b);
    await join(host, c);
    const relays = [];
    c.on('relay', (r) => relays.push(r));
    host.leave();
    await settle();
    expect(b.relay).toBe('bb');
    expect(c.relay).toBe('bb');
    expect(relays).toEqual(['bb']);
    expect(online(c)).toEqual(['bb', 'cc']);
    expect(c.memberList().find((m) => m.id === 'aa').online).toBe(false);

    const d = peer(hub, 'dd');
    await join(b, d);
    await settle();
    expect(linked(d)).toEqual(['bb', 'cc']);
    expect(d.relay).toBe('bb');
    d.broadcast({ text: 'after' });
    await settle();
    expect(c.inbox.map((m) => m.body.text)).toEqual(['after']);
  });

  it('routes through the relay when two members cannot connect directly', async () => {
    const hub = new FakeHub();
    hub.block('bb', 'cc');
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    const c = peer(hub, 'cc');
    const failures = [];
    c.on('link-failed', (f) => failures.push(f.peerId));
    await join(host, b);
    await join(host, c);
    await new Promise((r) => setTimeout(r, 260));
    await settle();
    expect(linked(c)).toEqual(['aa']);
    expect(failures).toContain('bb');
    b.broadcast({ text: 'relayed' });
    c.sendTo('bb', { text: 'routed' });
    await settle();
    expect(c.inbox.map((m) => [m.body.text, m.direct])).toEqual([['relayed', false]]);
    expect(b.inbox.map((m) => [m.body.text, m.direct])).toEqual([['routed', false]]);
    expect(host.inbox).toHaveLength(1);
  });

  it('shares profile changes', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    await join(host, b);
    b.setProfile({ name: 'Bruno', avatar: 'new' });
    await settle();
    expect(host.memberList().find((m) => m.id === 'bb')).toMatchObject({ name: 'Bruno', avatar: 'new' });
  });

  it('explains wrong, stale and self invites', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const { inviteId, sdp } = await host.createInvite();
    await expect(host.acceptReply({ inviteId: 'nope', peer: { id: 'x' }, sdp: '' })).rejects.toMatchObject({ reason: 'expired' });
    await expect(host.acceptReply({ inviteId, roomId: 'other', peer: { id: 'x' }, sdp: '' })).rejects.toMatchObject({ reason: 'room' });
    await expect(host.acceptReply({ inviteId, peer: { id: 'aa' }, sdp: '' })).rejects.toMatchObject({ reason: 'self' });
    await expect(host.acceptInvite({ inviteId, room: ROOM, host: host.self, sdp })).rejects.toMatchObject({ reason: 'self' });
    host.cancelInvite(inviteId);
    expect(host.pending.size).toBe(0);
  });

  it('keeps known members from history offline until they connect', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    host.addKnownMembers([{ id: 'zz', name: 'Old friend', joinedAt: 1 }, { id: 'aa', name: 'me' }]);
    expect(host.memberList().map((m) => [m.id, m.online])).toEqual([['zz', false], ['aa', true]]);
    expect(host.relay).toBe('aa');
    const b = peer(hub, 'bb');
    await join(host, b);
    expect(b.memberList().find((m) => m.id === 'zz')).toMatchObject({ name: 'Old friend', online: false });
    expect(b.relay).toBe('aa');
  });

  it('ignores garbage and spoofed control messages', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    await join(host, b);
    const link = b.links.get('aa');
    link.send('not json');
    link.send(JSON.stringify({ nope: 1 }));
    link.send(JSON.stringify({ t: 'hello', peer: { id: 'zz', name: 'spoof' } }));
    link.send(JSON.stringify({ t: 'welcome', members: [] }));
    await settle();
    expect(host.members.has('zz')).toBe(false);
    expect(linked(host)).toEqual(['bb']);
  });

  it('stops everything on leave', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    await join(host, b);
    await host.createInvite();
    b.leave();
    b.leave();
    await settle();
    expect(b.links.size).toBe(0);
    expect(linked(host)).toEqual([]);
    expect(online(host)).toEqual(['aa']);
    await expect(b.createInvite()).rejects.toMatchObject({ reason: 'closed' });
  });

  it('adopts a link opened before the conversation id was known', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const guest = peer(hub, 'bb');
    const loose = hub.transport('aa').createLink();
    const sdp = await loose.offer();
    const reply = await guest.acceptInvite({ inviteId: 'x', room: ROOM, host: host.self, sdp });
    loose.onopen = () => host.adopt(loose, reply.peer);
    await loose.complete(reply.sdp);
    await settle();
    expect(linked(host)).toEqual(['bb']);
    expect(linked(guest)).toEqual(['aa']);
    expect(guest.relay).toBe('aa');
    guest.broadcast({ text: 'hi' });
    await settle();
    expect(host.inbox.map((m) => m.body.text)).toEqual(['hi']);
  });

  it('shares status and accent and cleans avatars', async () => {
    const hub = new FakeHub();
    const host = peer(hub, 'aa', { host: true });
    const b = peer(hub, 'bb');
    await join(host, b);
    b.setProfile({ status: 'away for lunch', accent: '#12abef' });
    await settle();
    expect(host.memberList().find((m) => m.id === 'bb')).toMatchObject({ status: 'away for lunch', accent: '#12abef' });
    expect(cleanAvatar('data:image/png;base64,AAAA')).toBe('data:image/png;base64,AAAA');
    expect(cleanAvatar('data:text/html;base64,AAAA')).toBe('');
    expect(cleanAvatar('data:image/svg+xml,<svg onload=x>')).toBe('');
    expect(cleanAvatar('seed'.repeat(30)).length).toBe(64);
    expect(cleanExtras({ status: 's'.repeat(300), accent: 'red' })).toEqual({ status: 's'.repeat(128), accent: '' });
  });
});
