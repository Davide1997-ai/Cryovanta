import { DT } from './constants';
import { nextRand, rangeRand } from './rng';
import type { Course, ItemBoxDef, Platform } from './types';

export interface Box { minx: number; maxx: number; miny: number; maxy: number; minz: number; maxz: number; id: number; kind: Platform['kind']; active: boolean; }

/** Blinking trap-door tiles: solid for `duty` of each cycle. Pure function of tick. */
export function blinkPhase(p: Platform, tick: number): number { return (((tick * DT) / p.period + p.phase / (Math.PI * 2)) % 1 + 1) % 1; }
export const blinkSolid = (p: Platform, tick: number) => blinkPhase(p, tick) < (p.duty ?? 0.6);

/** Platform centre at a given sim tick. Pure function of tick => server and clients agree without syncing platform state. */
export function platformCenter(p: Platform, tick: number, out: { x: number; y: number; z: number }) {
  if (p.kind === 'static' || p.kind === 'blink') { out.x = p.x; out.y = p.y; out.z = p.z; return out; }
  const s = Math.sin((tick * DT / p.period) * Math.PI * 2 + p.phase);
  out.x = p.x + p.ax * s; out.y = p.y + p.ay * s; out.z = p.z + p.az * s;
  return out;
}
const tmp = { x: 0, y: 0, z: 0 };
export function platformBox(p: Platform, tick: number, out: Box): Box {
  platformCenter(p, tick, tmp);
  out.minx = tmp.x - p.hx; out.maxx = tmp.x + p.hx;
  out.miny = tmp.y - p.hy; out.maxy = tmp.y + p.hy;
  out.minz = tmp.z - p.hz; out.maxz = tmp.z + p.hz;
  out.id = p.id; out.kind = p.kind; out.active = p.kind !== 'blink' || blinkSolid(p, tick);
  return out;
}

/**
 * Seeded procedural track. Every parameter is chosen so that the geometry stays inside the
 * controller's reach envelope (gap <= ~4.3u at difficulty 1; jump apex ~2.07u, hover adds ~1u).
 * `difficulty` in [0,1] grows with the round index.
 */
export function buildCourse(seed: number, difficulty: number, segmentCount = 5): Course {
  const r = { rng: seed >>> 0 };
  const platforms: Platform[] = [];
  const boxes: ItemBoxDef[] = [];
  const checkpoints: Course['checkpoints'] = [];
  let pid = 0, bid = 0;
  const hue = () => Math.floor(nextRand(r) * 6);

  const add = (kind: Platform['kind'], x: number, topY: number, z: number, hx: number, hz: number, o: Partial<Platform> = {}, thick = 1): Platform => {
    const p: Platform = { id: pid++, kind, x, y: topY - thick / 2, z, hx, hy: thick / 2, hz, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: hue(), ...o };
    platforms.push(p);
    return p;
  };
  const boxRow = (z: number, y: number, n = 3) => {
    for (let i = 0; i < n; i++) boxes.push({ id: bid++, x: (i - (n - 1) / 2) * 2.2, y: y + 1.1, z });
  };

  // ---- start pad ----
  add('static', 0, 0, 0, 7, 6);
  const spawnPoints: Course['spawnPoints'] = [];
  for (let i = 0; i < 7; i++) spawnPoints.push([(i - 3) * 1.8, 0, -3 + (i % 2) * 1.6]);
  boxRow(4.2, 0);
  checkpoints.push({ z: -100, spawn: [0, 0, 0] });
  let z = 6; // z of the leading edge of the last platform
  let top = 0;

  const rest = () => { // checkpoint pad with item boxes
    const gap = 2.4;
    const hz = 3.5;
    const cz = z + gap + hz;
    add('static', 0, top, cz, 5, hz);
    boxRow(cz + 1, top);
    checkpoints.push({ z: cz - hz + 0.5, spawn: [0, top, cz] });
    z = cz + hz;
  };

  const gapJumps = () => {
    const n = 4 + Math.round(difficulty * 3);
    for (let i = 0; i < n; i++) {
      const gap = rangeRand(r, 2.0, 2.6 + difficulty * 1.7);
      const hz = rangeRand(r, 1.2, 1.9), hx = rangeRand(r, 1.4, 2.2);
      const dy = nextRand(r) < 0.35 ? rangeRand(r, -0.8, 1.2) : 0;
      top = Math.max(-3, Math.min(6, top + dy));
      const cx = rangeRand(r, -2.5, 2.5);
      add('static', cx, top, z + gap + hz, hx, hz);
      z += gap + hz * 2;
    }
  };
  const movers = () => {
    const n = 3 + Math.round(difficulty * 2);
    for (let i = 0; i < n; i++) {
      const gap = 2.4 + difficulty * 0.6, hz = 1.8;
      add('mover', 0, top, z + gap + hz, 2, hz, { ax: 3.2 + difficulty, period: rangeRand(r, 2.8, 4.2), phase: rangeRand(r, 0, 6.28) });
      z += gap + hz * 2;
    }
  };
  const pistonBridge = () => {
    const gap = 2.4, len = 9 + difficulty * 3;
    const cz = z + gap + len / 2;
    add('static', 0, top, cz, 2.3, len / 2);
    const np = 2 + Math.round(difficulty * 2);
    for (let i = 0; i < np; i++) {
      const side = i % 2 ? 1 : -1;
      const pz = cz - len / 2 + ((i + 0.7) / (np + 0.3)) * len;
      add('piston', side * 3.4, top + 0.9, pz, 0.7, 0.8 - 0.0, { hy: 0.9, ax: 2.5, period: 2.2 - difficulty * 0.4, phase: i * 1.9 + (side > 0 ? Math.PI : 0), y: top + 0.9 }, 1.8);
    }
    z += gap + len;
  };
  const stairs = () => {
    const n = 4, base = top;
    for (let i = 0; i < n; i++) {
      const gap = 2.0 + difficulty * 0.8, hz = 1.4;
      top += 1.3;
      add('static', rangeRand(r, -1.5, 1.5), top, z + gap + hz, 1.6, hz);
      z += gap + hz * 2;
    }
    top = base; // the next pad sits back at base level (a drop is always survivable), keeps the vertical band bounded
  };

  const kinds = [gapJumps, movers, pistonBridge, stairs];
  let last = -1;
  for (let s = 0; s < segmentCount; s++) {
    let k = Math.floor(nextRand(r) * kinds.length);
    if (k === last) k = (k + 1) % kinds.length;
    last = k;
    kinds[k]();
    if (s % 2 === 1 || s === segmentCount - 1) rest();
  }

  // ---- goal ----
  const gz = z + 3 + 5;
  add('static', 0, top, gz, 8, 5, { hue: 5 });
  const finishZ = gz - 2;
  return { seed, platforms, checkpoints, boxes, finishZ, killY: -14, spawnPoints, length: gz, mapId: 'neon-circuit', theme: 'neon', hazards: [], zones: [] };
}
