import {
  PROTOCOL_VERSION, Predictor, botInput, buildMap, type ClientMsg, type InputFrame, type MatchEnd, type RoomInfo, type ServerMsg,
} from '@cryovanta/shared';
import { createObstacleRaceModule } from '../packages/server/src/games/obstacleRace';
import { Client } from '../packages/server/src/hub/client';
import { Hub } from '../packages/server/src/hub/hub';
import { timing } from '../packages/server/src/hub/room';

export const TICK_MS = 1000 / 60;

/** Virtual-time world: the hub is driven by a manual clock so full matches run in milliseconds. */
export class World {
  now = 1_000_000;
  seed = 4242;
  hub = new Hub([createObstacleRaceModule(() => this.seed)], { maxRooms: 100, maxClients: 1000, clock: () => this.now });
  bots: Bot[] = [];
  constructor() { timing.startCountdownMs = 1000; timing.resultsMs = 1000; timing.reconnectGraceMs = 3000; }
  connect(name = 'bot', latencyTicks = 0): Bot {
    const b = new Bot(this, name, latencyTicks); this.bots.push(b); return b;
  }
  step() {
    this.now += TICK_MS;
    for (const b of this.bots) b.preTick();
    this.hub.tick(this.now);
  }
  run(ticks: number, until?: () => boolean) { for (let i = 0; i < ticks && !(until && until()); i++) this.step(); }
}

/** In-process client: same wire format as a websocket, optional one-way latency (in ticks). */
export class Bot {
  client: Client;
  inbox: { at: number; msg: ServerMsg }[] = [];
  outbox: { at: number; text: string }[] = [];
  log: ServerMsg[] = [];
  errors: string[] = [];
  room: RoomInfo | null = null;
  slot = -1;
  token = '';
  predictor: Predictor | null = null;
  matchEnd: MatchEnd | null = null;
  maxError = 0;
  errors_: number[] = [];
  roundsSeen = 0;
  autopilot = false;
  pendingFrames: InputFrame[] = [];
  tickNo = 0;
  open = true;
  constructor(private w: World, public name: string, private lat: number) {
    this.client = new Client({ send: (d) => { const msg = JSON.parse(d) as ServerMsg; if (this.lat === 0) this.onMsg(msg); else this.inbox.push({ at: this.tickNo + this.lat, msg }); }, close: () => { this.open = false; } }, () => w.now);
    w.hub.accept(this.client);
    this.hello();
  }
  hello(token?: string) { this.send({ k: 'hello', v: PROTOCOL_VERSION, name: this.name, token }); }
  /** Send raw text (to test malformed input). */
  sendRaw(text: string) { this.w.hub.onMessage(this.client, text); }
  send(m: ClientMsg) { this.sendRaw(JSON.stringify(m)); }
  disconnect() { this.w.hub.onClose(this.client); this.open = false; }

  preTick() {
    this.tickNo++;
    // deliver messages whose latency elapsed
    const ready = this.inbox.filter((e) => e.at <= this.tickNo); this.inbox = this.inbox.filter((e) => e.at > this.tickNo);
    for (const e of ready) this.onMsg(e.msg);
    if (!this.open) return;
    if (this.autopilot && this.predictor) {
      const p = this.predictor.state;
      const f = botInput(p, this.predictor.course, this.predictor.tick + 1, 0, { useItems: true });
      const sent = this.predictor.step({ mx: f.mx, mz: f.mz, jump: f.jump, dive: f.dive, use: f.use });
      this.pendingFrames.push(sent);
      if (this.tickNo % 2 === 0) { // 30 packets/s, each carries the last 3 frames (redundancy vs loss)
        const frames = this.pendingFrames.slice(-3); this.pendingFrames = this.pendingFrames.slice(-3);
        const text = JSON.stringify({ k: 'input', frames });
        this.outbox.push({ at: this.tickNo + this.lat, text });
      }
    }
    const due = this.outbox.filter((o) => o.at <= this.tickNo); this.outbox = this.outbox.filter((o) => o.at > this.tickNo);
    for (const o of due) this.sendRaw(o.text);
  }

  private onMsg(m: ServerMsg) {
    if (m.k !== 'snap') this.log.push(m);
    switch (m.k) {
      case 'welcome': this.token = m.token; break;
      case 'room': this.room = m.room; this.slot = m.you; break;
      case 'error': this.errors.push(m.code); break;
      case 'round':
        this.roundsSeen++; this.predictor = new Predictor(buildMap(m.map, m.seed, m.difficulty), this.slot);
        this.autopilot = m.participants.includes(this.slot); break;
      case 'snap':
        if (this.predictor) { this.predictor.reconcile(m); if (this.predictor.running) { this.maxError = Math.max(this.maxError, this.predictor.lastError); this.errors_.push(this.predictor.lastError); } }
        break;
      case 'matchEnd': this.matchEnd = m; break;
      case 'left': this.room = null; break;
    }
  }
  get inRoom() { return !!this.client.room; }
}
