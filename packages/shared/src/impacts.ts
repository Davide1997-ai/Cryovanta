/**
 * Impact resolution: the single place that decides what happens when something touches a robot.
 * Order of rules matters (documented in docs/ARCHITECTURE.md §Impact table).
 */
import type { PlayerState } from './types';

export type ImpactKind = 'seeker' | 'hazard' | 'dive' | 'obstacle' | 'shove' | 'bump';
export interface ImpactSource { kind: ImpactKind; owner: number; x: number; y: number; z: number; vx: number; vz: number; /** scales the knockback (ramming speed) */ power?: number;
  /** team round: teammates are immune to shoves, bumps, dives, grabs and homing drones */ ownerTeam?: number; }
/** hit: knocked/stunned · blocked: shield ate it · smashed: boosting robot shattered the hazard · ignored: no contact effect */
export type ImpactOutcome = 'hit' | 'blocked' | 'smashed' | 'ignored';
export interface ImpactResult { outcome: ImpactOutcome; consumeSource: boolean; }

const PROFILE = {
  seeker: { push: 10, up: 7.5, stun: 1.4, invuln: 1.8 },
  hazard: { push: 7, up: 9, stun: 1.0, invuln: 1.5 },
  dive: { push: 12, up: 4.5, stun: 0.6, invuln: 0.8 },
  obstacle: { push: 12, up: 7, stun: 0.9, invuln: 1.3 }, // giant course hazards: spinners, hammers, rollers
  shove: { push: 10.5, up: 3.2, stun: 0.5, invuln: 0.3 }, // the push button: short i-frames so shoves can chain once the cooldown allows
  bump: { push: 6.5, up: 1.8, stun: 0.28, invuln: 0.3 },  // running into someone at speed
} as const;

export function resolveImpact(src: ImpactSource, t: PlayerState): ImpactResult {
  // 1) untouchable states
  if (!t.alive || t.respawn > 0 || t.finishRank > 0) return { outcome: 'ignored', consumeSource: false };
  // 2) never hit yourself with homing/dive (own hazards are handled by the hazard grace timer)
  if (t.slot === src.owner && src.kind !== 'hazard') return { outcome: 'ignored', consumeSource: false };
  if (src.ownerTeam !== undefined && src.ownerTeam >= 0 && src.ownerTeam === t.team && src.kind !== 'hazard' && src.kind !== 'obstacle') return { outcome: 'ignored', consumeSource: false };
  const prof = PROFILE[src.kind];
  // direction: along projectile travel if it has velocity, else from source to victim
  let dx = t.x - src.x, dz = t.z - src.z;
  if ((src.kind === 'seeker' || src.kind === 'dive' || src.kind === 'obstacle' || src.kind === 'shove' || src.kind === 'bump') && (src.vx !== 0 || src.vz !== 0)) { dx = src.vx; dz = src.vz; }
  const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;

  // 3) i-frames: projectile/hazard passes through
  if (t.invuln > 0) return { outcome: 'ignored', consumeSource: false };
  // 4) shield absorbs exactly one hit, grants a short grace window
  if (t.shield > 0) { t.shield = 0; t.invuln = 0.6; return { outcome: 'blocked', consumeSource: src.kind !== 'dive' }; }
  // 5) boosting robot plows through a hazard block (loses most of the boost – risk/reward)
  if (src.kind === 'hazard' && t.boost > 0) { t.boost *= 0.35; return { outcome: 'smashed', consumeSource: true }; }
  // 6) the actual hit
  const pw = src.power ?? 1;
  t.vx = dx * prof.push * pw; t.vz = dz * prof.push * pw; t.vy = prof.up;
  t.stun = prof.stun; t.invuln = prof.invuln; t.boost = 0; t.hovering = false; t.diving = 0; t.grabbing = 0; t.grabTarget = -1;
  t.grounded = false; t.platformId = -1;
  return { outcome: 'hit', consumeSource: src.kind !== 'dive' };
}
