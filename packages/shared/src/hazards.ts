import { DT } from './constants';
import type { CourseHazard } from './types';

/** Pose of a hazard at a tick. Pure => server (hit detection) and every client (rendering) agree with no sync. */
export interface HazardPose {
  /** spinner: bar end points (x1,z1)-(x2,z2) at height y · pendulum/roller: head/centre at (x,y,z) */
  x: number; y: number; z: number; x1: number; z1: number; x2: number; z2: number;
  angle: number;   // spinner angle / pendulum swing angle / roller roll angle
  vx: number; vz: number; // direction of travel (unit-ish), used as knockback direction
}
const frac = (v: number) => ((v % 1) + 1) % 1;

export function hazardPose(h: CourseHazard, tick: number, out: HazardPose = {} as HazardPose): HazardPose {
  const t = tick * DT;
  if (h.kind === 'spinner') {
    const a = h.dir * h.speed * t + h.phase, c = Math.cos(a), s = Math.sin(a), r = h.len / 2;
    out.x = h.x; out.y = h.y; out.z = h.z; out.angle = a;
    out.x1 = h.x - c * r; out.z1 = h.z - s * r; out.x2 = h.x + c * r; out.z2 = h.z + s * r;
    out.vx = -s * h.dir; out.vz = c * h.dir; // tangential direction of the sweeping bar
  } else if (h.kind === 'pendulum') {
    const w = (Math.PI * 2) / h.period, a = h.speed * Math.sin(w * t + h.phase), da = h.speed * w * Math.cos(w * t + h.phase);
    const off = Math.sin(a) * h.len, dy = -Math.cos(a) * h.len;
    out.angle = a; out.y = h.y + dy;
    if ((h.axis ?? 'x') === 'x') { out.x = h.x + off; out.z = h.z; out.vx = Math.sign(da) || 1; out.vz = 0; }
    else { out.x = h.x; out.z = h.z + off; out.vx = 0; out.vz = Math.sign(da) || 1; }
    out.x1 = out.x2 = out.x; out.z1 = out.z2 = out.z;
  } else { // roller: rolls toward -z along a lane, then snaps back to the start (sawtooth)
    const f = frac(t / h.period + h.phase / (Math.PI * 2));
    out.x = h.x; out.y = h.y; out.z = h.z - h.len * f; out.angle = (h.len * f) / h.radius;
    out.x1 = out.x2 = out.x; out.z1 = out.z2 = out.z; out.vx = 0; out.vz = -1;
  }
  return out;
}

const _p = {} as HazardPose;
const segDist = (px: number, pz: number, ax: number, az: number, bx: number, bz: number) => {
  const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz || 1;
  const k = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / l2));
  const qx = ax + dx * k, qz = az + dz * k;
  return { d: Math.hypot(px - qx, pz - qz), qx, qz };
};

export interface HazardHit { x: number; y: number; z: number; dx: number; dz: number; }
/** Does a robot (feet-origin body, centre at y+0.55) touch this hazard at this tick? */
export function hazardHit(h: CourseHazard, tick: number, px: number, py: number, pz: number): HazardHit | null {
  const p = hazardPose(h, tick, _p), cy = py + 0.55, R = 0.42; // body radius
  if (h.kind === 'spinner') {
    if (cy < p.y - h.radius - 0.55 || cy > p.y + h.radius + 0.55) return null;
    const sd = segDist(px, pz, p.x1, p.z1, p.x2, p.z2);
    if (sd.d > h.radius + R) return null;
    let ox = px - sd.qx, oz = pz - sd.qz; const ol = Math.hypot(ox, oz) || 1; ox /= ol; oz /= ol;
    const dx = p.vx * 0.75 + ox * 0.25, dz = p.vz * 0.75 + oz * 0.25, dl = Math.hypot(dx, dz) || 1;
    return { x: sd.qx, y: p.y, z: sd.qz, dx: dx / dl, dz: dz / dl };
  }
  if (h.kind === 'pendulum') {
    if (Math.hypot(px - p.x, cy - p.y, pz - p.z) > h.radius + 0.55) return null;
    return { x: p.x, y: p.y, z: p.z, dx: p.vx, dz: p.vz };
  }
  const hw = h.halfWidth ?? 6; // roller: cylinder with axis along x
  if (Math.abs(px - p.x) > hw + 0.3) return null;
  if (Math.hypot(pz - p.z, cy - p.y) > h.radius + 0.5) return null;
  return { x: p.x, y: p.y, z: p.z, dx: 0, dz: -1 };
}
