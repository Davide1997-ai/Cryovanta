import { startServer } from './server';
const port = Number(process.env.PORT ?? 8080);
startServer(port).then((s) => console.log(`[cryovanta] hub listening on ws://localhost:${s.port}  (healthz: http://localhost:${s.port}/healthz)`));
