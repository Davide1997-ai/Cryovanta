/**
 * Wire protocol (JSON over WebSocket; see docs/ARCHITECTURE.md for the binary upgrade path).
 * Everything inbound is untrusted: use the validators, never cast.
 */
import type { SimEvent, RacePhase } from './sim';
import type { MatchPhase } from './match';
import type { InputFrame } from './types';
import type { ItemKind } from './items';
import { MAX_INPUTS_PER_PACKET } from './constants';
import type { Look, Profile } from './cosmetics';

export const PROTOCOL_VERSION = 1;

// ---------- room / lobby ----------
export type RoomPhase = 'lobby' | 'countdown' | 'playing' | 'results';
export interface LobbyMember { slot: number; name: string; ready: boolean; host: boolean; connected: boolean; look: Look; level: number; }
export interface RoomInfo {
  code: string; game: string; phase: RoomPhase; isPrivate: boolean;
  capacity: number; members: LobbyMember[]; countdown: number; // seconds, 0 if none
  /** host-selectable options (map id or 'random', mode id) */
  options: { map: string; mode: string };
  /** number of attached big screens (not counted in `members`/capacity) */
  displays: number;
}
export type ErrorCode = 'ROOM_FULL' | 'ROOM_NOT_FOUND' | 'ROOM_IN_PROGRESS' | 'BAD_REQUEST' | 'NOT_IN_ROOM' | 'RATE_LIMITED' | 'BAD_VERSION' | 'UNKNOWN_GAME' | 'NOT_HOST';

// ---------- client -> server ----------
export type ClientMsg =
  | { k: 'hello'; v: number; name: string; token?: string; look?: Look }
  | { k: 'look'; c: number; h: number }
  | { k: 'emote'; id: number }
  | { k: 'quickplay'; game: string }
  | { k: 'create'; game: string; isPrivate: boolean }
  | { k: 'join'; code: string }
  | { k: 'ready'; ready: boolean }
  | { k: 'config'; map: string; mode: string }
  /** Big-screen client: watches a room (creates one if no code). NOT a player: does not use one of the 7 slots. */
  | { k: 'screen'; game: string; code?: string }
  | { k: 'start' }
  | { k: 'leave' }
  | { k: 'input'; frames: InputFrame[] }
  | { k: 'ping'; t: number };

// ---------- server -> client ----------
export interface SnapPlayer {
  s: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; yaw: number;
  g: 0 | 1; hv: 0 | 1; dv: number; // dv = remaining dive seconds
  /** controller-internal state, required to re-simulate unacked inputs exactly (client reconciliation) */
  cy: number; jb: number; jh: 0 | 1; hf: number; dc: number; dh: 0 | 1; pf: number;
  st: number; bo: number; sh: number; iv: number; rs: number;
  it: ItemKind | null; cp: number; fr: number; al: 0 | 1;
  /** dirty play: shove cooldown / shoving anim, grab time left, held (slow) time, grab target slot */
  pc: number; ph: number; gb: number; sl: number; gt: number;
  /** team (-1 none) and crown carrier flag */
  tm: number; cr: 0 | 1;
}
export interface Snapshot {
  k: 'snap'; tick: number;
  /** last input seq the server consumed for each slot (used by the owning client for reconciliation) */
  ack: number[];
  mp: MatchPhase; rp: RacePhase; round: number; left: number; // seconds left in round / intermission
  players: SnapPlayer[];
  bx: number[]; // item-box ids currently on cooldown
  sk: { id: number; x: number; y: number; z: number; o: number; t: number }[];
  hz: { id: number; x: number; y: number; z: number; o: number; a: 0 | 1 }[];
  ev: SimEvent[];
  /** qualification counter: how many already crossed the line / quota (elimination: how many pass) */
  qf: number; qq: number;
  /** finish line z (so a phone can show progress without knowing the map) and survival flag */
  fz: number; sv: 0 | 1;
  /** crown round: [x, y, z, holderSlot] and cumulative hold seconds per slot */
  cw: [number, number, number, number] | null; cs: number[];
  /** Hex-A-Gone: flat [tileId, vanishAtSeconds, ...] for tiles somebody stepped on */
  tv: number[];
}
export interface RoundStart { k: 'round'; round: number; seed: number; participants: number[]; qualify: number; tick: number; map: string; mode: string; difficulty: number; /** team per slot (-1 none) */ teams: number[]; /** race | survival | crown */ rule: string; }
export interface RoundEnd { k: 'roundEnd'; qualified: number[]; eliminated: number[]; teamPoints?: number[]; }
export interface MatchEnd { k: 'matchEnd'; standings: number[]; winner: number; points: number[]; teams: number[]; teamPoints: number[]; xp: number[]; }

