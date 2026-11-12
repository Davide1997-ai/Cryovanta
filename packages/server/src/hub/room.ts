import {
  MAX_PLAYERS_PER_ROOM, type ErrorCode, type InputFrame, type LobbyMember, type RoomInfo, type RoomPhase, type ServerMsg,
} from '@cryovanta/shared';
import type { Client } from './client';
import type { GameHost, GameModule, GameSession } from './game';
import { assertValidModule } from './game';

/** Mutable so tests can shorten them. */
export const timing = { startCountdownMs: 5000, resultsMs: 8000, reconnectGraceMs: 20000 };

interface Member {
  slot: number; name: string; token: string; ready: boolean;
  client: Client | null;          // null => disconnected, slot reserved until `reservedUntil`
  reservedUntil: number;
}

export type JoinResult = { ok: true; slot: number } | { ok: false; code: ErrorCode; msg: string };

/**
 * One game instance. HARD CAP: `slots` has exactly MAX_PLAYERS_PER_ROOM entries and every join goes through
 * `tryJoin`, so a room can never hold more than 7 clients — spectators included (there are none) and
 * disconnected-but-reserved players included (their slot stays occupied until the grace period ends).
 */
export class Room {
  phase: RoomPhase = 'lobby';
  private slots: (Member | null)[] = new Array(MAX_PLAYERS_PER_ROOM).fill(null);
  private session: GameSession | null = null;
  private countdownEnds = 0;
  private resultsEnds = 0;
  private lastInfoBroadcast = 0;
  onEmpty?: (room: Room) => void;

  constructor(readonly code: string, readonly game: GameModule, readonly isPrivate: boolean, private clock: () => number = Date.now) { assertValidModule(game); }

  // ------------------------------------------------------------ membership
  get size() { return this.slots.reduce((n, m) => n + (m ? 1 : 0), 0); }
  get capacity() { return Math.min(this.game.maxPlayers, MAX_PLAYERS_PER_ROOM); }
  get joinable() { return (this.phase === 'lobby' || this.phase === 'countdown') && this.size < this.capacity; }

  tryJoin(client: Client): JoinResult {
    if (this.phase === 'playing' || this.phase === 'results') return { ok: false, code: 'ROOM_IN_PROGRESS', msg: 'Match already running' };
    const slot = this.slots.findIndex((m, i) => m === null && i < this.capacity);
    if (this.size >= this.capacity || slot < 0) return { ok: false, code: 'ROOM_FULL', msg: `Room is full (${this.capacity}/${this.capacity})` };
    this.slots[slot] = { slot, name: client.name, token: client.token, ready: false, client, reservedUntil: 0 };
    client.room = this; client.slot = slot;
    if (this.size > this.capacity) throw new Error('invariant violated: room over capacity');
    this.cancelCountdown();
    this.broadcastRoom();
    return { ok: true, slot };
  }

  /** Voluntary leave or hard drop in lobby: frees the slot immediately. */
  leave(client: Client) {
    const m = this.slots[client.slot];
    if (!m || m.client !== client) return;
    this.slots[client.slot] = null;
    client.room = null; client.slot = -1;
    this.session?.removePlayer(m.slot);
    this.afterMembershipChange();
  }

  /** Socket dropped. In a running match the slot is held for timing.reconnectGraceMs so the player can resume. */
  disconnect(client: Client, now = this.clock()) {
    const m = this.slots[client.slot];
    if (!m || m.client !== client) return;
    if (this.phase === 'playing') { m.client = null; m.reservedUntil = now + timing.reconnectGraceMs; this.broadcastRoom(); }
    else this.leave(client);
    client.room = null;
  }

  /** Rebind a returning player (same token) to their reserved slot. */
  resume(client: Client, slot: number): boolean {
    const m = this.slots[slot];
    if (!m || m.token !== client.token || m.client) return false;
    m.client = client; m.reservedUntil = 0; m.name = client.name;
    client.room = this; client.slot = slot;
    return true;
  }
  findReserved(token: string): number { return this.slots.findIndex((m) => m && !m.client && m.token === token); }

