import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@cryovanta/shared';

export class Net {
  ws!: WebSocket;
  rtt = 0;
  /** serverTime - localTime, smoothed (ms) */
  offset = 0;
  token = sessionStorage.getItem('cv-token') ?? '';
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};
  private pingTimer = 0;

  connect(url: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const ws = (this.ws = new WebSocket(url));
      ws.onopen = () => {
        this.send({ k: 'hello', v: PROTOCOL_VERSION, name, token: this.token || undefined });
        clearInterval(this.pingTimer); this.pingTimer = window.setInterval(() => this.send({ k: 'ping', t: performance.now() }), 2000);
        resolve();
      };
      ws.onerror = () => reject(new Error('connection failed'));
      ws.onclose = () => { if (this.ws === ws) { clearInterval(this.pingTimer); this.onClose(); } };
      ws.onmessage = (e) => {
        if (this.ws !== ws) return;
        const m = JSON.parse(e.data as string) as ServerMsg;
        if (m.k === 'welcome') { this.token = m.token; sessionStorage.setItem('cv-token', m.token); this.offset = m.serverTime - Date.now(); }
        if (m.k === 'pong') { this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.t) * 0.2 : performance.now() - m.t; }
        this.onMsg(m);
      };
    });
  }
  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
}
