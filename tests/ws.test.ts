import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { PROTOCOL_VERSION, type ServerMsg } from '@cryovanta/shared';
import { startServer, type RunningServer } from '../packages/server/src/server';

let srv: RunningServer;
beforeAll(async () => { srv = await startServer(0); });
afterAll(async () => { await srv.close(); });

function connect(name: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const msgs: ServerMsg[] = [];
  ws.on('message', (d) => msgs.push(JSON.parse(d.toString())));
  const ready = new Promise<void>((r) => ws.on('open', () => { ws.send(JSON.stringify({ k: 'hello', v: PROTOCOL_VERSION, name })); r(); }));
  const waitFor = async (pred: (m: ServerMsg) => boolean, ms = 2000) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = msgs.find(pred); if (m) return m; await new Promise((r) => setTimeout(r, 10)); }
    throw new Error('timeout waiting for message; got ' + msgs.map((m) => m.k).join(','));
  };
  return { ws, msgs, ready, waitFor, send: (m: object) => ws.send(JSON.stringify(m)) };
}

describe('real websocket server', () => {
  it('serves /healthz', async () => {
    const r = await fetch(`http://127.0.0.1:${srv.port}/healthz`);
    expect((await r.json()).ok).toBe(true);
  });
  it('hello -> welcome (token), quickplay -> room; 8 sockets => 7 + 1 across two rooms', async () => {
    const cs = Array.from({ length: 8 }, (_, i) => connect('w' + i));
    await Promise.all(cs.map((c) => c.ready));
    await Promise.all(cs.map((c) => c.waitFor((m) => m.k === 'welcome')));
    for (const c of cs) { c.send({ k: 'quickplay', game: 'neon-circuit' }); await c.waitFor((m) => m.k === 'room'); }
    const rooms = [...srv.hub.rooms.values()].map((r) => r.size).sort();
    expect(rooms).toEqual([1, 7]);
    cs.forEach((c) => c.ws.close());
  });
  it('rejects binary frames and junk without dropping the server', async () => {
    const c = connect('junk'); await c.ready;
    c.ws.send(Buffer.from([1, 2, 3])); c.ws.send('{{{');
    const e = await c.waitFor((m) => m.k === 'error');
    expect(e.k === 'error' && e.code).toBe('BAD_REQUEST');
    c.ws.close();
  });
});

describe('HTTPS/WSS (needed for phone motion sensors)', () => {
  it('serves /info and accepts secure websockets with the self-signed certificate', async () => {
    const s = await startServer(0, { httpsPort: 0 });
    try {
      expect(s.httpsPort).toBeGreaterThan(0);
      const info = await (await fetch(`http://127.0.0.1:${s.port}/info`)).json();
      expect(info.httpsPort).toBe(s.httpsPort); expect(Array.isArray(info.ips)).toBe(true);
      const ws = new WebSocket(`wss://127.0.0.1:${s.httpsPort}`, { rejectUnauthorized: false });
      const got = await new Promise<string>((res, rej) => { ws.on('open', () => ws.send(JSON.stringify({ k: 'hello', v: PROTOCOL_VERSION, name: 'secure' }))); ws.on('message', (d) => res(JSON.parse(d.toString()).k)); ws.on('error', rej); });
      expect(got).toBe('welcome'); ws.close();
    } finally { await s.close(); }
  });
});
