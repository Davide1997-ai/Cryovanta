import { randomBytes } from 'node:crypto';
import { PROTOCOL_VERSION, defaultLook, parseClientMsg, sanitizeLook, type ClientMsg, type ErrorCode } from '@cryovanta/shared';
import { ProfileStore, validToken } from '../profiles';
import type { TelemetrySink } from '../telemetry';
import { Client } from './client';
import type { GameModule } from './game';
import { Room } from './room';

export interface HubOptions { maxRooms: number; maxClients: number; clock: () => number; profiles?: ProfileStore; telemetry?: TelemetrySink; }
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I

/** Matchmaking + room registry. Single-threaded => `quickplay` find-or-create is atomic. */
export class Hub {
  readonly rooms = new Map<string, Room>();
  readonly clients = new Set<Client>();
  private byToken = new Map<string, { room: Room; slot: number }>();
  private games = new Map<string, GameModule>();

  constructor(games: GameModule[], readonly opts: HubOptions = { maxRooms: 500, maxClients: 3500, clock: Date.now }) {
    for (const g of games) this.games.set(g.id, g);
  }

  // ------------------------------------------------------------ connection lifecycle
  accept(client: Client): boolean {
    if (this.clients.size >= this.opts.maxClients) return false;
    this.clients.add(client);
    return true;
  }

  onClose(client: Client) {
    this.clients.delete(client);
    if (client.display) { const r = client.display; r.detachDisplay(client); this.gc(r); }
    client.room?.disconnect(client);
  }

  onMessage(client: Client, text: string) {
    if (text.length > 4096) return this.err(client, 'BAD_REQUEST', 'Message too large');
    if (!client.limiter.take()) return this.err(client, 'RATE_LIMITED', 'Slow down');
    const msg = parseClientMsg(text);
    if (!msg) return this.err(client, 'BAD_REQUEST', 'Malformed message');
    this.dispatch(client, msg);
  }

  private dispatch(c: Client, m: ClientMsg) {
    if (m.k === 'hello') return this.hello(c, m);
    if (!c.greeted) return this.err(c, 'BAD_REQUEST', 'Say hello first');
    if (c.display && (m.k === 'input' || m.k === 'ready' || m.k === 'quickplay' || m.k === 'create' || m.k === 'join')) return this.err(c, 'BAD_REQUEST', 'A screen cannot play');
    switch (m.k) {
      case 'ping': return c.send({ k: 'pong', t: m.t, serverTime: this.opts.clock() });
      case 'input': return c.room?.handleInput(c, m.frames);
      case 'ready': return c.room ? c.room.setReady(c, m.ready) : this.err(c, 'NOT_IN_ROOM', 'Not in a room');
      case 'leave': if (c.room) { const r = c.room; this.byToken.delete(c.token); r.leave(c); this.gc(r); c.send({ k: 'left' }); } return;
      case 'look': { c.look = sanitizeLook({ c: m.c, h: m.h }, c.level, c.look ?? defaultLook(Math.max(0, c.slot))); c.room?.updateLook(c); return; }
      case 'emote': return c.room?.handleEmote(c, m.id);
      case 'screen': return this.screen(c, m.game, m.code);
      case 'start': { const r = c.display; if (!r) return this.err(c, 'NOT_HOST', 'Only a screen can force the start'); if (!r.forceStart()) this.err(c, 'BAD_REQUEST', 'Servono almeno 2 giocatori'); return; }
      case 'config': { const rm = c.room ?? c.display; if (!rm) return this.err(c, 'NOT_IN_ROOM', 'Not in a room'); const e = rm.setConfig(c, m.map, m.mode); if (e) this.err(c, e, e === 'NOT_HOST' ? 'Solo l\'host può cambiare le regole' : 'Opzione non valida'); return; }
      case 'quickplay': return this.quickplay(c, m.game);
      case 'create': return this.create(c, m.game, m.isPrivate);
      case 'join': return this.joinByCode(c, m.code);
    }
  }

