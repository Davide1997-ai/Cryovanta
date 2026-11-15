#!/usr/bin/env node
/**
 * One-command launcher: checks Node, installs dependencies if needed, (re)builds the client if sources changed,
 * picks a free port, starts the game server, opens the browser and prints the phone URL + QR code.
 *
 *   node scripts/launch.mjs [--port=8080] [--no-open] [--no-qr] [--rebuild]
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createServer, get } from 'node:http';
import { networkInterfaces } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
process.chdir(root);
const args = process.argv.slice(2);
const flag = (n) => args.includes('--' + n);
const opt = (n, d) => (args.find((a) => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? d;
const isWin = process.platform === 'win32';
const c = { b: (s) => `\x1b[1m${s}\x1b[0m`, g: (s) => `\x1b[32m${s}\x1b[0m`, y: (s) => `\x1b[33m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, c: (s) => `\x1b[36m${s}\x1b[0m` };
const step = (s) => console.log(c.c('▶ ') + s);
const die = (s) => { console.error(c.r('✖ ' + s)); process.exit(1); };

// ---- 1. Node version ---------------------------------------------------------------------------------------------
const major = Number(process.versions.node.split('.')[0]);
if (major < 20) die(`Serve Node.js 20 o superiore (hai ${process.versions.node}). Scaricalo da https://nodejs.org (versione LTS).`);

const npm = isWin ? 'npm.cmd' : 'npm';
const run = (cmd, a, o = {}) => spawnSync(cmd, a, { stdio: 'inherit', cwd: root, shell: isWin, ...o });

// ---- 2. dependencies ---------------------------------------------------------------------------------------------
const mtime = (p) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
const lockStamp = mtime(join(root, 'node_modules', '.package-lock.json'));
if (!existsSync(join(root, 'node_modules', 'tsx')) || mtime(join(root, 'package-lock.json')) > lockStamp + 1000) {
  step('Installo le dipendenze (solo la prima volta, serve internet)…');
  const r = run(npm, ['install', '--no-audit', '--no-fund']);
  if (r.status !== 0) die('npm install non è riuscito. Controlla la connessione e riprova.');
}

// ---- 3. client build (only when sources are newer than the last build) ---------------------------------------------
const newest = (dir) => { let m = 0; for (const e of readdirSync(dir, { withFileTypes: true })) { if (e.name === 'node_modules' || e.name === 'dist') continue; const p = join(dir, e.name); m = Math.max(m, e.isDirectory() ? newest(p) : mtime(p)); } return m; };
const distIndex = join(root, 'packages/client/dist/index.html');
const srcStamp = Math.max(newest(join(root, 'packages/client')), newest(join(root, 'packages/shared/src')));
if (flag('rebuild') || !existsSync(distIndex) || srcStamp > mtime(distIndex)) {
  step('Compilo il client…');
  const r = run(npm, ['run', 'build']);
  if (r.status !== 0) die('La compilazione del client è fallita.');
}

// ---- 4. free port ------------------------------------------------------------------------------------------------
const free = (p) => new Promise((res) => { const s = createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(p, '0.0.0.0'); });
let port = Number(opt('port', process.env.PORT ?? 8080));
for (let i = 0; i < 40 && !((await free(port)) && (await free(port + 1))); i++) port++; // HTTP on `port`, HTTPS (phones' motion sensors) on port+1

// ---- 5. start the server ------------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
let tsxCli;
try { tsxCli = require.resolve('tsx/cli'); } catch { die('tsx non trovato: esegui "npm install".'); }
step(`Avvio il server sulla porta ${port}…`);
const server = spawn(process.execPath, [tsxCli, 'packages/server/src/main.ts'], { cwd: root, stdio: 'inherit', env: { ...process.env, PORT: String(port) } });
server.on('exit', (code) => { console.log(c.y(`\nServer terminato (codice ${code ?? 0}).`)); process.exit(code ?? 0); });
const stop = () => { try { server.kill(); } catch {} process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

const healthy = () => new Promise((res) => { get({ host: '127.0.0.1', port, path: '/healthz', timeout: 800 }, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)); });
for (let i = 0; i < 60 && !(await healthy()); i++) await new Promise((r) => setTimeout(r, 250));
if (!(await healthy())) die('Il server non risponde.');

// ---- 6. open browser + phone URL ----------------------------------------------------------------------------------
const info = await new Promise((res) => get({ host: '127.0.0.1', port, path: '/info', timeout: 1500 }, (r) => { let d = ''; r.on('data', (x) => (d += x)); r.on('end', () => { try { res(JSON.parse(d)); } catch { res(null); } }); }).on('error', () => res(null)));
const screenUrl = `http://localhost:${port}/?screen`;
const ips = info?.ips ?? [];
const httpsPort = info?.httpsPort ?? null;
const padFor = (ip) => (httpsPort ? `https://${ip}:${httpsPort}/pad.html` : `http://${ip}:${port}/pad.html`);
const phone = ips[0] ? padFor(ips[0]) : null;

console.log('\n' + c.g('✔ Gioco pronto!'));
console.log(`  ${c.b('Schermo (PC):')}     ${screenUrl}   ← si apre da solo`);
for (const ip of ips) console.log(`  ${c.b('Joypad telefono:')}  ${padFor(ip)}${ip === ips[0] ? '   ← inquadra il QR / apri questo' : ''}`);
if (httpsPort) console.log(c.y('  Sul telefono il browser avvisa "connessione non privata" (certificato locale): scegli Avanzate → Prosegui. Serve per usare l\'inclinazione.'));
else console.log(c.y('  HTTPS non disponibile: i telefoni useranno il joystick a schermo invece dell\'inclinazione.'));
console.log(c.y('  Se Windows chiede il firewall, consenti Node sulle reti private.'));
console.log('  Premi Ctrl+C per chiudere.\n');

if (!flag('no-qr') && phone) {
  try { const qr = (await import('qrcode-terminal')).default; console.log('  Inquadra col telefono (joypad):'); qr.generate(phone, { small: true }, (q) => console.log(q.split('\n').map((l) => '    ' + l).join('\n'))); }
  catch { /* optional dependency */ }
}
if (!flag('no-open')) {
  const [cmd, a] = isWin ? ['cmd', ['/c', 'start', '""', screenUrl]] : process.platform === 'darwin' ? ['open', [screenUrl]] : ['xdg-open', [screenUrl]];
  try { spawn(cmd, a, { stdio: 'ignore', detached: true }).on('error', () => {}).unref(); } catch { /* user can open it manually */ }
}
