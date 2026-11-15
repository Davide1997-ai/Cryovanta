import { describe, expect, it } from 'vitest';
import {
  DT, Match, NEUTRAL_INPUT, RaceSim, TICK_RATE, TUNING as T, buildMap, createPlayer, parseInputFrames, stepPlayer, type Course, type InputFrame, type Platform, type PlayerState,
} from '@cryovanta/shared';

const plat = (o: Partial<Platform> = {}): Platform => ({ id: 0, kind: 'static', x: 0, y: -0.5, z: 0, hx: 30, hy: 0.5, hz: 30, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: 0, ...o });
const sim2 = (extra: Partial<Course> = {}) => {
  const sim = new RaceSim({ seed: 1, round: 0, participants: [0, 1, 2], qualify: 2, mapId: 'neon-circuit', difficulty: 0, boxRespawn: 4 });
  sim.phase = 'running'; sim.course.platforms.length = 0; sim.course.platforms.push(plat()); sim.course.hazards = []; Object.assign(sim.course, extra);
  for (const p of sim.players) { p.y = 0; p.grounded = true; p.vx = p.vz = 0; p.invuln = 0; }
  const [a, b, c] = sim.players; a.x = 0; a.z = 0; a.yaw = 0; b.x = 0; b.z = 1.4; c.x = 10; c.z = 10; // b is right in front of a
  return { sim, a, b, c };
};
const inp = (o: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...o });
const stepN = (sim: RaceSim, n: number, f: (t: number) => (InputFrame | undefined)[] = () => []) => { for (let t = 0; t < n; t++) sim.step(f(t)); };

describe('shove (push button)', () => {
  it('knocks back whoever is in front, staggers them, and respects the cooldown', () => {
    const { sim, a, b } = sim2();
    sim.step([inp({ push: true })]);
    expect(sim.events.some((e) => e.t === 'impact' && e.kind === 'shove' && e.victim === 1 && e.outcome === 'hit')).toBe(true);
    expect(b.vz).toBeGreaterThan(8); expect(b.stun).toBeGreaterThan(0.3); expect(a.pushCd).toBeGreaterThan(0.5);
    // spamming does nothing during the cooldown
    b.stun = 0; b.invuln = 0; b.z = 1.4; b.vz = 0; sim.step([inp({ push: false })]); sim.step([inp({ push: true })]);
    expect(sim.events.some((e) => e.t === 'impact')).toBe(false);
  });
  it('misses people behind you or too far; a shield absorbs it; shoving a ledge-walker drops them', () => {
    const { sim, a, b } = sim2(); b.z = -1.4; sim.step([inp({ push: true })]); expect(sim.events.some((e) => e.t === 'impact')).toBe(false);
    const s2 = sim2(); s2.b.z = 4; s2.sim.step([inp({ push: true })]); expect(s2.sim.events.some((e) => e.t === 'impact')).toBe(false);
    const s3 = sim2(); s3.b.shield = 5; s3.sim.step([inp({ push: true })]); expect(s3.sim.events.find((e) => e.t === 'impact')).toMatchObject({ outcome: 'blocked' }); expect(s3.b.stun).toBe(0);
    const s4 = sim2(); s4.sim.course.platforms[0] = plat({ hz: 2.5, z: 0 }); // pad ends at z=2.5, b stands at the edge
    s4.b.z = 2.0; s4.a.z = 0.7; s4.sim.step([inp({ push: true })]); stepN(s4.sim, 90); expect(s4.b.respawn > 0 || s4.b.y < -3).toBe(true);
  });
  it('the shove is edge-triggered (holding the button does not repeat) and the lunge is part of the predicted movement', () => {
    const p = createPlayer(0, [0, 0, 0]); p.grounded = true; const c = { ...sim2().sim.course };
    stepPlayer(p, inp({ push: true }), c, 0); expect(p.pushReq).toBe(true); expect(p.vz).toBeGreaterThan(1);
    stepPlayer(p, inp({ push: true }), c, 1); expect(p.pushReq).toBe(false);
  });
  it('input validation accepts push/grab flags and defaults them to false', () => {
    expect(parseInputFrames([{ seq: 1, mx: 0, mz: 0, push: true, grab: true }])).toEqual([{ seq: 1, mx: 0, mz: 0, jump: false, dive: false, use: false, push: true, grab: true }]);
    expect(parseInputFrames([{ seq: 1, mx: 0, mz: 0 }])![0]).toMatchObject({ push: false, grab: false });
  });
});

