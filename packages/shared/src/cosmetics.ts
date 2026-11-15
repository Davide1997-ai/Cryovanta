/** Robot look, emotes and the XP/level curve (shared so the phone, the screen and the server agree). */
import { PLAYER_COLORS } from './constants';

export const LOOK_COLORS: readonly number[] = [...PLAYER_COLORS, 0xe6e6e6, 0xff3b30, 0x8bc34a, 0x00bcd4, 0x8d6e63];
export const COLOR_NAMES = ['Blu', 'Rosa', 'Verde', 'Giallo', 'Viola', 'Arancio', 'Turchese', 'Bianco', 'Rosso', 'Lime', 'Ciano', 'Marrone'];

/** hat id → name and the level needed to wear it (0 = no hat) */
export const HATS: readonly { name: string; level: number }[] = [
  { name: 'Nessuno', level: 1 }, { name: 'Cappellino', level: 1 }, { name: 'Cappello da festa', level: 2 }, { name: 'Elica', level: 3 },
  { name: 'Aureola', level: 5 }, { name: 'Corona d\'oro', level: 7 }, { name: 'Cilindro', level: 9 }, { name: 'Corna', level: 12 },
];
export interface Look { c: number; h: number }
export const defaultLook = (slot: number): Look => ({ c: Math.max(0, slot) % PLAYER_COLORS.length, h: 0 });

export const EMOTES = ['👋', '💃', '😡', '😂'] as const;
export const EMOTE_COOLDOWN_TICKS = 72;

export function sanitizeLook(l: unknown, level: number, fallback: Look): Look {
  const o = (typeof l === 'object' && l !== null ? l : {}) as Record<string, unknown>;
  const c = Number.isInteger(o.c) && (o.c as number) >= 0 && (o.c as number) < LOOK_COLORS.length ? (o.c as number) : fallback.c;
  let h = Number.isInteger(o.h) && (o.h as number) >= 0 && (o.h as number) < HATS.length ? (o.h as number) : fallback.h;
  if (HATS[h].level > level) h = 0; // locked hats cannot be forged by the client
  return { c, h };
}

// ---- progression ----
export const xpForLevel = (level: number) => 60 * (level - 1) * (level - 1);
export const levelFromXp = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 60));
export interface Profile { xp: number; level: number; prevXp: number; nextXp: number; matches: number; wins: number }
export function profileView(xp: number, matches: number, wins: number): Profile {
  const level = levelFromXp(xp); return { xp, level, prevXp: xpForLevel(level), nextXp: xpForLevel(level + 1), matches, wins };
}
/** XP for one finished match: participation + placement (more players beaten = more) + a bonus for winning. */
export function xpForMatch(place: number, players: number, winner: boolean): number {
  return 25 + Math.max(0, players - 1 - place) * 10 + (winner ? 40 : 0);
}
