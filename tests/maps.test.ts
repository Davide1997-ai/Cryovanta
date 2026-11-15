import { describe, expect, it } from 'vitest';
import {
  DT, MAPS, MAP_IDS, MODE_IDS, Match, NEUTRAL_INPUT, RaceSim, TICK_RATE, TUNING, botInput, buildMap, createPlayer, hazardHit, hazardPose,
  stepPlayer, type Course, type InputFrame, type Platform, type PlayerState,
} from '@cryovanta/shared';

const plat = (o: Partial<Platform> = {}): Platform => ({ id: 0, kind: 'static', x: 0, y: -0.5, z: 0, hx: 20, hy: 0.5, hz: 60, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: 0, ...o });
const flat = (o: Partial<Platform> = {}, extra: Partial<Course> = {}): Course => ({
  seed: 1, platforms: [plat(o)], checkpoints: [{ z: -100, spawn: [0, 0, 0] }], boxes: [], finishZ: 999, killY: -20,
  spawnPoints: Array.from({ length: 7 }, () => [0, 0, 0] as [number, number, number]), length: 100, mapId: 't', theme: 'neon', hazards: [], zones: [], ...extra,
});
const mk = (c: Course): PlayerState => { const p = createPlayer(0, [0, 0, -10]); p.grounded = true; return p; };
const inp = (o: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...o });
const run = (p: PlayerState, c: Course, ticks: number, i: InputFrame, t0 = 0) => { for (let t = 0; t < ticks; t++) stepPlayer(p, i, c, t0 + t); };

describe('surfaces', () => {
  it('ice: slow to accelerate and slow to stop (slides)', () => {
    const grip = mk(flat()), ice = mk(flat({ surface: 'ice' }));
    const cg = flat(), ci = flat({ surface: 'ice' });
    run(grip, cg, 20, inp({ mz: 1 })); run(ice, ci, 20, inp({ mz: 1 }));
    expect(ice.vz).toBeLessThan(grip.vz * 0.6);
    run(grip, cg, 60, inp({ mz: 1 })); run(ice, ci, 60, inp({ mz: 1 }));
    const g0 = grip.z, i0 = ice.z;
    run(grip, cg, 30, inp()); run(ice, ci, 30, inp());
    expect(ice.z - i0, 'ice slides further after letting go').toBeGreaterThan((grip.z - g0) * 3);
  });
  it('conveyor carries a standing robot along the belt', () => {
    const c = flat({ surface: 'conveyor', flowZ: -5 }); const p = mk(c); p.z = 10;
    run(p, c, 10, inp()); const z0 = p.z; run(p, c, 60, inp());
    expect(p.z - z0).toBeCloseTo(-5, 0);
  });
  it('bounce pad launches the robot on landing', () => {
    const c = flat({ surface: 'bounce' }); const p = mk(c); p.y = 3; p.vy = -5;
    let launched = false; for (let t = 0; t < 60 && !launched; t++) { stepPlayer(p, inp(), c, t); launched = p.vy >= TUNING.bounceVelocity - 1; }
    expect(launched).toBe(true); expect(p.grounded).toBe(false);
  });
  it('slime slows running and jumping', () => {
    const n = mk(flat()), s = mk(flat({ surface: 'slime' }));
    run(n, flat(), 40, inp({ mz: 1 })); run(s, flat({ surface: 'slime' }), 40, inp({ mz: 1 }));
    expect(s.vz).toBeCloseTo(TUNING.runSpeed * TUNING.slimeSpeedMul, 0);
    expect(n.vz).toBeCloseTo(TUNING.runSpeed, 0);
  });
  it('blink tiles are solid only part of the cycle (robot falls through when off)', () => {
    const c = flat({ kind: 'blink', period: 2, duty: 0.5, phase: 0, hx: 5, hz: 5 }); const p = mk(c); p.z = 0;
    run(p, c, 30, inp(), 0); expect(p.grounded).toBe(true);            // t in [0, 0.5s): solid
    run(p, c, 60, inp(), 60); expect(p.y).toBeLessThan(-1);             // t in [1s, 2s): gone => falling
  });
  it('wind zones push only while active and only inside the box', () => {
    const c = flat({}, { zones: [{ x: 0, y: 1, z: 0, hx: 5, hy: 3, hz: 5, fx: 20, fz: 0, period: 4, duty: 0.5, phase: 0 }] });
    const p = mk(c); p.z = 0; run(p, c, 30, inp(), 0); const on = p.x;
    const q = mk(c); q.z = 0; run(q, c, 30, inp(), 150); // t = 2.5s => off half of the cycle
    expect(on, 'drifted ~3u in 0.5s').toBeGreaterThan(2); expect(Math.abs(q.x)).toBeLessThan(0.1);
    const air = mk(c); air.z = 0; air.y = 3; air.grounded = false; run(air, c, 20, inp(), 0); expect(air.x, 'airborne robots are blown too').toBeGreaterThan(1.5);
  });
  it('everything stays deterministic with surfaces + hazards', () => {
    const c = buildMap('titan-gauntlet', 5, 0.5); const a = createPlayer(0, c.spawnPoints[0]), b = createPlayer(0, c.spawnPoints[0]);
    for (let t = 0; t < 600; t++) { const i = inp({ mz: 1, mx: Math.sin(t / 30), jump: t % 40 < 15 }); stepPlayer(a, i, c, t); stepPlayer(b, i, c, t); }
    expect(a).toEqual(b);
  });
});