  private afterMembershipChange() {
    if (this.size === 0) { this.onEmpty?.(this); return; }
    if (!this.slots.some((m) => m?.client) && this.phase !== 'playing') { this.onEmpty?.(this); return; }
    this.cancelCountdown(); this.evaluateStart(); this.broadcastRoom();
  }

  // ------------------------------------------------------------ lobby flow
  setReady(client: Client, ready: boolean) {
    const m = this.slots[client.slot];
    if (!m || m.client !== client || this.phase === 'playing' || this.phase === 'results') return;
    m.ready = ready;
    this.cancelCountdown(); this.evaluateStart(); this.broadcastRoom();
  }

  private connected() { return this.slots.filter((m): m is Member => !!m && !!m.client); }

  private evaluateStart(now = this.clock()) {
    if (this.phase !== 'lobby') return;
    const ms = this.connected();
    if (ms.length >= this.game.minPlayers && ms.every((m) => m.ready)) { this.phase = 'countdown'; this.countdownEnds = now + timing.startCountdownMs; }
  }
  private cancelCountdown() { if (this.phase === 'countdown') { this.phase = 'lobby'; this.countdownEnds = 0; } }

  private startMatch() {
    const slots = this.connected().map((m) => m.slot);
    const host: GameHost = {
      send: (slot, msg) => this.slots[slot]?.client?.send(msg, msg.k === 'snap'),
      broadcast: (msg) => this.broadcast(msg),
    };
    this.session = this.game.createSession(host);
    this.phase = 'playing';
    this.broadcastRoom();
    this.session.start(slots);
  }

  // ------------------------------------------------------------ in-game
  handleInput(client: Client, frames: InputFrame[]) {
    if (this.phase !== 'playing' || !this.session) return;
    const m = this.slots[client.slot];
    if (m && m.client === client) this.session.handleInput(client.slot, frames);
  }

  /** Driven by the global fixed-step loop. */
  tick(now: number) {
    if (this.phase === 'countdown') {
      if (now >= this.countdownEnds) this.startMatch();
      else if (now - this.lastInfoBroadcast >= 1000) this.broadcastRoom(now);
    } else if (this.phase === 'playing' && this.session) {
      for (const m of this.slots) if (m && !m.client && now >= m.reservedUntil) { this.slots[m.slot] = null; this.session.removePlayer(m.slot); }
      this.session.tick();
      if (this.session.finished) { this.phase = 'results'; this.resultsEnds = now + timing.resultsMs; this.broadcastRoom(now); }
      else if (this.size === 0 || !this.slots.some((m) => m?.client)) { /* everyone gone: keep running until grace expires */ }
      if (this.size === 0) this.onEmpty?.(this);
    } else if (this.phase === 'results' && now >= this.resultsEnds) {
      this.session = null; this.phase = 'lobby';
      for (const m of this.slots) if (m) m.ready = false;
      for (const m of this.slots) if (m && !m.client) this.slots[m.slot] = null;
      if (this.size === 0) this.onEmpty?.(this); else this.broadcastRoom(now);
    }
  }

  // ------------------------------------------------------------ messaging
  info(): RoomInfo {
    const host = this.slots.findIndex((m) => m !== null);
    const members: LobbyMember[] = [];
    for (const m of this.slots) if (m) members.push({ slot: m.slot, name: m.name, ready: m.ready, host: m.slot === host, connected: !!m.client });
    return {
      code: this.code, game: this.game.id, phase: this.phase, isPrivate: this.isPrivate, capacity: this.capacity, members,
      countdown: this.phase === 'countdown' ? Math.max(0, Math.ceil((this.countdownEnds - this.clock()) / 1000)) : 0,
    };
  }
  broadcastRoom(now = this.clock()) {
    this.lastInfoBroadcast = now;
    const info = this.info();
    for (const m of this.slots) m?.client?.send({ k: 'room', room: info, you: m.slot });
  }
  broadcast(msg: ServerMsg) {
    const json = JSON.stringify(msg); // serialise once for all recipients
    const droppable = msg.k === 'snap';
    for (const m of this.slots) m?.client?.sendRaw(json, droppable);
  }
  sendCurrent(client: Client) { client.send({ k: 'room', room: this.info(), you: client.slot }); }
}
