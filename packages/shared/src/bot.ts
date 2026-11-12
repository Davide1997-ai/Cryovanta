import { boxesAt } from './controller';
import type { Course, InputFrame, PlayerState } from './types';

/** Tiny navigation bot: used by tests (course reachability) and by the server load-test. Not "AI". */
export function botInput(p: PlayerState, course: Course, tick: number, seq: number, opts: { useItems?: boolean } = {}): InputFrame {
  const boxes = boxesAt(course, tick);
  let tgt = null as (typeof boxes)[number] | null;
  for (const b of boxes) {
    if (b.kind === 'piston' || b.minz < p.z - 0.2) continue;
    if (!tgt || b.minz < tgt.minz) tgt = b;
  }
  let mx = 0, mz = 1, nearTop = p.y, toEdge = 99;
  if (tgt) {
    const ax = Math.min(tgt.maxx - 0.7, Math.max(tgt.minx + 0.7, (tgt.minx + tgt.maxx) / 2));
    const az = tgt.minz + 1;
    const dx = ax - p.x, dz = Math.max(0.5, az - p.z);
    const l = Math.hypot(dx, dz) || 1;
    mx = dx / l; mz = dz / l; nearTop = tgt.maxy; toEdge = tgt.minz - p.z;
  }
  // dodge pistons: stay on the side opposite to the nearest one ahead
  let pist: (typeof boxes)[number] | null = null;
  for (const b of boxes) if (b.kind === 'piston' && b.maxz > p.z - 0.3 && b.minz < p.z + 4 && (!pist || b.minz < pist.minz)) pist = b;
  if (pist) { const side = (pist.minx + pist.maxx) / 2 > 0 ? -1 : 1; mx = Math.max(-1, Math.min(1, mx + (side * 1.1 - p.x) * 0.9)); const l = Math.hypot(mx, mz); mx /= l; mz /= l; }
  const px = p.x + mx * 0.9, pz = p.z + mz * 0.9;
  const supported = boxes.some((b) => b.kind !== 'piston' && px > b.minx && px < b.maxx && pz > b.minz && pz < b.maxz && Math.abs(b.maxy - p.y) < 0.6);
  let jump: boolean;
  if (p.grounded) jump = (!supported && nearTop > p.y - 0.8) || (nearTop > p.y + 0.3 && !!tgt && tgt.minz - p.z < 1.8);
  else if (p.vy > 0.5) jump = true; // hold for full-height jump
  else if (p.vy > -0.1 && !p.hovering) jump = false; // 1-tick release near the apex => fresh press = hover edge
  else jump = p.hoverFuel > 0.05 && ((p.hovering && toEdge < 3) || (toEdge < 2.5 && p.y < nearTop + 0.3)); // burn thruster only while below the target ledge
  if (p.grounded && p.jumpHeld) jump = false; // need a fresh press edge to take off
  return { seq, mx, mz, jump, dive: false, use: !!opts.useItems && !!p.item && tick % 45 === 0 };
}