describe('grab, drag and throw', () => {
  it('holding grab latches onto the robot in front: they are slowed, cannot jump, and are pulled along', () => {
    const { sim, a, b } = sim2();
    stepN(sim, 10, () => [inp({ grab: true, mz: 1 }), inp({ mz: -1, jump: true })]);
    expect(a.grabTarget).toBe(1); expect(b.slow).toBeGreaterThan(0);
    // b tries to run away at full speed but is dragged along at a fraction of it
    stepN(sim, 40, () => [inp({ grab: true, mz: 1 }), inp({ mz: -1 })]);
    expect(Math.hypot(b.vx, b.vz)).toBeLessThan(T.runSpeed * 0.6);
    expect(Math.hypot(b.x - a.x, b.z - a.z)).toBeLessThan(2.2);
  });
  it('lasts at most grabMax seconds, then a cooldown; releasing the button lets go', () => {
    const { sim, a } = sim2();
    stepN(sim, Math.round((T.grabMax + 0.5) * TICK_RATE), () => [inp({ grab: true })]);
    expect(a.grabTarget).toBe(-1); expect(a.grabCd).toBeGreaterThan(1);
    const s2 = sim2(); stepN(s2.sim, 15, () => [inp({ grab: true })]); expect(s2.a.grabTarget).toBe(1); stepN(s2.sim, 3, () => [inp({ grab: false })]); expect(s2.a.grabTarget).toBe(-1);
  });
  it('pressing shove while holding someone THROWS them far', () => {
    const { sim, a, b } = sim2();
    stepN(sim, 12, () => [inp({ grab: true })]); expect(a.grabTarget).toBe(1);
    sim.step([inp({ grab: true, push: true })]);
    expect(sim.events.some((e) => e.t === 'release' && e.thrown)).toBe(true); expect(b.vz).toBeGreaterThan(10); expect(b.stun).toBeGreaterThan(0.5); expect(a.grabTarget).toBe(-1);
  });
  it('a shield stops a grab; an eliminated/respawning target is released', () => {
    const s = sim2(); s.b.shield = 4; stepN(s.sim, 10, () => [inp({ grab: true })]); expect(s.a.grabTarget).toBe(-1); expect(s.b.shield).toBe(0);
    const t = sim2(); stepN(t.sim, 10, () => [inp({ grab: true })]); expect(t.a.grabTarget).toBe(1); t.b.respawn = 1; stepN(t.sim, 2, () => [inp({ grab: true })]); expect(t.a.grabTarget).toBe(-1);
  });
});

describe('ramming', () => {
  it('running into someone at speed staggers them; walking into them only pushes softly', () => {
    const fast = sim2(); fast.a.vz = 9; fast.b.z = 0.7; fast.sim.step([inp({ mz: 1 })]);
    expect(fast.sim.events.some((e) => e.t === 'impact' && e.kind === 'bump')).toBe(true); expect(fast.b.stun).toBeGreaterThan(0.2);
    const slow = sim2(); slow.a.vz = 2; slow.b.z = 0.7; slow.sim.step([inp()]);
    expect(slow.sim.events.some((e) => e.t === 'impact' && e.kind === 'bump')).toBe(false); expect(slow.b.stun).toBe(0);
  });
});

describe('survival arena (Platform Panic)', () => {
  const arena = () => { const sim = new RaceSim({ seed: 4, round: 0, participants: [0, 1, 2, 3], qualify: 1, mapId: 'platform-panic', difficulty: 0.4, boxRespawn: 3 }); return sim; };
  it('has no finish line, spawns everyone on tiles, and collapses outside-in deterministically', () => {
    const c = buildMap('platform-panic', 4, 0.4); expect(c.survival).toBe(true); expect(c.finishZ).toBeGreaterThan(1e6);
    const t = (x: number, z: number) => c.platforms.find((p) => Math.abs(p.x - x) < 1 && Math.abs(p.z - z) < 1)!.vanishAt!;
    expect(t(18.9, 18.9)).toBeLessThan(t(0, 0)); expect(JSON.stringify(buildMap('platform-panic', 4, 0.4))).toBe(JSON.stringify(c));
    for (const s of c.spawnPoints) expect(c.platforms.some((p) => Math.abs(s[0] - p.x) <= p.hx && Math.abs(s[2] - p.z) <= p.hz)).toBe(true);
  });
  it('falling is final (no respawn) and the last robot standing wins', () => {
    const sim = arena(); sim.phase = 'running';
    for (const p of sim.players) if (p.alive) { p.y = 0; p.grounded = true; }
    sim.players[2].y = -30; sim.step([]); expect(sim.players[2].alive).toBe(false); expect(sim.events.some((e) => e.t === 'out' && e.slot === 2)).toBe(true);
    sim.players[1].y = -30; sim.step([]); sim.players[3].y = -30; stepN(sim, 3);
    expect(sim.phase).toBe('ended'); expect(sim.result!.qualified).toEqual([0]);
    expect(sim.result!.eliminated).toEqual([3, 1, 2]); // best (died last) first
  });
  it('tiles that collapsed are no longer solid', () => {
    const sim = arena(); sim.phase = 'running'; const outer = sim.course.platforms.find((p) => Math.abs(p.x) > 18 && Math.abs(p.z) > 18)!;
    const p = createPlayer(0, [outer.x, 0, outer.z]); p.grounded = true;
    stepPlayer(p, NEUTRAL_INPUT, sim.course, 10); expect(p.grounded).toBe(true);
    const late = Math.ceil((outer.vanishAt! + 0.2) / DT); for (let i = 0; i < 40; i++) stepPlayer(p, NEUTRAL_INPUT, sim.course, late + i); expect(p.y).toBeLessThan(-0.5);
  });
  it('the arena mode only plays survival maps and race modes never get one', () => {
    const m = new Match([0, 1, 2], 9, { mode: 'arena', map: 'titan-gauntlet' }); expect(m.setupFor(0).mapId).toBe('platform-panic');
    const e = new Match([0, 1, 2], 9, { mode: 'elimination', map: 'platform-panic' }); expect(e.setupFor(0).mapId).not.toBe('platform-panic');
  });
  it('a full arena match ends with one winner and a complete ranking', () => {
    const m = new Match([0, 1, 2, 3, 4, 5, 6], 21, { mode: 'arena', map: 'random' }); let guard = 0;
    while (m.phase !== 'over' && guard++ < TICK_RATE * 200) m.step([]);
    expect(m.phase).toBe('over'); expect(m.standings()).toHaveLength(7); expect(m.winner).toBe(m.standings()[0]);
  });
});
