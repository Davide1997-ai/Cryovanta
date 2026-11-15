import { createServer, type Server } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { TICK_RATE } from '@cryovanta/shared';
import { obstacleRaceModule } from './games/obstacleRace';
import { Client, wsTransport } from './hub/client';
import { Hub } from './hub/hub';

export interface RunningServer { hub: Hub; port: number; close(): Promise<void>; }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

/** staticDir: optional built client (dist) to serve over HTTP — used by the desktop app and for LAN play. */
export async function startServer(port = 8080, opts: { staticDir?: string; host?: string } = {}): Promise<RunningServer> {
  const hub = new Hub([obstacleRaceModule]);
  const http: Server = createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: hub.rooms.size, clients: hub.clients.size })); }
    else if (opts.staticDir) {
      const rel = normalize(decodeURIComponent((req.url ?? '/').split('?')[0])).replace(/^([/\\])+/, '');
      let file = join(opts.staticDir, rel === '' ? 'index.html' : rel);
      if (!file.startsWith(opts.staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(opts.staticDir, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }); res.end(readFileSync(file));
    } else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    const client = new Client(wsTransport(ws));
    if (!hub.accept(client)) { ws.close(1013, 'server busy'); return; }
    ws.on('message', (data, isBinary) => { if (!isBinary) hub.onMessage(client, data.toString()); });
    ws.on('close', () => hub.onClose(client));
    ws.on('error', () => ws.terminate());
  });

  // Fixed-timestep loop with catch-up (bounded). Coarse OS timers (Windows ~15 ms) would bunch ticks together and
  // make snapshot spacing uneven => stutter on clients. So: sleep most of the wait, then yield-spin the last ~2 ms.
  const stepMs = 1000 / TICK_RATE;
  let next = performance.now();
  let timer: NodeJS.Timeout | undefined, alive = true;
  const loop = () => {
    if (!alive) return;
    const now = performance.now();
    let guard = 0;
    while (now >= next && guard++ < 5) { hub.tick(Date.now()); next += stepMs; }
    if (guard >= 5) next = now + stepMs; // drop backlog
    const wait = next - performance.now();
    if (wait > 3) timer = setTimeout(loop, wait - 2); else setImmediate(loop);
  };
  loop();

  await new Promise<void>((r) => http.listen(port, opts.host ?? '0.0.0.0', r));
  const addr = http.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  return {
    hub, port: actual,
    close: () => new Promise((resolve) => { alive = false; clearTimeout(timer); for (const c of wss.clients) c.terminate(); wss.close(() => http.close(() => resolve())); }),
  };
}
