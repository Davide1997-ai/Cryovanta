import { buildCourse } from './course';
import { nextRand, rangeRand } from './rng';
import type { Course, CourseHazard, ItemBoxDef, Platform, Surface, Theme, WindZone } from './types';

export interface MapDef { id: string; name: string; desc: string; theme: Theme; /** race = reach the finish line; survival = last robot standing */ kind: 'race' | 'survival'; build(seed: number, difficulty: number): Course; }

/** Small builder kit shared by the "giant obstacle park" maps. Cursor `z` = leading edge of the last slab. */
class Kit {
  platforms: Platform[] = []; boxes: ItemBoxDef[] = []; hazards: CourseHazard[] = []; zones: WindZone[] = [];
  checkpoints: Course['checkpoints'] = [{ z: -100, spawn: [0, 0, 0] }];
  z = 0; top = 0;
  private pid = 0; private bid = 0; private hid = 0;
  readonly r: { rng: number };
  constructor(seed: number, readonly W: number, readonly d: number) { this.r = { rng: seed >>> 0 }; }
  rand(a: number, b: number) { return rangeRand(this.r, a, b); }
  chance(p: number) { return nextRand(this.r) < p; }
  pick<T>(xs: readonly T[]): T { return xs[Math.floor(nextRand(this.r) * xs.length)]; }

  add(kind: Platform['kind'], x: number, top: number, z: number, hx: number, hz: number, o: Partial<Platform> = {}, thick = 1.2): Platform {
    const p: Platform = { id: this.pid++, kind, x, y: top - thick / 2, z, hx, hy: thick / 2, hz, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: Math.floor(nextRand(this.r) * 6), surface: 'normal', skin: 0, ...o };
    this.platforms.push(p); return p;
  }
  /** Wide slab starting `gap` after the cursor. Returns its centre z. */
  slab(len: number, o: Partial<Platform> = {}, gap = 2.6, hx = this.W): { cz: number; z0: number; p: Platform } {
    const z0 = this.z + gap, cz = z0 + len / 2;
    const p = this.add('static', 0, this.top, cz, hx, len / 2, o);
    this.z = z0 + len; return { cz, z0, p };
  }
  boxRow(z: number, n = 5, spread = 2.6) { for (let i = 0; i < n; i++) this.boxes.push({ id: this.bid++, x: (i - (n - 1) / 2) * spread, y: this.top + 1.1, z }); }
  rest() {
    const { cz, z0 } = this.slab(9, { skin: 3, surface: 'normal' }, 3, this.W + 1.5);
    this.boxRow(cz + 1, 5); this.checkpoints.push({ z: z0 + 0.5, spawn: [0, this.top, cz] });
  }
  hazard(h: Omit<CourseHazard, 'id'>) { this.hazards.push({ id: this.hid++, ...h }); }
  zone(z: WindZone) { this.zones.push(z); }
}

type Seg = (k: Kit) => void;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

