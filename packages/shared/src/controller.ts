/**
 * Character controller — "reactive robot" feel.
 * Pure + deterministic: the SAME function runs on the authoritative server and in the client's
 * prediction loop. Nothing in here may read wall-clock time, Math.random or DOM state.
 */
import { BODY_HALF_W, BODY_HEIGHT, DT, TUNING as T } from './constants';
import { approach, clamp, lerpAngle } from './math';
import { platformBox, platformCenter, type Box } from './course';
import type { Course, InputFrame, PlayerState } from './types';

export interface Body { x: number; y: number; z: number; vx: number; vy: number; vz: number; }

const _boxes: Box[] = [];
export function boxesAt(course: Course, tick: number): Box[] {
  const ps = course.platforms;
  while (_boxes.length < ps.length) _boxes.push({ minx: 0, maxx: 0, miny: 0, maxy: 0, minz: 0, maxz: 0, id: 0, kind: 'static' });
  for (let i = 0; i < ps.length; i++) platformBox(ps[i], tick, _boxes[i]);
  return _boxes;
}
const EPS = 1e-4;
const _c0 = { x: 0, y: 0, z: 0 }, _c1 = { x: 0, y: 0, z: 0 };

/** Axis-separated AABB sweep against the course. Returns grounded platform id (-1 if airborne). */
export function moveBody(b: Body, hw: number, h: number, course: Course, tick: number, carryId: number): { grounded: boolean; platformId: number } {
  // carry with the platform we were standing on
  if (carryId >= 0) {
    const pl = course.platforms[carryId];
    if (pl && pl.kind !== 'static') {
      platformCenter(pl, tick, _c1); platformCenter(pl, tick - 1, _c0);
      b.x += _c1.x - _c0.x; b.y += _c1.y - _c0.y; b.z += _c1.z - _c0.z;
    }
  }
  const boxes = boxesAt(course, tick);
  const zNear = 12;
  // X
  b.x += b.vx * DT;
  for (const o of boxes) {
    if (Math.abs(o.minz + o.maxz - 2 * b.z) > (o.maxz - o.minz) + zNear) continue;
    if (b.y < o.maxy - EPS && b.y + h > o.miny + EPS && b.z + hw > o.minz && b.z - hw < o.maxz && b.x + hw > o.minx && b.x - hw < o.maxx) {
      // step-up lip forgiveness so players don't snag on seams
      if (o.maxy - b.y < 0.18 && b.vy <= 0) { b.y = o.maxy; continue; }
      if (b.vx > 0 || (b.vx === 0 && b.x < (o.minx + o.maxx) / 2)) b.x = o.minx - hw; else b.x = o.maxx + hw;
      b.vx = 0;
    }
  }
  // Z
  b.z += b.vz * DT;
  for (const o of boxes) {
    if (Math.abs(o.minz + o.maxz - 2 * b.z) > (o.maxz - o.minz) + zNear) continue;
    if (b.y < o.maxy - EPS && b.y + h > o.miny + EPS && b.x + hw > o.minx && b.x - hw < o.maxx && b.z + hw > o.minz && b.z - hw < o.maxz) {
      if (o.maxy - b.y < 0.18 && b.vy <= 0) { b.y = o.maxy; continue; }
      if (b.vz > 0 || (b.vz === 0 && b.z < (o.minz + o.maxz) / 2)) b.z = o.minz - hw; else b.z = o.maxz + hw;
      b.vz = 0;
    }
  }
  // Y
  b.y += b.vy * DT;
  let grounded = false, platformId = -1;
  for (const o of boxes) {
    if (b.x + hw > o.minx && b.x - hw < o.maxx && b.z + hw > o.minz && b.z - hw < o.maxz && b.y < o.maxy && b.y + h > o.miny) {
      if (b.vy <= 0 && b.y > o.maxy - 0.6) { b.y = o.maxy; b.vy = 0; grounded = true; platformId = o.id; }
      else if (b.vy > 0) { b.y = o.miny - h; b.vy = 0; }
    }
  }
  return { grounded, platformId };
}

export function createPlayer(slot: number, spawn: [number, number, number]): PlayerState {
  return {
    slot, x: spawn[0], y: spawn[1], z: spawn[2], vx: 0, vy: 0, vz: 0, yaw: 0,
    grounded: false, platformId: -1, coyote: 0, jumpBuf: 0, jumpHeld: false, hoverFuel: T.hoverFuel, hovering: false,
    diveCd: 0, diving: 0, stun: 0, boost: 0, shield: 0, invuln: 0, respawn: 0, checkpoint: 0,
    item: null, useHeld: false, diveHeld: false, finishedAt: -1, finishRank: 0, alive: true,
  };
}

export function respawnPlayer(p: PlayerState, course: Course) {
  if (p.checkpoint === 0) {
    const s = course.spawnPoints[p.slot];
    p.x = s[0]; p.y = s[1] + 0.05; p.z = s[2];
  } else {
    const cp = course.checkpoints[p.checkpoint];
    p.x = cp.spawn[0] + (p.slot - 3) * 0.9; p.y = cp.spawn[1] + 0.05; p.z = cp.spawn[2];
  }
  p.vx = p.vy = p.vz = 0; p.stun = 0; p.boost = 0; p.diving = 0; p.hovering = false;
  p.invuln = 1.5; p.respawn = 0; p.platformId = -1; p.hoverFuel = T.hoverFuel;
}

