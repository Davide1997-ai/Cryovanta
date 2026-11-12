import { PROTOCOL_VERSION, type ClientMsg, type ServerMsg } from '@cryovanta/shared';

export class Net {
  ws!: WebSocket;
  rtt = 0;
  /** serverTime - localTime, smoothed (ms) */
  offset = 0;
  token = sessionStorage.getItem('cv-token') ?? '';
  onMsg: (m: ServerMsg) => void = () => {};
  onClose: () => void = () => {};

  connect(url: string, name: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      this.ws.onopen = () => {
        this.send({ k: 'hello', v: PROTOCOL_VERSION, name, token: this.token || undefined });
        setInterval(() => this.send({ k: 'ping', t: performance.now() }), 2000);
        resolve();
      };
      this.ws.onerror = () => reject(new Error('connection failed'));
      this.ws.onclose = () => this.onClose();
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data as string) as ServerMsg;
        if (m.k === 'welcome') { this.token = m.token; sessionStorage.setItem('cv-token', m.token); this.offset = m.serverTime - Date.now(); }
        if (m.k === 'pong') { this.rtt = this.rtt ? this.rtt * 0.8 + (performance.now() - m.t) * 0.2 : performance.now() - m.t; }
        this.onMsg(m);
      };
    });
  }
  send(m: ClientMsg) { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m)); }
}
