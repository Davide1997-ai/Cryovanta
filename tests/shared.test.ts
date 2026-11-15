import { describe, expect, it } from 'vitest';
import {
  BODY_HEIGHT, DT, Match, NEUTRAL_INPUT, RaceSim, TICK_RATE, TUNING, botInput, courseForRound, createPlayer,
  qualifyFor, resolveImpact, rollItem, stepPlayer, type InputFrame, type PlayerState,
} from '@cryovanta/shared';

const course = courseForRound(1234, 0);
const mk = (slot = 0): PlayerState => { const p = createPlayer(slot, course.spawnPoints[slot]); p.grounded = true; return p; };
const inp = (o: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...o });

describe('character controller', () => {
  it('is deterministic', () => {
    const a = mk(), b = mk();
    for (let t = 0; t < 300; t++) { const i = inp({ mz: 1, mx: Math.sin(t / 20), jump: t % 50 < 20 }); stepPlayer(a, i, course, t); stepPlayer(b, i, course, t); }
    expect(a).toEqual(b);
  });
  it('reaches run speed and stops with friction', () => {
    const p = mk();
    for (let t = 0; t < 60; t++) stepPlayer(p, inp({ mz: 1 }), course, t);
    expect(Math.hypot(p.vx, p.vz)).toBeCloseTo(TUNING.runSpeed, 1);
    for (let t = 60; t < 120; t++) stepPlayer(p, inp(), course, t);
    expect(Math.hypot(p.vx, p.vz)).toBeLessThan(0.01);
  });
  it('variable jump height: tap < hold, hold ≈ v²/2g', () => {
    const peak = (holdTicks: number) => {
      const p = mk(); p.x = 0; p.z = 0; let max = 0;
      for (let t = 0; t < 90; t++) { stepPlayer(p, inp({ jump: t < holdTicks }), course, t); max = Math.max(max, p.y); }
      return max;
    };
    const tap = peak(3), hold = peak(60);
    expect(tap).toBeLessThan(hold * 0.7);
    expect(hold).toBeGreaterThan(1.8); // hover burn only starts on a fresh press, so a pure hold gives the ballistic apex
    expect(hold).toBeLessThan(2.2);
  });
  it('coyote time allows a jump just after leaving a ledge, not long after', () => {
    const run = (delayTicks: number) => {
      const p = mk(); p.coyote = TUNING.coyoteTime; p.grounded = false; p.y = 0.5; p.vy = -1;
      // fake: airborne in void-free space is not needed; test the counter directly
      for (let t = 0; t < delayTicks; t++) { p.y = 5; p.vy = 0; p.coyote = Math.max(0, p.coyote - DT); }
      p.jumpBuf = 0.1; p.grounded = false; p.y = 5; p.vy = 0;
      stepPlayer(p, inp({ jump: true }), course, 0);
      return p.vy > 5;
    };
    expect(run(3)).toBe(true);
    expect(run(20)).toBe(false);
  });
  it('hover thruster extends a jump once per airtime and refuels on landing', () => {
    const p = mk();
    let hovered = false;
    for (let t = 0; t < 120; t++) {
      const air = !p.grounded;
      stepPlayer(p, inp({ jump: t === 0 || (air && t % 12 < 6) }), course, t);
      hovered ||= p.hovering;
    }
    for (let t = 120; t < 240 && !p.grounded; t++) stepPlayer(p, inp(), course, t);
    expect(hovered).toBe(true);
    expect(p.hoverFuel).toBeCloseTo(TUNING.hoverFuel, 2);
  });
  it('falling below killY starts respawn at the last checkpoint', () => {
    const p = mk(); p.checkpoint = 1; p.x = 40; p.y = course.killY - 1; p.z = 20;
    stepPlayer(p, inp(), course, 0);
    expect(p.respawn).toBeGreaterThan(0);
    for (let t = 0; t < TICK_RATE * 2; t++) stepPlayer(p, inp(), course, t);
    expect(p.respawn).toBe(0);
    expect(p.y).toBeGreaterThan(course.killY);
    expect(p.invuln).toBeGreaterThan(0);
  });
  it('never tunnels through a platform at terminal velocity', () => {
    const p = mk(); p.y = 20; p.x = 0; p.z = 0; p.vy = -30;
    for (let t = 0; t < 120; t++) stepPlayer(p, inp(), course, t);
    expect(p.y).toBeGreaterThanOrEqual(-1e-3); expect(p.grounded).toBe(true);
    expect(BODY_HEIGHT).toBeGreaterThan(0);
  });
});