export function sanitizeInput(i: InputFrame): InputFrame {
  let mx = Number.isFinite(i.mx) ? i.mx : 0, mz = Number.isFinite(i.mz) ? i.mz : 0;
  const len = Math.hypot(mx, mz);
  if (len > 1) { mx /= len; mz /= len; }
  return { seq: i.seq, mx, mz, jump: !!i.jump, dive: !!i.dive, use: !!i.use };
}

/** Advance one player by one tick. Does NOT handle items/impacts (that is the sim's job). */
export function stepPlayer(p: PlayerState, raw: InputFrame, course: Course, tick: number): void {
  if (!p.alive) return;
  const inp = raw; // callers sanitise (server) — client generates already-normalised input
  if (p.respawn > 0) {
    p.respawn -= DT;
    if (p.respawn <= 0) respawnPlayer(p, course);
    return;
  }
  p.stun = Math.max(0, p.stun - DT); p.boost = Math.max(0, p.boost - DT);
  p.shield = Math.max(0, p.shield - DT); p.invuln = Math.max(0, p.invuln - DT);
  p.diveCd = Math.max(0, p.diveCd - DT); p.diving = Math.max(0, p.diving - DT);
  p.coyote = Math.max(0, p.coyote - DT); p.jumpBuf = Math.max(0, p.jumpBuf - DT);

  const stunned = p.stun > 0;
  const mx = stunned ? 0 : inp.mx, mz = stunned ? 0 : inp.mz;
  const wantsMove = mx !== 0 || mz !== 0;
  const speed = T.runSpeed * (p.boost > 0 ? T.boostMul : 1);
  const accel = p.grounded ? (wantsMove ? T.accelGround : T.frictionGround) : T.accelAir;
  const steer = p.diving > 0 ? 0.15 : 1; // committed dive = limited steering
  if (p.diving <= 0 || wantsMove) {
    p.vx = approach(p.vx, mx * speed, accel * steer * DT);
    p.vz = approach(p.vz, mz * speed, accel * steer * DT);
  }
  if (wantsMove && p.diving <= 0) p.yaw = lerpAngle(p.yaw, Math.atan2(mx, mz), 1 - Math.exp(-18 * DT));

  // ---- jump / hover ----
  const jumpEdge = inp.jump && !p.jumpHeld;
  p.jumpHeld = inp.jump;
  if (jumpEdge && !stunned) p.jumpBuf = T.jumpBuffer;
  if (!inp.jump) p.hovering = false;
  if (!stunned && p.jumpBuf > 0 && (p.grounded || p.coyote > 0)) {
    p.vy = T.jumpVelocity; p.grounded = false; p.coyote = 0; p.jumpBuf = 0; p.platformId = -1;
  } else if (jumpEdge && !stunned && !p.grounded && p.hoverFuel > 0 && p.vy < T.hoverMaxRise) {
    p.hovering = true; // thruster hop (hold to burn fuel)
  }
  if (p.hovering && inp.jump && p.hoverFuel > 0 && !stunned) {
    p.hoverFuel = Math.max(0, p.hoverFuel - DT);
    p.vy = Math.min(T.hoverMaxRise, p.vy + T.hoverAccel * DT);
  } else p.hovering = false;

  // ---- dive (forward lunge, also a shove) ----
  const diveEdge = inp.dive && !p.diveHeld;
  p.diveHeld = inp.dive;
  if (diveEdge && !stunned && p.diveCd <= 0) {
    const sp = T.diveSpeed * (p.boost > 0 ? 1.2 : 1);
    p.vx = Math.sin(p.yaw) * sp; p.vz = Math.cos(p.yaw) * sp;
    if (p.grounded) p.vy = Math.max(p.vy, T.diveLift);
    p.diveCd = T.diveCooldown; p.diving = 0.45; p.hovering = false; p.grounded = false; p.platformId = -1;
  }

  // ---- gravity ----
  let g = T.gravity;
  if (p.hovering) g *= 0.35;
  else if (p.vy > 0 && !inp.jump && !stunned) g *= T.jumpCutGravityMul; // variable jump height
  p.vy = Math.max(T.terminalVelocity, p.vy - g * DT);

  const hs = Math.hypot(p.vx, p.vz);
  if (hs > T.maxHorizontalSpeed) { const k = T.maxHorizontalSpeed / hs; p.vx *= k; p.vz *= k; }

  // ---- collide ----
  const wasGrounded = p.grounded;
  const res = moveBody(p, BODY_HALF_W, BODY_HEIGHT, course, tick, p.platformId);
  p.grounded = res.grounded; p.platformId = res.platformId;
  if (p.grounded) { p.coyote = T.coyoteTime; p.hoverFuel = T.hoverFuel; p.hovering = false; }
  else if (wasGrounded && p.vy <= 0) p.coyote = T.coyoteTime;

  // ---- race bookkeeping (pure, so prediction stays in sync with the server) ----
  if (p.grounded) {
    const cps = course.checkpoints;
    while (p.checkpoint + 1 < cps.length && p.z > cps[p.checkpoint + 1].z) p.checkpoint++;
  }
  if (p.y < course.killY) { p.respawn = T.respawnDelay; p.vx = p.vy = p.vz = 0; p.boost = 0; p.stun = 0; p.diving = 0; }
}

export const clampMove = (v: number) => clamp(v, -1, 1);
