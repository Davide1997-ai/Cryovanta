import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@cryovanta/shared';

export class Net {
  ws!: WebSocket;
  rtt = 0;
  /** serverTime - localTime, smoothed (ms) */
  offset = 0;
  token = (() => { try { return localStorage.getItem('cv-token') ?? ''; } catch { return ''; } })(); // persistent identity => XP/level survive closing the browser
  profile: import('@cryovanta/shared').Profile | null = null;
  look: { c: number; h: number } | null = null;
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  private pingTimer = 0;

  connect(url: string, name: string, look?: { c: number; h: number }): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(url));
      ws.onopen = () => {
        this.look = look ?? this.look; this.send({ k: 'hello', v: PROTOCOL_VERSION, name, token: this.token || undefined, look: this.look ?? undefined });
        clearInterval(this.pingTimer); this.pingTimer = window.setInterval(() => this.send({ k: 'ping', t: performance.now() }), 2000);
        resolve();
      };
      ws.onerror = () => reject(new Error('connection failed'));
      ws.onclose = () => { if (this.ws === ws) { clearInterval(this.pingTimer); this.onClose(); } };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        const m = JSON.parse(e.data as string) as ServerMsg;
        if (m.k === 'welcome') { this.token = m.token; this.profile = m.profile; try { localStorage.setItem('cv-token', m.token); } catch { /* private mode */ } this.offset = m.serverTime - Date.now(); }
        if (m.k === 'profile') this.profile = m.profile;
        if (m.k === 'pong') { this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.t) * 0.2 : performance.now() - m.t; }
        this.onMsg(m);
      };
    });
  }
  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
}