describe('giant hazards', () => {
  const spin = { id: 0, kind: 'spinner' as const, x: 0, y: 0.5, z: 0, len: 10, radius: 0.32, speed: 1, period: 1, phase: 0, dir: 1 };
  it('spinner: hits on the bar, misses beside it, rotates with time', () => {
    expect(hazardHit(spin, 0, 3, 0, 0.2)).not.toBeNull();
    expect(hazardHit(spin, 0, 3, 0, 3)).toBeNull();
    const q = Math.round((Math.PI / 2) / DT); // quarter turn later the bar lies along z
    expect(hazardHit(spin, q, 3, 0, 0.2)).toBeNull(); expect(hazardHit(spin, q, 0.2, 0, 3)).not.toBeNull();
    expect(hazardHit(spin, 0, 3, 3, 0.2), 'jumping over the bar works').toBeNull();
  });
  it('pendulum head is lethal at the bottom of the swing only near it', () => {
    const h = { id: 0, kind: 'pendulum' as const, x: 0, y: 7.2, z: 0, len: 6.6, radius: 0.9, speed: 0.95, period: 2.7, phase: 0, dir: 1, axis: 'x' as const };
    expect(hazardHit(h, 0, 0, 0.1, 0)).not.toBeNull();   // swing angle 0 => head at (0, 0.6, 0)
    expect(hazardHit(h, 0, 4, 0.1, 0)).toBeNull();
    expect(hazardPose(h, 0).y).toBeCloseTo(0.6, 1);
  });
  it('roller: knocks back toward -z, only within its width', () => {
    const h = { id: 0, kind: 'roller' as const, x: 0, y: 0.85, z: 20, len: 30, radius: 0.85, halfWidth: 6, speed: 0, period: 4, phase: 0, dir: -1 };
    const hit = hazardHit(h, 0, 0, 0, 20); expect(hit?.dz).toBe(-1);
    expect(hazardHit(h, 0, 9, 0, 20)).toBeNull();
    const half = Math.round(2 / DT); expect(hazardPose(h, half).z).toBeCloseTo(5, 0);
  });
  it('sim: a spinner knocks a robot down (impact event, stun), shield blocks it', () => {
    const run1 = (shield: number) => {
      const sim = new RaceSim({ seed: 1, round: 0, participants: [0], qualify: 1, mapId: 'neon-circuit', difficulty: 0, boxRespawn: 4 });
      sim.phase = 'running'; sim.course.hazards.push({ ...spin, z: 0, y: 0.5 });
      const p = sim.players[0]; p.x = 3; p.z = 0.1; p.y = 0; p.shield = shield;
      let ev = ''; for (let t = 0; t < 2; t++) { sim.step([]); const e = sim.events.find((x) => x.t === 'impact'); if (e && e.t === 'impact') ev = e.kind + ':' + e.outcome; }
      return { ev, stun: p.stun };
    };
    expect(run1(0).ev).toBe('obstacle:hit'); expect(run1(0).stun).toBeGreaterThan(0.5);
    expect(run1(5).ev).toBe('obstacle:blocked');
  });
});

