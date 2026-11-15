import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { lanAddresses, startServer } from './server';

const port = Number(process.env.PORT ?? 8080);
// If the client has been built, serve it too: phones/PCs on the LAN just open http://<this-pc>:<port>
const dist = resolve(process.env.CLIENT_DIST ?? 'packages/client/dist');
const staticDir = existsSync(resolve(dist, 'index.html')) ? dist : undefined;

const httpsPort = process.env.HTTPS_PORT === '0' ? null : Number(process.env.HTTPS_PORT ?? port + 1);
startServer(port, { staticDir, httpsPort }).then((s) => {
  console.log(`[cryovanta] hub listening on http://localhost:${s.port}${s.httpsPort ? `  and https://localhost:${s.httpsPort}` : ''}  (healthz: /healthz)`);
  if (!staticDir) { console.log('[cryovanta] client not built: run "npm run build" to also serve the game over HTTP (needed for phones)'); return; }
  console.log(`\n  Schermo (PC):    http://localhost:${s.port}/?screen`);
  for (const ip of lanAddresses()) console.log(`  Joypad telefono: http://${ip}:${s.port}/pad.html   (stessa Wi-Fi)`);
  console.log('');
});