  private hello(c: Client, m: Extract<ClientMsg, { k: 'hello' }>) {
    if (m.v !== PROTOCOL_VERSION) return this.err(c, 'BAD_VERSION', `Server speaks protocol v${PROTOCOL_VERSION}`);
    c.name = m.name;
    const prior = m.token ? this.byToken.get(m.token) : undefined;
    // A well-formed token is the player's persistent identity (profile/XP); anything else gets a fresh random one.
    c.token = validToken(m.token) ? m.token : randomBytes(16).toString('hex');
    c.greeted = true;
    const profile = this.opts.profiles?.get(c.token) ?? { xp: 0, level: 1, prevXp: 0, nextXp: 60, matches: 0, wins: 0 };
    c.level = profile.level; c.look = m.look ? sanitizeLook(m.look, c.level, defaultLook(0)) : null;
    c.send({ k: 'welcome', v: PROTOCOL_VERSION, token: c.token, serverTime: this.opts.clock(), profile });
    if (prior) {
      const slot = prior.room.findReserved(c.token);
      if (slot >= 0 && prior.room.resume(c, slot)) { prior.room.sendCurrent(c); prior.room.broadcastRoom(); return; }
      this.byToken.delete(c.token);
    }
  }

  // ------------------------------------------------------------ matchmaking
  private quickplay(c: Client, gameId: string) {
    const game = this.games.get(gameId); if (!game) return this.err(c, 'UNKNOWN_GAME', gameId);
    if (c.room) return this.err(c, 'BAD_REQUEST', 'Already in a room');
    // fill the fullest joinable public room first so lobbies reach quorum quickly
    let best: Room | null = null;
    for (const r of this.rooms.values()) {
      if (r.game.id !== gameId || r.isPrivate || !r.joinable) continue;
      if (!best || (r.displayCount > 0) > (best.displayCount > 0) || ((r.displayCount > 0) === (best.displayCount > 0) && r.size > best.size)) best = r;
    }
    this.enter(c, best ?? this.newRoom(game, false));
  }
  private create(c: Client, gameId: string, isPrivate: boolean) {
    const game = this.games.get(gameId); if (!game) return this.err(c, 'UNKNOWN_GAME', gameId);
    if (c.room) return this.err(c, 'BAD_REQUEST', 'Already in a room');
    this.enter(c, this.newRoom(game, isPrivate));
  }
  private joinByCode(c: Client, code: string) {
    if (c.room) return this.err(c, 'BAD_REQUEST', 'Already in a room');
    const r = this.rooms.get(code);
    if (!r) return this.err(c, 'ROOM_NOT_FOUND', 'No such room');
    this.enter(c, r);
  }
  private screen(c: Client, gameId: string, code?: string) {
    const game = this.games.get(gameId); if (!game) return this.err(c, 'UNKNOWN_GAME', gameId);
    if (c.room || c.display) return this.err(c, 'BAD_REQUEST', 'Already attached');
    let room: Room | undefined;
    if (code) { room = this.rooms.get(code); if (!room) return this.err(c, 'ROOM_NOT_FOUND', 'No such room'); }
    else room = this.newRoom(game, false); // public: phones that "quick play" land in the screen's room
    const res = room.attachDisplay(c);
    if (!res.ok) this.err(c, res.code, res.msg);
  }
  private enter(c: Client, room: Room) {
    const res = room.tryJoin(c);
    if (!res.ok) { this.gc(room); return this.err(c, res.code, res.msg); }
    this.byToken.set(c.token, { room, slot: res.slot });
  }
  private newRoom(game: GameModule, isPrivate: boolean): Room {
    if (this.rooms.size >= this.opts.maxRooms) throw new Error('room limit');
    let code: string;
    do { code = Array.from(randomBytes(5), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (this.rooms.has(code));
    const room = new Room(code, game, isPrivate, this.opts.clock, this.opts.profiles ?? null, this.opts.telemetry ?? null);
    room.onEmpty = (r) => this.gc(r);
    this.rooms.set(code, room);
    return room;
  }
  private gc(room: Room) {
    if (room.size === 0 && room.displayCount === 0) { this.rooms.delete(room.code); for (const [t, v] of this.byToken) if (v.room === room) this.byToken.delete(t); }
  }

  /** Called by the global loop. */
  tick(now = this.opts.clock()) { for (const r of [...this.rooms.values()]) r.tick(now); }

  private err(c: Client, code: ErrorCode, msg: string) { c.send({ k: 'error', code, msg }); }
}