export type ServerMsg =
  | { k: 'welcome'; v: number; token: string; serverTime: number; profile: Profile }
  | { k: 'profile'; profile: Profile; gain: number }
  | { k: 'room'; room: RoomInfo; you: number }
  | { k: 'left' }
  | { k: 'error'; code: ErrorCode; msg: string }
  | { k: 'pong'; t: number; serverTime: number }
  | RoundStart | RoundEnd | MatchEnd | Snapshot;

// ---------- validation ----------
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown, lo = -1e9, hi = 1e9): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null);

export function parseInputFrames(raw: unknown): InputFrame[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_INPUTS_PER_PACKET) return null;
  const out: InputFrame[] = [];
  for (const f of raw) {
    if (!isObj(f)) return null;
    const seq = num(f.seq, 0, 2 ** 31), mx = num(f.mx, -2, 2), mz = num(f.mz, -2, 2);
    if (seq === null || !Number.isInteger(seq) || mx === null || mz === null) return null;
    out.push({ seq, mx, mz, jump: f.jump === true, dive: f.dive === true, use: f.use === true, push: f.push === true, grab: f.grab === true });
  }
  return out;
}

export function parseClientMsg(text: string): ClientMsg | null {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!isObj(m) || typeof m.k !== 'string') return null;
  switch (m.k) {
    case 'hello': {
      const v = num(m.v, 0, 1000);
      if (v === null || typeof m.name !== 'string') return null;
      const name = m.name.replace(/[^\p{L}\p{N} _\-.]/gu, '').trim().slice(0, 16) || 'Bot';
      const lk = typeof m.look === 'object' && m.look !== null ? (m.look as Record<string, unknown>) : null;
      return { k: 'hello', v, name, token: typeof m.token === 'string' && m.token.length <= 64 ? m.token : undefined, look: lk && Number.isInteger(lk.c) && Number.isInteger(lk.h) ? { c: lk.c as number, h: lk.h as number } : undefined };
    }
    case 'quickplay': return typeof m.game === 'string' && m.game.length <= 32 ? { k: 'quickplay', game: m.game } : null;
    case 'create': return typeof m.game === 'string' && m.game.length <= 32 ? { k: 'create', game: m.game, isPrivate: m.isPrivate === true } : null;
    case 'join': return typeof m.code === 'string' && /^[A-Z0-9]{4,6}$/.test(m.code.toUpperCase()) ? { k: 'join', code: m.code.toUpperCase() } : null;
    case 'ready': return { k: 'ready', ready: m.ready === true };
    case 'config': return typeof m.map === 'string' && typeof m.mode === 'string' && m.map.length <= 32 && m.mode.length <= 32 ? { k: 'config', map: m.map, mode: m.mode } : null;
    case 'screen': return typeof m.game === 'string' && m.game.length <= 32 && (m.code === undefined || (typeof m.code === 'string' && /^[A-Z0-9]{4,6}$/.test(m.code.toUpperCase()))) ? { k: 'screen', game: m.game, code: typeof m.code === 'string' ? m.code.toUpperCase() : undefined } : null;
    case 'start': return { k: 'start' };
    case 'look': return Number.isInteger(m.c) && Number.isInteger(m.h) ? { k: 'look', c: m.c as number, h: m.h as number } : null;
    case 'emote': return Number.isInteger(m.id) && (m.id as number) >= 0 && (m.id as number) < 8 ? { k: 'emote', id: m.id as number } : null;
    case 'leave': return { k: 'leave' };
    case 'input': { const frames = parseInputFrames(m.frames); return frames ? { k: 'input', frames } : null; }
    case 'ping': { const t = num(m.t); return t === null ? null : { k: 'ping', t }; }
    default: return null;
  }
}
