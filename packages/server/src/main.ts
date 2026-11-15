import { existsSync } from 'node:fs';
import { networkInterfaces } from 'node:os';
import { resolve } from 'node:path';
import { startServer } from './server';

const port = Number(process.env.PORT ?? 8080);
// If the client has been built, serve it too: phones/PCs on the LAN just open http://<this-pc>:<port>
const dist = resolve(process.env.CLIENT_DIST ?? 'packages/client/dist');
const staticDir = existsSync(resolve(dist, 'index.html')) ? dist : undefined;

startServer(port, { staticDir }).then((s) => {
  console.log(`[cryovanta] hub listening on port ${s.port}  (healthz: http://localhost:${s.port}/healthz)`);
  if (!staticDir) { console.log('[cryovanta] client not built: run "npm run build" to also serve the game over HTTP (needed for phones)'); return; }
  console.log(`\n  Su questo PC:   http://localhost:${s.port}`);
  const ips = Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
  for (const i of ips) console.log(`  Su smartphone:  http://${i!.address}:${s.port}   (stessa Wi-Fi del PC)`);
  console.log('');
});
