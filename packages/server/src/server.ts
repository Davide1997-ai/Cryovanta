import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createServer as createHttpsServer, type Server as HttpsServer } from 'node:https';
import type { Duplex } from 'node:stream';
import { networkInterfaces } from 'node:os';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer } from 'ws';
import { TICK_RATE } from '@cryovanta/shared';
import { obstacleRaceModule } from './games/obstacleRace';
import { Client, wsTransport } from './hub/client';
import { Hub } from './hub/hub';
import { ensureCert } from './certs';

export interface RunningServer { hub: Hub; port: number; httpsPort: number | null; close(): Promise<void>; }

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json' };

export function lanAddresses(): string[] {
  const pref = (a: string) => (/^192\.168\./.test(a) ? 0 : /^10\./.test(a) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(a) ? 2 : 3);
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i!.address).sort((a, b) => pref(a) - pref(b));
}

/**
 * staticDir: optional built client (dist) to serve — used by the desktop app and LAN play.
 * httpsPort: also serve HTTPS (self-signed). Needed because phones only expose motion sensors on secure origins.
 */
export async function startServer(port = 8080, opts: { staticDir?: string; host?: string; httpsPort?: number | null } = {}): Promise<RunningServer> {
  const hub = new Hub([obstacleRaceModule]);
  let httpsActual: number | null = null;
  const handler = (req: IncomingMessage, res: ServerResponse) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: hub.rooms.size, clients: hub.clients.size })); }
    else if (url === '/info') { res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' }); res.end(JSON.stringify({ ips: lanAddresses(), port: http.address() && typeof http.address() === 'object' ? (http.address() as { port: number }).port : port, httpsPort: httpsActual })); }
    else if (opts.staticDir) {
      const rel = normalize(decodeURIComponent(url)).replace(/^([/\\])+/, '');
      let file = join(opts.staticDir, rel === '' ? 'index.html' : rel);
      if (!file.startsWith(opts.staticDir) || !existsSync(file) || statSync(file).isDirectory()) file = join(opts.staticDir, 'index.html');
      res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': extname(file) === '.html' ? 'no-cache' : 'public, max-age=3600' }); res.end(readFileSync(file));
    } else { res.writeHead(404); res.end(); }
  };
  const http: Server = createServer(handler);
  const servers: (Server | HttpsServer)[] = [http];

  // One WebSocket server shared by HTTP (ws://) and HTTPS (wss://) listeners.
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    const client = new Client(wsTransport(ws));
    if (!hub.accept(client)) { ws.close(1013, 'server busy'); return; }
    ws.on('message', (data, isBinary) => { if (!isBinary) hub.onMessage(client, data.toString()); });
    ws.on('close', () => hub.onClose(client));
    ws.on('error', () => ws.terminate());
  });
  const upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  http.on('upgrade', upgrade);

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
  if (opts.httpsPort !== undefined && opts.httpsPort !== null) {
    try {
      const https = createHttpsServer(ensureCert(lanAddresses()), handler); https.on('upgrade', upgrade); servers.push(https);
      await new Promise<void>((resolve, reject) => { https.once('error', reject); https.listen(opts.httpsPort!, opts.host ?? '0.0.0.0', () => resolve()); });
      const a2 = https.address(); httpsActual = typeof a2 === 'object' && a2 ? a2.port : opts.httpsPort;
    } catch (e) { console.warn('[cryovanta] HTTPS non disponibile (' + (e as Error).message + '): niente sensori di movimento sui telefoni, solo joystick.'); }
  }
  return {
    hub, port: actual, httpsPort: httpsActual,
    close: () => new Promise((resolve) => { alive = false; clearTimeout(timer); for (const c of wss.clients) c.terminate(); wss.close(); let n = servers.length; for (const s of servers) s.close(() => { if (--n === 0) resolve(); }); (servers as any[]).forEach((s) => s.closeAllConnections?.()); }),
  };
}
