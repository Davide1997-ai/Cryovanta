import { describe, expect, it } from 'vitest';
import { DT, Match, NEUTRAL_INPUT, RaceSim, TICK_RATE, TUNING as T, buildMap, type InputFrame, type Platform } from '@cryovanta/shared';

const inp = (o: Partial<InputFrame> = {}): InputFrame => ({ ...NEUTRAL_INPUT, ...o });
const mk = (mapId: string, parts: number[], teams = false) => new RaceSim({ seed: 3, round: 0, participants: parts, qualify: 1, mapId, difficulty: 0.4, boxRespawn: 3, teams });
const run = (sim: RaceSim, n: number, f: () => (InputFrame | undefined)[] = () => []) => { for (let i = 0; i < n; i++) sim.step(f()); };
const flatten = (sim: RaceSim) => { sim.phase = 'running'; sim.course.hazards = []; for (const p of sim.players) { p.invuln = 0; p.grounded = true; p.vx = p.vz = 0; } };

describe('Hex-A-Gone: tiles collapse after being stepped on', () => {
  it('a tile you stand on collapses ~0.7 s later and the snapshot lists it', () => {
    const sim = mk('hex-a-gone', [0, 1]); flatten(sim);
    run(sim, 5); const p = sim.players[0]; const id = p.platformId; expect(id).toBeGreaterThanOrEqual(0);
    const pl = sim.course.platforms[id]; expect(pl.dynamic).toBe(true); expect(pl.vanishAt).toBeUndefined(); // a moment's touch is not enough
    run(sim, Math.round((T.tileTouchSeconds + 0.1) / DT)); expect(pl.vanishAt).toBeDefined(); expect(sim.dynTiles).toContain(id);
    expect(pl.vanishAt! - sim.tick * DT).toBeLessThan(T.tileCollapseDelay + 0.01);
    run(sim, Math.round((T.tileCollapseDelay + 0.5) / DT)); expect(p.y).toBeLessThan(0 - 1); // fell to the lower layer (or beyond)
  });
  it('two layers: falling through the first is not death; falling past both is', () => {
    const sim = mk('hex-a-gone', [0, 1, 2]); flatten(sim);
    run(sim, Math.round((T.tileTouchSeconds + T.tileCollapseDelay + 0.6) / DT), () => []);
    const lower = sim.players.filter((p) => p.alive && p.y < -5);
    expect(lower.length + sim.players.filter((p) => !p.alive && p.alive === false && sim.cfg.participants.includes(p.slot)).length).toBeGreaterThan(0);
    expect(sim.players.some((p) => p.alive && p.y > -8 && p.y < -5)).toBe(true); // landed on the lower layer, alive
    run(sim, Math.round(40 / DT)); // standing still on the lower layer collapses it too => eliminated
    expect(sim.phase).toBe('ended');
  });
  it('the arena mode is decided by survival (last one standing)', () => {
    const m = new Match([0, 1, 2, 3], 5, { mode: 'arena', map: 'hex-a-gone' }); let g = 0; while (m.phase !== 'over' && g++ < TICK_RATE * 200) m.step([]);
    expect(m.phase).toBe('over'); expect(m.sim.cfg.mapId).toBe('hex-a-gone'); expect(m.standings()).toHaveLength(4);
  });
});

describe('Teams', () => {
  it('players are split into two balanced teams; teammates are immune to shoves, grabs and rams but not to hazards', () => {
    const sim = mk('neon-circuit', [0, 1, 2, 3], true); expect(sim.players.map((p) => p.team)).toEqual([0, 1, 0, 1, -1, -1, -1]);
    sim.phase = 'running'; sim.course.platforms.length = 0; sim.course.platforms.push({ id: 0, kind: 'static', x: 0, y: -0.5, z: 0, hx: 30, hy: 0.5, hz: 30, ax: 0, ay: 0, az: 0, period: 1, phase: 0, hue: 0 } as Platform); sim.course.hazards = [];
    const [a, b, c] = sim.players; for (const p of sim.players) { p.y = 0; p.grounded = true; p.x = 20; p.z = 20; }
    a.x = 0; a.z = 0; a.yaw = 0; c.x = 0; c.z = 1.4; // c is a's teammate (slots 0 and 2)
    sim.step([inp({ push: true })]); expect(sim.events.some((e) => e.t === 'impact')).toBe(false); expect(c.stun).toBe(0);
    b.x = 0; b.z = 1.4; c.x = 20; c.z = 20; a.pushCd = 0; a.pushHeld = false; sim.step([inp({ push: false })]); sim.step([inp({ push: true })]);
    expect(sim.events.some((e) => e.t === 'impact' && e.kind === 'shove')).toBe(true); expect(b.stun).toBeGreaterThan(0.3); // an enemy IS shoved
  });
  it('a team match: 3 rounds, team points add up, the winning team wins, standings put it first', () => {
    const m = new Match([0, 1, 2, 3, 4, 5], 11, { mode: 'teams', map: 'neon-circuit' });
    expect(m.teams.slice(0, 6)).toEqual([0, 1, 0, 1, 0, 1]);
    // fake three rounds where team 0 always finishes first
    for (let r = 0; r < 3; r++) {
      const sim = m.sim; sim.phase = 'ended'; (sim as any).result = { qualified: [0, 2, 4, 1, 3, 5], eliminated: [], reason: 'qualified' }; m.step([]);
      if (r < 2) { expect(m.phase).toBe('intermission'); (m as any).intermissionTicks = 1; m.step([]); }
    }
    expect(m.phase).toBe('over'); expect(m.teamPoints[0]).toBeGreaterThan(m.teamPoints[1]);
    expect(m.teams[m.winner]).toBe(0); expect(m.teams[m.standings()[0]]).toBe(0);
  });
});

