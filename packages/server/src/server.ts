import { createServer, type Server } from 'node:http';
import { WebSocketServer } from 'ws';
import { TICK_RATE } from '@cryovanta/shared';
import { obstacleRaceModule } from './games/obstacleRace';
import { Client, wsTransport } from './hub/client';
import { Hub } from './hub/hub';

export interface RunningServer { hub: Hub; port: number; close(): Promise<void>; }

export async function startServer(port = 8080): Promise<RunningServer> {
  const hub = new Hub([obstacleRaceModule]);
  const http: Server = createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, rooms: hub.rooms.size, clients: hub.clients.size })); }
    else { res.writeHead(404); res.end(); }
  });
  const wss = new WebSocketServer({ server: http, maxPayload: 4096, perMessageDeflate: false });
  wss.on('connection', (ws) => {
    const client = new Client(wsTransport(ws));
    if (!hub.accept(client)) { ws.close(1013, 'server busy'); return; }
    ws.on('message', (data, isBinary) => { if (!isBinary) hub.onMessage(client, data.toString()); });
    ws.on('close', () => hub.onClose(client));
    ws.on('error', () => ws.terminate());
  });

  // Fixed-timestep loop with catch-up (bounded) so slow ticks don't spiral.
  const stepMs = 1000 / TICK_RATE;
  let next = performance.now();
  let timer: NodeJS.Timeout;
  const loop = () => {
    const now = performance.now();
    let guard = 0;
    while (now >= next && guard++ < 5) { hub.tick(Date.now()); next += stepMs; }
    if (guard >= 5) next = now + stepMs; // drop backlog
    timer = setTimeout(loop, Math.max(0, next - performance.now()));
  };
  loop();

  await new Promise<void>((r) => http.listen(port, r));
  const addr = http.address();
  const actual = typeof addr === 'object' && addr ? addr.port : port;
  return {
    hub, port: actual,
    close: () => new Promise((resolve) => { clearTimeout(timer); for (const c of wss.clients) c.terminate(); wss.close(() => http.close(() => resolve())); }),
  };
}
