import { app, BrowserWindow, Menu, dialog } from 'electron';
import { join } from 'node:path';
import { networkInterfaces } from 'node:os';
import { startServer, type RunningServer } from '../../server/src/server';

let server: RunningServer | null = null;
const PORT = Number(process.env.CRYOVANTA_PORT ?? 8080);

/** In a packaged build the client lives in resources/client; in dev it is ../client/dist. */
const clientDir = () => (app.isPackaged ? join(process.resourcesPath, 'client') : join(__dirname, '../../client/dist'));

function lanUrls(port: number): string[] {
  return Object.values(networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => `http://${i!.address}:${port}`);
}

async function createWindow() {
  server = await startServer(PORT, { staticDir: clientDir() }).catch(async () => startServer(0, { staticDir: clientDir() })); // port busy -> any free port
  const win = new BrowserWindow({ width: 1280, height: 720, backgroundColor: '#070816', title: 'Cryovanta — Neon Circuit', autoHideMenuBar: true });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: 'Gioco', submenu: [
      { label: 'Schermo intero', accelerator: 'F11', click: () => win.setFullScreen(!win.isFullScreen()) },
      { label: 'Come far giocare amici in LAN', click: () => dialog.showMessageBox(win, { type: 'info', title: 'Gioco in LAN', message: 'Gli amici sulla tua rete aprono nel browser:', detail: lanUrls(server!.port).join('\n') + '\n\n(Windows potrebbe chiedere di consentire l\'accesso al firewall)' }) },
      { type: 'separator' }, { role: 'quit', label: 'Esci' },
    ] },
  ]));
  await win.loadURL(`http://127.0.0.1:${server.port}/`);
}

app.whenReady().then(createWindow);
app.on('window-all-closed', () => { void server?.close(); app.quit(); });
