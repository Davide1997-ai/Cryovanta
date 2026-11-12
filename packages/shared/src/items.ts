import { DT } from './constants';
import { moveBody } from './controller';
import { approach } from './math';
import { nextRand } from './rng';
import type { Course, HazardState, PlayerState, SeekerState } from './types';

/** Original item set, Mario-Kart-style roles: speed, homing attack, dropped trap, defensive pickup. */
export type ItemKind = 'boost' | 'seeker' | 'hazard' | 'shield';
export const ITEM_KINDS: readonly ItemKind[] = ['boost', 'seeker', 'hazard', 'shield'];

export const ITEM_TUNING = {
  boostTime: 1.7,
  boostKick: 6,
  shieldTime: 7,
  seekerSpeed: 19,
  seekerTurn: 5.5, // 1/s steering gain
  seekerLife: 6,
  seekerHitRadius: 0.95,
  seekerMaxLive: 2, // per owner
  hazardLife: 25,
  hazardArm: 0.6,
  hazardOwnerGrace: 1.5,
  hazardHalf: 0.5,
  hazardMaxLive: 3, // per owner
  boxRespawn: 4,
  boxPickupRadius: 1.25,
} as const;

/** [weight for the leader, weight for last place]; weights lerp by rank => rubber-banding like Mario Kart. */
const WEIGHTS: Record<ItemKind, [number, number]> = {
  boost: [3, 3.5],
  seeker: [0.4, 4.5],
  hazard: [4, 1],
  shield: [3, 1.5],
};

/** rankFrac: 0 = leader, 1 = last. */
export function rollItem(world: { rng: number }, rankFrac: number): ItemKind {
  const w = ITEM_KINDS.map((k) => WEIGHTS[k][0] + (WEIGHTS[k][1] - WEIGHTS[k][0]) * rankFrac);
  let r = nextRand(world) * w.reduce((a, b) => a + b, 0);
  for (let i = 0; i < w.length; i++) { r -= w[i]; if (r <= 0) return ITEM_KINDS[i]; }
  return 'boost';
}

/** Nearest racer directly AHEAD of `owner` in the standings; -1 if owner leads (then the drone flies straight). */
export function pickSeekerTarget(players: PlayerState[], rankOf: number[], owner: number): number {
  const myRank = rankOf[owner];
  let best = -1, bestRank = -1;
  for (const p of players) {
    if (!p.alive || p.slot === owner || p.finishRank > 0 || p.respawn > 0) continue;
    const r = rankOf[p.slot];
    if (r < myRank && r > bestRank) { best = p.slot; bestRank = r; }
  }
  return best;
}

export function stepSeeker(s: SeekerState, players: PlayerState[]) {
  s.life -= DT;
  const t = s.target >= 0 ? players[s.target] : null;
  let dx = s.vx, dy = 0, dz = s.vz;
  if (t && t.alive && t.respawn <= 0 && t.finishRank === 0) {
    const tx = t.x - s.x, ty = t.y + 0.7 - s.y, tz = t.z - s.z;
    const d = Math.hypot(tx, ty, tz) || 1;
    const sp = Math.hypot(s.vx, s.vy, s.vz) || 1;
    const k = Math.min(1, ITEM_TUNING.seekerTurn * DT);
    dx = s.vx / sp + (tx / d - s.vx / sp) * k;
    dy = s.vy / sp + (ty / d - s.vy / sp) * k;
    dz = s.vz / sp + (tz / d - s.vz / sp) * k;
  } else { dy = s.vy; } // target lost: keep heading
  const n = Math.hypot(dx, dy, dz) || 1;
  s.vx = (dx / n) * ITEM_TUNING.seekerSpeed; s.vy = (dy / n) * ITEM_TUNING.seekerSpeed; s.vz = (dz / n) * ITEM_TUNING.seekerSpeed;
  s.x += s.vx * DT; s.y += s.vy * DT; s.z += s.vz * DT;
}

/** Hazard blocks are real rigid bodies: tossed, they fall, land on platforms, ride movers and slide to rest. */
export function stepHazard(h: HazardState, course: Course, tick: number, carryId: { v: number }) {
  h.life -= DT; h.armed = Math.max(0, h.armed - DT);
  h.vy = Math.max(-30, h.vy - 32 * DT);
  const res = moveBody(h, ITEM_TUNING.hazardHalf, ITEM_TUNING.hazardHalf * 2, course, tick, carryId.v);
  carryId.v = res.platformId;
  if (res.grounded) { h.vx = approach(h.vx, 0, 14 * DT); h.vz = approach(h.vz, 0, 14 * DT); }
  if (h.y < course.killY) h.life = 0;
}