// ------------------------------------------------------------------ obstacle segments
const gapJumps: Seg = (k) => {
  const n = 5 + Math.round(k.d * 3);
  for (let i = 0; i < n; i++) {
    const gap = k.rand(2.2, 2.8 + k.d * 1.5), hz = k.rand(1.8, 3), hx = k.rand(2.2, 4);
    k.top = Math.max(-2, Math.min(5, k.top + (k.chance(0.35) ? k.rand(-0.8, 1.1) : 0)));
    const cx = k.rand(-k.W * 0.5, k.W * 0.5);
    k.add('static', cx, k.top, k.z + gap + hz, hx, hz, { skin: 1 + (i % 2) });
    k.z += gap + hz * 2;
  }
};
const movers: Seg = (k) => {
  const n = 4 + Math.round(k.d * 2);
  for (let i = 0; i < n; i++) {
    const gap = 2.6 + k.d * 0.6, hz = 2.2;
    k.add('mover', 0, k.top, k.z + gap + hz, 3, hz, { ax: 5 + k.d * 1.5, period: k.rand(3, 4.4), phase: k.rand(0, 6.28), skin: 4 });
    k.z += gap + hz * 2;
  }
};
const spinnerField: Seg = (k) => {
  const len = 30, { z0 } = k.slab(len, { skin: 0 });
  const n = 3 + Math.round(k.d * 2);
  for (let i = 0; i < n; i++) {
    k.hazard({ kind: 'spinner', x: 0, y: k.top + 0.5, z: z0 + ((i + 0.7) / (n + 0.2)) * len, len: k.W * 2 - 0.6, radius: 0.32, speed: 1.1 + k.d * 0.9, period: 1, phase: k.rand(0, 6.28), dir: i % 2 ? 1 : -1 });
  }
};
const pendulumAlley: Seg = (k) => {
  const len = 32, { z0 } = k.slab(len, { skin: 4 }, 2.6, 4.2);
  const n = 4 + Math.round(k.d * 2);
  for (let i = 0; i < n; i++) {
    k.hazard({ kind: 'pendulum', x: 0, y: k.top + 7.2, z: z0 + ((i + 0.6) / (n + 0.1)) * len, len: 6.6, radius: 0.9, halfWidth: 4.2, speed: 0.95, period: 2.7 - k.d * 0.5, phase: i * 1.3, dir: 1, axis: 'x' });
  }
};
const blinkTiles: Seg = (k) => {
  const rows = 5 + Math.round(k.d * 3);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < 4; c++) {
      k.add('blink', (c - 1.5) * 4, k.top, k.z + 2 + 2, 1.8, 1.8, { period: 3.6 - k.d * 0.6, phase: k.rand(0, 6.28), duty: 0.72 - k.d * 0.1, skin: 2 });
    }
    k.z += 2 + 3.6;
  }
};
const conveyorRun: Seg = (k) => {
  const { cz } = k.slab(28, { surface: 'conveyor', flowZ: -(4.5 + k.d * 2.5), skin: 5 });
  k.add('piston', k.W * 0.6, k.top + 0.9, cz, 0.8, 0.9, { hy: 0.9, ax: k.W * 0.55, period: 2.4, phase: 0, y: k.top + 0.9 }, 1.8);
};
const bouncePads: Seg = (k) => {
  for (let i = 0; i < 3; i++) { k.slab(4.4, { surface: 'bounce', skin: 6 }, i === 0 ? 3 : 5.2, 3.2); }
  k.slab(5, { skin: 1 }, 5.2, 4.5);
};
const iceRink: Seg = (k) => {
  const len = 34, { z0, cz } = k.slab(len, { surface: 'ice', skin: 7 });
  k.add('piston', -k.W * 0.6, k.top + 0.9, cz - 6, 0.8, 0.9, { hy: 0.9, ax: k.W * 0.5, period: 2.6, phase: 0 }, 1.8);
  k.add('piston', k.W * 0.6, k.top + 0.9, cz + 6, 0.8, 0.9, { hy: 0.9, ax: k.W * 0.5, period: 2.6, phase: Math.PI }, 1.8);
  k.hazard({ kind: 'spinner', x: 0, y: k.top + 0.5, z: z0 + len * 0.8, len: k.W * 2 - 1, radius: 0.32, speed: 1 + k.d * 0.5, period: 1, phase: 0, dir: 1 });
};
const rollerRun: Seg = (k) => {
  const len = 44, { z0 } = k.slab(len, { skin: 0 }); const n = 2 + Math.round(k.d);
  for (let i = 0; i < n; i++) k.hazard({ kind: 'roller', x: 0, y: k.top + 0.85, z: z0 + len - 2, len: len - 4, radius: 0.85, halfWidth: k.W, speed: 0, period: 4.4 - k.d * 0.8, phase: (i / n) * Math.PI * 2 * 0.9, dir: -1 });
};
const windTunnel: Seg = (k) => {
  const len = 30, { cz } = k.slab(len, { skin: 4 }, 2.6, 4.5);
  const hz = len / 4;
  k.zone({ x: 0, y: k.top + 2, z: cz - hz, hx: 4.5, hy: 4, hz, fx: 20, fz: 0, period: 4, duty: 0.55, phase: 0 });
  k.zone({ x: 0, y: k.top + 2, z: cz + hz, hx: 4.5, hy: 4, hz, fx: -20, fz: 0, period: 4, duty: 0.55, phase: 0.5 });
};
const slimeSwamp: Seg = (k) => {
  const len = 26, { z0 } = k.slab(len, { surface: 'slime', skin: 8 });
  k.hazard({ kind: 'spinner', x: 0, y: k.top + 0.5, z: z0 + len * 0.5, len: k.W * 2 - 0.6, radius: 0.32, speed: 1.4, period: 1, phase: 0, dir: -1 });
};
const pistonBridge: Seg = (k) => {
  const len = 26 + k.d * 6, { cz } = k.slab(len, { skin: 4 }, 2.6, 3.2);
  const np = 3 + Math.round(k.d * 2);
  for (let i = 0; i < np; i++) {
    const side = i % 2 ? 1 : -1, pz = cz - len / 2 + ((i + 0.7) / (np + 0.3)) * len;
    k.add('piston', side * 4.8, k.top + 0.9, pz, 1, 1, { hy: 0.9, ax: 3.4, period: 2.3 - k.d * 0.4, phase: i * 1.9 + (side > 0 ? Math.PI : 0) }, 1.8);
  }
};
const stairs: Seg = (k) => {
  const base = k.top;
  for (let i = 0; i < 5; i++) { k.top += 1.3; k.add('static', k.rand(-1.5, 1.5), k.top, k.z + 2.2 + 1.8, 3.2, 1.8, { skin: 1 }); k.z += 2.2 + 3.6; }
  k.top = base;
};