describe('impact resolution', () => {
  const src = { kind: 'seeker' as const, owner: 1, x: 0, y: 0, z: -2, vx: 0, vz: 19 };
  it('seeker hits: knockback, stun, i-frames', () => {
    const t = mk(0); t.boost = 1;
    const r = resolveImpact(src, t);
    expect(r).toEqual({ outcome: 'hit', consumeSource: true });
    expect(t.stun).toBeGreaterThan(1); expect(t.invuln).toBeGreaterThan(1); expect(t.boost).toBe(0); expect(t.vz).toBeGreaterThan(5);
  });
  it('shield absorbs one hit then grants a grace window', () => {
    const t = mk(0); t.shield = 5;
    expect(resolveImpact(src, t).outcome).toBe('blocked');
    expect(t.shield).toBe(0); expect(t.stun).toBe(0);
    expect(resolveImpact(src, t).outcome).toBe('ignored'); // inside grace
  });
  it('i-frames let projectiles pass through (source NOT consumed)', () => {
    const t = mk(0); t.invuln = 1;
    expect(resolveImpact(src, t)).toEqual({ outcome: 'ignored', consumeSource: false });
  });
  it('boosting robot smashes hazards without stun', () => {
    const t = mk(0); t.boost = 1.5;
    const r = resolveImpact({ kind: 'hazard', owner: 1, x: 0, y: 0, z: 0, vx: 0, vz: 0 }, t);
    expect(r.outcome).toBe('smashed'); expect(t.stun).toBe(0); expect(t.boost).toBeCloseTo(0.525);
  });
  it('a robot is never hit by its own seeker/dive, but can trip on its own hazard', () => {
    const t = mk(1);
    expect(resolveImpact(src, t).outcome).toBe('ignored');
    expect(resolveImpact({ ...src, kind: 'hazard' }, t).outcome).toBe('hit');
  });
  it('respawning / finished robots are untouchable', () => {
    const a = mk(0); a.respawn = 1; const b = mk(0); b.finishRank = 1;
    expect(resolveImpact(src, a).outcome).toBe('ignored'); expect(resolveImpact(src, b).outcome).toBe('ignored');
  });
});

describe('item roll (rubber-banding)', () => {
  it('leader gets mostly traps/defence, last place mostly attacks', () => {
    const count = (frac: number) => { const w = { rng: 42 }; const c: Record<string, number> = {}; for (let i = 0; i < 4000; i++) { const k = rollItem(w, frac); c[k] = (c[k] ?? 0) + 1; } return c; };
    const lead = count(0), last = count(1);
    expect(last.seeker).toBeGreaterThan(lead.seeker * 5);
    expect(lead.hazard).toBeGreaterThan(last.hazard * 2);
  });
});

describe('race sim', () => {
  it('uses fixed 60Hz ticks', () => expect(TICK_RATE).toBe(60));
  it('qualification schedule for 7 players: 4 -> 2 -> 1', () => {
    expect([qualifyFor(7), qualifyFor(4), qualifyFor(2), qualifyFor(1)]).toEqual([4, 2, 1, 1]);
  });
  it('seeker homes on the racer ahead and knocks them down', () => {
    const sim = new RaceSim({ seed: 5, round: 0, participants: [0, 1], qualify: 1, mapId: 'neon-circuit', difficulty: 0, boxRespawn: 4 });
    sim.phase = 'running';
    const [lead, chaser] = [sim.players[0], sim.players[1]];
    lead.z = 20; lead.y = 0; lead.x = 0; chaser.z = 10; chaser.x = 0; chaser.y = 0; chaser.item = 'seeker'; chaser.yaw = 0;
    // give both a floor
    sim.course.platforms.push({ id: 999, kind: 'static', x: 0, y: -0.5, z: 15, hx: 10, hy: 0.5, hz: 20, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: 0 });
    sim.step([]); // let standings settle (chaser is behind the leader)
    const frames: InputFrame[] = [];
    frames[1] = inp({ use: true });
    sim.step(frames);
    expect(sim.seekers).toHaveLength(1);
    expect(sim.seekers[0].target).toBe(0);
    let hit = false;
    for (let t = 0; t < 240 && !hit; t++) { sim.step([]); hit = sim.events.some((e) => e.t === 'impact' && e.victim === 0); }
    expect(hit).toBe(true);
    expect(lead.stun).toBeGreaterThan(0);
    expect(sim.seekers).toHaveLength(0);
  });
  it('hazard drop lands on the track, arms, then trips a follower (not the owner right away)', () => {
    const sim = new RaceSim({ seed: 5, round: 0, participants: [0, 1], qualify: 1, mapId: 'neon-circuit', difficulty: 0, boxRespawn: 4 });
    sim.phase = 'running';
    const [a, b] = [sim.players[0], sim.players[1]];
    a.x = 0; a.z = 0; a.yaw = 0; a.item = 'hazard'; b.x = 0; b.z = -6;
    sim.step([inp({ use: true })]);
    expect(sim.hazards).toHaveLength(1);
    let tripped = -1;
    for (let t = 0; t < 120; t++) {
      sim.step([inp({ mz: 1 }), inp({ mz: 1 })]);
      const e = sim.events.find((x) => x.t === 'impact'); if (e && e.t === 'impact') { tripped = e.victim; break; }
    }
    expect(tripped).toBe(1);
  });
  it('item cap: cannot spam more than 2 live seekers', () => {
    const sim = new RaceSim({ seed: 5, round: 0, participants: [0, 1], qualify: 1, mapId: 'neon-circuit', difficulty: 0, boxRespawn: 4 });
    sim.phase = 'running';
    const a = sim.players[0];
    for (let i = 0; i < 5; i++) { a.item = 'seeker'; a.useHeld = false; sim.step([inp({ use: true })]); }
    expect(sim.seekers.length).toBeLessThanOrEqual(2);
  });
});