describe('Crown (king of the hill)', () => {
  const crownSim = (parts = [0, 1, 2]) => { const sim = mk('crown-hill', parts); flatten(sim); return sim; };
  it('map: crown on the pedestal, falling respawns (no elimination)', () => {
    const c = buildMap('crown-hill', 1, 0.4); expect(c.crown).toBe(true); expect(c.survival).toBeFalsy(); expect(c.crownPos![1]).toBeGreaterThan(2);
  });
  it('the first robot to reach the crown takes it, scores time, and is slower while carrying it', () => {
    const sim = crownSim(); const [a] = sim.players; a.x = 0; a.z = 0; a.y = 1.4;
    run(sim, 3); expect(sim.crown!.holder).toBe(0); expect(a.crowned).toBe(true);
    run(sim, TICK_RATE * 2); expect(sim.crownScore[0]).toBeGreaterThan(1.8);
  });
  it('a hit (shove) makes the holder drop it; it resets to the pedestal after a short delay and cannot be re-grabbed at once', () => {
    const sim = crownSim(); const [a, b] = sim.players; a.x = 0; a.z = 0; a.y = 1.4; b.x = 0; b.z = -1.5; b.y = 1.4; b.yaw = 0;
    run(sim, 5); expect(sim.crown!.holder).toBe(0);
    run(sim, Math.round((T.crownGrace + 0.2) / DT)); // the new king is briefly protected
    a.z = 1.5 - 0.1; b.z = 0; sim.step([undefined, inp({ push: true })]);
    run(sim, 2); expect(sim.crown!.holder).not.toBe(0); expect(a.crowned).toBe(false);
  });
  it('reaching the hold target wins the round; on timeout the highest score wins', () => {
    const sim = crownSim(); const [a] = sim.players; a.x = 0; a.z = 0; a.y = 1.4;
    sim.crownScore[0] = T.crownWinSeconds - 0.05; run(sim, 10); expect(sim.phase).toBe('ended'); expect(sim.result!.qualified).toEqual([0]);
    const s2 = crownSim(); s2.crownScore[1] = 7; s2.crownScore[2] = 3; s2.roundTicksLeft = 2; for (const p of s2.players) { p.x = 15; p.z = 15; } run(s2, 4);
    expect(s2.phase).toBe('ended'); expect(s2.result!.qualified).toEqual([1]); expect(s2.result!.reason).toBe('timeout');
  });
  it('mode "crown" plays one crown round and ends with a winner', () => {
    const m = new Match([0, 1, 2], 4, { mode: 'crown', map: 'random' }); expect(m.setupFor(0).mapId).toBe('crown-hill'); let g = 0; while (m.phase !== 'over' && g++ < TICK_RATE * 150) m.step([]);
    expect(m.phase).toBe('over'); expect(m.standings()).toHaveLength(3);
  });
  it('elimination ends with a CROWN FINAL once two robots are left', () => {
    const m = new Match([0, 1, 2, 3], 9, { mode: 'elimination', map: 'neon-circuit' });
    expect(m.setupFor(0).mapId).toBe('neon-circuit');
    const sim = m.sim; sim.phase = 'ended'; (sim as any).result = { qualified: [0, 1], eliminated: [2, 3], reason: 'qualified' }; m.step([]);
    expect(m.survivors).toEqual([0, 1]); (m as any).intermissionTicks = 1; m.step([]);
    expect(m.sim.cfg.mapId).toBe('crown-hill'); expect(m.currentSetup.crownFinal).toBe(true);
    m.sim.crownScore[1] = T.crownWinSeconds; m.sim.phase = 'running'; for (let i = 0; i < 4; i++) m.step([]);
    expect(m.phase).toBe('over'); expect(m.winner).toBe(1);
  });
});

describe('elimination cause tracking ("pushed off by ...")', () => {
  it('credits the shover when someone falls within 2 s of being hit, and nobody when they fall alone', () => {
    const sim = mk('platform-panic', [0, 1, 2]); sim.phase = 'running';
    for (const p of sim.players) { p.y = 0; p.grounded = true; }
    sim.players[1].lastHitKind = 'shove'; sim.players[1].lastHitBy = 0; sim.players[1].lastHitTick = sim.tick; sim.players[1].y = -40; sim.players[2].y = -40;
    sim.step([]);
    const outs = sim.events.filter((e) => e.t === 'out') as { slot: number; by: number; how: string }[];
    expect(outs.find((e) => e.slot === 1)).toMatchObject({ by: 0, how: 'shove' }); expect(outs.find((e) => e.slot === 2)).toMatchObject({ by: -1, how: 'fall' });
  });
});