describe('maps', () => {
  it('registry exposes the three maps and the four modes', () => {
    expect(MAP_IDS).toEqual(['neon-circuit', 'titan-gauntlet', 'frost-run', 'platform-panic']);
    expect(MODE_IDS).toEqual(['elimination', 'race', 'grandprix', 'arena', 'chaos']);
  });
  for (const id of MAP_IDS.filter((m) => m !== 'platform-panic')) for (const d of [0, 0.5, 1]) {
    it(`${id} @difficulty ${d}: structurally valid, deterministic, no unreachable gaps`, () => {
      for (const seed of [1, 7, 42, 1234]) {
        const c = buildMap(id, seed, d);
        expect(JSON.stringify(buildMap(id, seed, d))).toBe(JSON.stringify(c));                 // deterministic
        c.platforms.forEach((p, i) => expect(p.id).toBe(i));
        expect(c.finishZ).toBeLessThan(c.length); expect(c.mapId).toBe(id);
        for (const s of c.spawnPoints) expect(c.platforms[0].x - c.platforms[0].hx).toBeLessThan(s[0]); // spawn on start pad
        for (let i = 1; i < c.checkpoints.length; i++) expect(c.checkpoints[i].z).toBeGreaterThan(c.checkpoints[i - 1].z);
        // every checkpoint spawn and item box sits on/above some platform
        const over = (x: number, z: number, y: number) => c.platforms.some((p) => Math.abs(x - p.x) <= p.hx + p.ax && Math.abs(z - p.z) <= p.hz + p.az && Math.abs(p.y + p.hy - y) < 3);
        for (const cp of c.checkpoints.slice(1)) expect(over(cp.spawn[0], cp.spawn[2], cp.spawn[1])).toBe(true);
        for (const b of c.boxes) expect(over(b.x, b.z, b.y)).toBe(true);
        // consecutive walkable slabs along z: the void between them stays within jump/bounce reach
        const walk = c.platforms.filter((p) => p.kind !== 'piston').sort((a, b) => a.z - p2(b));
        function p2(b: Platform) { return b.z; }
        let worst = 0;
        for (let i = 0; i + 1 < walk.length; i++) { const gap = (walk[i + 1].z - walk[i + 1].hz) - (walk[i].z + walk[i].hz); if (gap > worst && gap < 40) worst = gap; }
        expect(worst, `${id} seed ${seed}: largest gap`).toBeLessThanOrEqual(5.6);
      }
    });
  }
  it('Titan Gauntlet is giant: several times longer than Neon Circuit, with dozens of hazards', () => {
    const t = buildMap('titan-gauntlet', 9, 0.5), n = buildMap('neon-circuit', 9, 0.5);
    expect(t.length).toBeGreaterThan(n.length * 2.5); expect(t.length).toBeGreaterThan(400);
    expect(t.hazards.length).toBeGreaterThanOrEqual(8); expect(t.zones.length).toBeGreaterThan(0);
    const kinds = new Set(t.hazards.map((h) => h.kind)); const surf = new Set(t.platforms.map((p) => p.surface ?? 'normal'));
    expect(kinds.size).toBeGreaterThanOrEqual(2); expect(surf.size).toBeGreaterThanOrEqual(3);
  });
  it('Titan/Frost are playable end-to-end by the sim without crashing for a full minute', () => {
    for (const id of ['titan-gauntlet', 'frost-run', 'platform-panic']) {
      const sim = new RaceSim({ seed: 3, round: 0, participants: [0, 1, 2, 3, 4, 5, 6], qualify: 4, mapId: id, difficulty: 0.6, boxRespawn: 4 });
      let seq = 0; for (let t = 0; t < TICK_RATE * 60; t++) sim.step(sim.players.map((p) => (p.alive ? botInput(p, sim.course, sim.tick, ++seq, { useItems: true }) : undefined)));
      expect(sim.players.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z))).toBe(true);
    }
  });
});

describe('modes', () => {
  const play = (mode: string, n = 7, maxMin = 25) => {
    const m = new Match(Array.from({ length: n }, (_, i) => i), 777, { mode, map: 'neon-circuit' });
    let seq = 0; const rounds: number[] = [];
    for (let t = 0; t < TICK_RATE * 60 * maxMin && m.phase !== 'over'; t++) {
      if (m.phase === 'round' && rounds[m.roundIdx] === undefined) rounds[m.roundIdx] = m.survivors.length;
      const inputs: (InputFrame | undefined)[] = [];
      if (m.phase === 'round') for (const p of m.sim.players) if (p.alive) inputs[p.slot] = botInput(p, m.sim.course, m.sim.tick, ++seq, { useItems: true });
      m.step(inputs);
    }
    return { m, rounds };
  };
  it('race: exactly one round, nobody eliminated, winner = first finisher', () => {
    const { m, rounds } = play('race');
    expect(m.phase).toBe('over'); expect(rounds).toEqual([7]); expect(m.standings()).toHaveLength(7); expect(m.standings()[0]).toBe(m.winner);
  });
  it('grandprix: 3 rounds with all players, points awarded, winner has the most points', () => {
    const { m, rounds } = play('grandprix');
    expect(m.phase).toBe('over'); expect(rounds).toEqual([7, 7, 7]);
    const st = m.standings(); expect(st).toHaveLength(7);
    for (let i = 0; i + 1 < st.length; i++) expect(m.points[st[i]]).toBeGreaterThanOrEqual(m.points[st[i + 1]]);
    expect(m.points.reduce((a, b) => a + b, 0)).toBe(3 * (10 + 8 + 6 + 5 + 4 + 3 + 2));
    expect(m.winner).toBe(st[0]);
  });
  it('chaos is elimination with faster item boxes', () => {
    const { m, rounds } = play('chaos'); expect(m.sim.cfg.boxRespawn).toBeLessThan(2); expect(rounds).toEqual([7, 4, 2]);
  });
  it('random map never repeats back-to-back and fixed map stays fixed', () => {
    const r = new Match([0, 1], 5, { mode: 'grandprix', map: 'random' });
    const ids = [0, 1, 2, 3].map((i) => r.setupFor(i).mapId); for (let i = 0; i + 1 < ids.length; i++) expect(ids[i]).not.toBe(ids[i + 1]); expect(ids).not.toContain('platform-panic'); // race modes never get the survival arena
    const f = new Match([0, 1], 5, { mode: 'grandprix', map: 'frost-run' }); expect([0, 1, 2].map((i) => f.setupFor(i).mapId)).toEqual(['frost-run', 'frost-run', 'frost-run']);
  });
});