describe('course reachability (bot must finish every round difficulty)', () => {
  for (const round of [0, 1, 2]) {
    it(`bot completes round ${round}`, () => {
      const sim = new RaceSim({ seed: 99 + round, round, participants: [0], qualify: 1, mapId: 'neon-circuit', difficulty: Math.min(1, round * 0.35), boxRespawn: 4 });
      let seq = 0;
      for (let t = 0; t < TICK_RATE * 240 && sim.phase !== 'ended'; t++) {
        const p = sim.players[0];
        sim.step([botInput(p, sim.course, sim.tick, ++seq)]);
      }
      expect(sim.players[0].finishRank, `stuck at z=${sim.players[0].z.toFixed(1)} of ${sim.course.finishZ.toFixed(1)}`).toBe(1);
    });
  }
});

describe('course generator regression sweep', () => {
  it('a naive bot (no short hops) still clears >= 70% of random seeds on rounds 0 and 2', () => {
    let ok = 0, total = 0;
    for (let seed = 1; seed <= 40; seed++) for (const round of [0, 2]) {
      const sim = new RaceSim({ seed: seed * 31, round, participants: [0], qualify: 1, mapId: 'neon-circuit', difficulty: Math.min(1, round * 0.35), boxRespawn: 4 });
      let seq = 0;
      for (let t = 0; t < TICK_RATE * 200 && sim.phase !== 'ended'; t++) sim.step([botInput(sim.players[0], sim.course, sim.tick, ++seq)]);
      total++; if (sim.players[0].finishRank > 0) ok++;
    }
    expect(ok / total).toBeGreaterThanOrEqual(0.7);
  });
});

describe('match flow', () => {
  it('7 bots: 7 -> 4 -> 2 -> 1 winner', () => {
    const m = new Match([0, 1, 2, 3, 4, 5, 6], 777);
    const sizes: number[] = [];
    let last = -1, seq = 0;
    for (let t = 0; t < TICK_RATE * 60 * 12 && m.phase !== 'over'; t++) {
      if (m.phase === 'round' && m.roundIdx !== last) { last = m.roundIdx; sizes.push(m.survivors.length); }
      const inputs: (InputFrame | undefined)[] = [];
      if (m.phase === 'round') for (const p of m.sim.players) if (p.alive) inputs[p.slot] = botInput(p, m.sim.course, m.sim.tick, ++seq, { useItems: true });
      m.step(inputs);
    }
    expect(m.phase).toBe('over');
    expect(sizes).toEqual([7, 4, 2]);
    expect(m.winner).toBeGreaterThanOrEqual(0);
    expect(m.standings()).toHaveLength(7);
    expect(m.standings()[0]).toBe(m.winner);
  });
  it('leaving down to one player ends the match with a winner', () => {
    const m = new Match([0, 1], 1);
    m.removePlayer(1);
    expect(m.phase).toBe('over'); expect(m.winner).toBe(0);
  });
});
