import type { WebSocket } from 'ws';
import type { ServerMsg } from '@cryovanta/shared';
import type { Room } from './room';

/** Token bucket: refuses floods without needing a global timer. */
export class RateLimiter {
  private tokens: number; private last: number;
  constructor(private ratePerSec: number, private burst: number, private clock: () => number = Date.now) { this.tokens = burst; this.last = clock(); }
  take(now = this.clock()): boolean {
    this.tokens = Math.min(this.burst, this.tokens + ((now - this.last) / 1000) * this.ratePerSec);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1; return true;
  }
}

/** Transport-agnostic send target (ws in prod, in-memory in tests). */
export interface Transport { send(data: string): void; close(): void; bufferedAmount?: number; }
export const wsTransport = (ws: WebSocket): Transport => ({
  send: (d) => ws.readyState === ws.OPEN && ws.send(d),
  close: () => ws.close(),
  get bufferedAmount() { return ws.bufferedAmount; },
});

export class Client {
  name = 'Player';
  /** Stable identity across reconnects. Secret: only ever sent to this client. */
  token = '';
  room: Room | null = null;
  slot = -1;
  greeted = false;
  readonly limiter: RateLimiter;
  constructor(readonly transport: Transport, clock: () => number = Date.now) { this.limiter = new RateLimiter(120, 240, clock); }
  send(msg: ServerMsg, droppable = false) { this.sendRaw(JSON.stringify(msg), droppable); }
  sendRaw(json: string, droppable = false) {
    // backpressure: never let a slow client balloon server memory; snapshots are replaceable
    if (droppable && (this.transport.bufferedAmount ?? 0) > 256 * 1024) return;
    this.transport.send(json);
  }
}
