/**
 * Impact resolution: the single place that decides what happens when something touches a robot.
 * Order of rules matters (documented in docs/ARCHITECTURE.md §Impact table).
 */
import type { PlayerState } from './types';

export type ImpactKind = 'seeker' | 'hazard' | 'dive';
export interface ImpactSource { kind: ImpactKind; owner: number; x: number; y: number; z: number; vx: number; vz: number; }
/** hit: knocked/stunned · blocked: shield ate it · smashed: boosting robot shattered the hazard · ignored: no contact effect */
export type ImpactOutcome = 'hit' | 'blocked' | 'smashed' | 'ignored';
export interface ImpactResult { outcome: ImpactOutcome; consumeSource: boolean; }

const PROFILE = {
  seeker: { push: 10, up: 7.5, stun: 1.4, invuln: 1.8 },
  hazard: { push: 7, up: 9, stun: 1.0, invuln: 1.5 },
  dive: { push: 12, up: 4.5, stun: 0.6, invuln: 0.8 },
} as const;

export function resolveImpact(src: ImpactSource, t: PlayerState): ImpactResult {
  // 1) untouchable states
  if (!t.alive || t.respawn > 0 || t.finishRank > 0) return { outcome: 'ignored', consumeSource: false };
  // 2) never hit yourself with homing/dive (own hazards are handled by the hazard grace timer)
  if (t.slot === src.owner && src.kind !== 'hazard') return { outcome: 'ignored', consumeSource: false };
  const prof = PROFILE[src.kind];
  // direction: along projectile travel if it has velocity, else from source to victim
  let dx = t.x - src.x, dz = t.z - src.z;
  if ((src.kind === 'seeker' || src.kind === 'dive') && (src.vx !== 0 || src.vz !== 0)) { dx = src.vx; dz = src.vz; }
  const dl = Math.hypot(dx, dz) || 1; dx /= dl; dz /= dl;

  // 3) i-frames: projectile/hazard passes through
  if (t.invuln > 0) return { outcome: 'ignored', consumeSource: false };
  // 4) shield absorbs exactly one hit, grants a short grace window
  if (t.shield > 0) { t.shield = 0; t.invuln = 0.6; return { outcome: 'blocked', consumeSource: src.kind !== 'dive' }; }
  // 5) boosting robot plows through a hazard block (loses most of the boost – risk/reward)
  if (src.kind === 'hazard' && t.boost > 0) { t.boost *= 0.35; return { outcome: 'smashed', consumeSource: true }; }
  // 6) the actual hit
  t.vx = dx * prof.push; t.vz = dz * prof.push; t.vy = prof.up;
  t.stun = prof.stun; t.invuln = prof.invuln; t.boost = 0; t.hovering = false; t.diving = 0;
  t.grounded = false; t.platformId = -1;
  return { outcome: 'hit', consumeSource: src.kind !== 'dive' };
}