const POOLS: Record<string, Seg[]> = {
  titan: [gapJumps, spinnerField, movers, blinkTiles, pendulumAlley, bouncePads, conveyorRun, rollerRun, windTunnel, iceRink, slimeSwamp, pistonBridge, stairs],
  frost: [iceRink, windTunnel, gapJumps, blinkTiles, pendulumAlley, bouncePads, iceRink, rollerRun, stairs, movers],
};

function buildPark(mapId: string, theme: Theme, pool: Seg[], seed: number, difficulty: number, segCount: number, W: number): Course {
  const k = new Kit(seed, W, difficulty);
  // giant start stadium
  k.add('static', 0, 0, 0, W + 3, 9, { skin: 3 });
  const spawnPoints: Course['spawnPoints'] = [];
  for (let i = 0; i < 7; i++) spawnPoints.push([(i - 3) * 2.4, 0, -5 + (i % 2) * 2.2]);
  k.boxRow(6, 5); k.z = 9;
  // seeded shuffle without immediate repeats; reshuffle when the pool is exhausted
  let bag: Seg[] = [], last: Seg | null = null;
  for (let s = 0; s < segCount; s++) {
    if (!bag.length) { bag = [...pool]; for (let i = bag.length - 1; i > 0; i--) { const j = Math.floor(nextRand(k.r) * (i + 1)); [bag[i], bag[j]] = [bag[j], bag[i]]; } if (bag[bag.length - 1] === last) bag.reverse(); }
    const seg = bag.pop()!; last = seg; seg(k);
    if (s % 2 === 1) k.rest();
  }
  k.rest();
  const gz = k.z + 4 + 8;
  k.add('static', 0, k.top, gz, W + 4, 8, { hue: 5, skin: 3 });
  return { seed, platforms: k.platforms, checkpoints: k.checkpoints, boxes: k.boxes, finishZ: gz - 4, killY: -22, spawnPoints, length: gz, mapId, theme, hazards: k.hazards, zones: k.zones };
}

/**
 * Survival arena: a grid of tiles that collapse in waves from the outside in (a pure function of time, so the
 * server and every client agree). Two crossing sweeper bars in the middle. Falling = out. Shove people off!
 */
