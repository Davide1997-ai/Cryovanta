import { describe, expect, it } from 'vitest';
import { DEFAULT_TILT, screenAngles, smooth, tiltToMove } from '../packages/client/src/tilt';

const deg = (r: number) => (r * 180) / Math.PI;
const N0 = { roll: 0, pitch: 0 };

describe('screenAngles', () => {
  it('flat on a table = no tilt, in any orientation', () => { for (const o of [0, 90, 180, 270]) { const a = screenAngles(0, 0, o); expect(a.roll).toBeCloseTo(0); expect(a.pitch).toBeCloseTo(0); } });
  it('portrait: right edge down (gamma>0) = roll right', () => { const a = screenAngles(0, 30, 0); expect(deg(a.roll)).toBeCloseTo(30, 0); expect(a.pitch).toBeCloseTo(0); });
  it('portrait: top edge toward the floor (beta<0) = pitch forward', () => { expect(deg(screenAngles(-20, 0, 0).pitch)).toBeCloseTo(20, 0); });
  it('landscape-primary (90°): the landscape RIGHT edge is the device bottom; lowering it = roll right', () => { const a = screenAngles(30, 0, 90); expect(deg(a.roll)).toBeCloseTo(30, 0); expect(a.pitch).toBeCloseTo(0); });
  it('landscape-primary: lowering the landscape TOP edge (= device right side) = pitch forward', () => { expect(deg(screenAngles(0, 25, 90).pitch)).toBeCloseTo(25, 0); });
  it('landscape-secondary (270°) mirrors the signs so the gesture means the same thing', () => {
    expect(deg(screenAngles(-30, 0, 270).roll)).toBeCloseTo(30, 0); expect(deg(screenAngles(0, -25, 270).pitch)).toBeCloseTo(25, 0);
  });
  it('heading (alpha) does not matter: function does not take it', () => expect(screenAngles.length).toBe(3));
});

describe('tiltToMove', () => {
  it('dead-zone: tiny hand tremor produces exactly zero', () => { expect(tiltToMove({ roll: 0.03, pitch: -0.02 }, N0)).toEqual({ x: 0, y: 0 }); });
  it('full tilt gives magnitude 1 (clamped), never more', () => { const v = tiltToMove({ roll: 1.2, pitch: 1.2 }, N0); expect(Math.hypot(v.x, v.y)).toBeCloseTo(1, 5); });
  it('direction is preserved (right+forward stays diagonal)', () => { const v = tiltToMove({ roll: 0.3, pitch: 0.3 }, N0); expect(v.x).toBeCloseTo(v.y, 5); expect(v.x).toBeGreaterThan(0); });
  it('response is monotonic and finer near the centre (curve > 1)', () => {
    const mags = [0.08, 0.15, 0.25, 0.35, 0.45].map((r) => Math.hypot(...Object.values(tiltToMove({ roll: r, pitch: 0 }, N0))));
    for (let i = 1; i < mags.length; i++) expect(mags[i]).toBeGreaterThan(mags[i - 1]);
    const mid = Math.hypot(...Object.values(tiltToMove({ roll: (DEFAULT_TILT.max + DEFAULT_TILT.dead) / 2, pitch: 0 }, N0)));
    expect(mid).toBeLessThan(0.5); // half-way tilt is less than half speed
  });
  it('calibration: holding the phone at a comfortable angle is "stopped"', () => {
    const hold = screenAngles(50, 5, 90); expect(tiltToMove(hold, hold)).toEqual({ x: 0, y: 0 });
    const lean = screenAngles(50 + 20, 5, 90); expect(tiltToMove(lean, hold).x).toBeGreaterThan(0.3); // tilt right from there => right
  });
  it('left/back tilts are negative', () => { const v = tiltToMove({ roll: -0.4, pitch: -0.4 }, N0); expect(v.x).toBeLessThan(0); expect(v.y).toBeLessThan(0); });
});

describe('smooth', () => {
  it('converges, is rate-independent', () => {
    let a = 0; for (let i = 0; i < 60; i++) a = smooth(a, 1, 1 / 60); let b = 0; for (let i = 0; i < 30; i++) b = smooth(b, 1, 1 / 30);
    expect(Math.abs(a - b)).toBeLessThan(1e-9); expect(a).toBeGreaterThan(0.99);
  });
});
