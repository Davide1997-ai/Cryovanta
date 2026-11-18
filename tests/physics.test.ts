import { describe, expect, it } from 'vitest';
import { DT, buildMap, createPlayer, platformCenter, stepPlayer, type InputFrame } from '../packages/shared/src';

const NO: Omit<InputFrame, 'seq'> = { mx: 0, mz: 0, jump: false, dive: false, use: false, push: false, grab: false };
const movers = () => buildMap('neon-circuit', 7, 0.6).platforms.filter((p) => p.kind === 'mover');
const vel = (m: ReturnType<typeof movers>[number], t: number) => { const a = { x: 0, y: 0, z: 0 }, b = { x: 0, y: 0, z: 0 }; platformCenter(m, t, a); platformCenter(m, t - 1, b); return (a.x - b.x) / DT; };

describe('moving platforms', () => {
  it('a robot standing still stays glued to a moving deck (no sink, no float, no drift)', () => {
    const c = buildMap('neon-circuit', 7, 0.6), cc = { x: 0, y: 0, z: 0 };
    for (const m of movers()) {
      platformCenter(m, 0, cc);
      const p = createPlayer(0, [cc.x, cc.y + m.hy + 0.01, cc.z]); p.grounded = true; p.platformId = m.id;
      let air = 0, worst = 0, seq = 0;
      for (let t = 1; t < 1200; t++) {
        stepPlayer(p, { seq: ++seq, ...NO }, c, t); platformCenter(m, t, cc);
        if (!p.grounded) air++; worst = Math.max(worst, Math.abs(p.y - (cc.y + m.hy)), Math.abs(p.x - cc.x) > m.hx ? 9 : 0);
      }
      expect(air).toBeLessThanOrEqual(1); expect(worst).toBeLessThan(0.02);
    }
  });

  it('jumping from a mover keeps its momentum, so you land back on it instead of being left behind', () => {
    const c = buildMap('neon-circuit', 7, 0.6), cc = { x: 0, y: 0, z: 0 };
    for (const m of movers().slice(0, 4)) {
      platformCenter(m, 0, cc);
      const p = createPlayer(0, [cc.x, cc.y + m.hy + 0.01, cc.z]); p.grounded = true; p.platformId = m.id;
      let t = 1, seq = 0;
      for (; t < 40; t++) stepPlayer(p, { seq: ++seq, ...NO }, c, t);
      while (Math.abs(vel(m, t)) < 3.5 && t < 400) { stepPlayer(p, { seq: ++seq, ...NO }, c, t); t++; } // wait for the deck to be moving fast
      const relBefore = p.x - (platformCenter(m, t, cc), cc.x), v0 = vel(m, t);
      stepPlayer(p, { seq: ++seq, ...NO, jump: true }, c, t++);
      expect(Math.sign(p.vx)).toBe(Math.sign(v0)); expect(Math.abs(p.vx)).toBeGreaterThan(Math.abs(v0) * 0.6);
      let landed = false;
      for (let k = 0; k < 120 && !landed; k++, t++) { stepPlayer(p, { seq: ++seq, ...NO }, c, t); landed = p.grounded && k > 5; }
      expect(landed).toBe(true); expect(p.platformId).toBe(m.id);
      platformCenter(m, t, cc);
      expect(Math.abs(p.x - cc.x - relBefore)).toBeLessThan(1.3); // without inheritance the drift was ~4u
    }
  });

  it('inherited momentum is cleared on landing and on respawn', () => {
    const c = buildMap('neon-circuit', 7, 0.6), m = movers()[0], cc = { x: 0, y: 0, z: 0 }; platformCenter(m, 0, cc);
    const p = createPlayer(0, [cc.x, cc.y + m.hy + 0.01, cc.z]); p.grounded = true; p.platformId = m.id; p.ivx = 5;
    for (let t = 1; t < 6; t++) stepPlayer(p, { seq: t, ...NO }, c, t);
    expect(p.grounded).toBe(true); expect(p.ivx).toBe(0);
  });
});