function buildArena(seed: number, d: number): Course {
  const r = { rng: seed >>> 0 }, platforms: Platform[] = [], boxes: ItemBoxDef[] = [], N = 7, size = 6, pitch = size + 0.3, mid = (N - 1) / 2;
  const waves = [26, 46, 66, 86].map((t) => t * (1 - 0.22 * d)); // ring 3 (outer) collapses first, ring 0 (centre) last
  let pid = 0;
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) {
    const ring = Math.max(Math.abs(i - mid), Math.abs(j - mid));
    platforms.push({ id: pid++, kind: 'static', x: (i - mid) * pitch, y: -0.6, z: (j - mid) * pitch, hx: size / 2, hy: 0.6, hz: size / 2, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: (i + j) % 6, surface: 'normal', skin: (i + j) % 2 ? 2 : 1, vanishAt: 3 + waves[(N - 1) / 2 - ring] + rangeRand(r, -6, 6) });
  }
  const spawnPoints: Course['spawnPoints'] = [];
  for (let k = 0; k < 7; k++) { const a = (k / 7) * Math.PI * 2; spawnPoints.push([Math.sin(a) * 11, 0, Math.cos(a) * 11]); }
  for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + 0.2; boxes.push({ id: k, x: Math.sin(a) * 7, y: 1.1, z: Math.cos(a) * 7 }); }
  const hazards: CourseHazard[] = [
    { id: 0, kind: 'spinner', x: 0, y: 0.5, z: 0, len: 40, radius: 0.35, speed: 0.8 + 0.5 * d, period: 1, phase: 0, dir: 1 },
    { id: 1, kind: 'spinner', x: 0, y: 0.5, z: 0, len: 20, radius: 0.35, speed: 1.3 + 0.5 * d, period: 1, phase: 1, dir: -1 },
  ];
  return { seed, platforms, checkpoints: [{ z: -1000, spawn: [0, 0, 0] }], boxes, finishZ: 1e9, killY: -16, spawnPoints, length: 60, mapId: 'platform-panic', survival: true, theme: 'sunny', hazards, zones: [] };
}

export const MAPS: Record<string, MapDef> = {
  'neon-circuit': { id: 'neon-circuit', name: 'Neon Circuit', desc: 'Piattaforme sospese nello spazio. Veloce e tecnica.', theme: 'neon', kind: 'race', build: (seed, d) => buildCourse(seed, d, 4 + Math.round(d / 0.35)) },
  'titan-gauntlet': { id: 'titan-gauntlet', name: 'Titan Gauntlet', desc: 'Un parco giochi gigante: barre rotanti, martelli, rulli, trampolini, vento e pavimenti che spariscono.', theme: 'sunny', kind: 'race', build: (seed, d) => buildPark('titan-gauntlet', 'sunny', POOLS.titan, seed, d, 9 + Math.round(d * 3), 8) },
  'frost-run': { id: 'frost-run', name: 'Frost Run', desc: 'Pista ghiacciata: derapate, bufere laterali e pendoli.', theme: 'frost', kind: 'race', build: (seed, d) => buildPark('frost-run', 'frost', POOLS.frost, seed, d, 7 + Math.round(d * 3), 7) },
  'platform-panic': { id: 'platform-panic', name: 'Platform Panic', desc: 'Arena a tessere che crollano dall\'esterno: spingi gli altri giù, resta in piedi!', theme: 'sunny', kind: 'survival', build: buildArena },
};
export const MAP_IDS = Object.keys(MAPS);
export const RACE_MAP_IDS = MAP_IDS.filter((id) => MAPS[id].kind === 'race');
export const SURVIVAL_MAP_IDS = MAP_IDS.filter((id) => MAPS[id].kind === 'survival');

export function buildMap(mapId: string, seed: number, difficulty: number): Course {
  const m = MAPS[mapId] ?? MAPS['neon-circuit'];
  return m.build(seed, difficulty);
}
/** Legacy helper (Neon Circuit, difficulty by round). */
export function courseForRound(seed: number, round: number): Course { return buildMap('neon-circuit', seed, Math.min(1, round * 0.35)); }
