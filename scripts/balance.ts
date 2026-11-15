/**
 * Headless balance simulator: plays many matches with simple bots (no network, no graphics) and reports whether
 * the numbers fall inside the target windows. Bots are NOT humans: use this to catch broken pacing, then confirm
 * with real playtests (the server logs every real match to .data/matches.jsonl -> `npm run report`).
 *   npm run balance [-- --matches=30 --players=7]
 */
import { MAPS, Match, TICK_RATE, botInput, buildMap, groundBelow, type InputFrame, type PlayerState, type RaceSim, type SimEvent } from '@cryovanta/shared';

const arg = (n: string, d: number) => Number((process.argv.find((a) => a.startsWith(`--${n}=`)) ?? '').split('=')[1] ?? d);
const MATCHES = arg('matches', 30), PLAYERS = Math.min(7, arg('players', 7));
const rnd = (() => { let s = 12345; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); })();
const F = (o: Partial<InputFrame>): InputFrame => ({ seq: 0, mx: 0, mz: 0, jump: false, dive: false, use: false, push: false, grab: false, ...o });

/** Fighter: keeps itself on the floor, hunts the nearest rival (or the crown carrier), shoves, grabs and throws. */
function fighter(sim: RaceSim, p: PlayerState, i: number, goal?: { x: number; z: number } | null, aggr = 8): InputFrame {
  const t = sim.tick, c = sim.course;
  let tx = goal?.x ?? 0, tz = goal?.z ?? 0, best: PlayerState | null = null, bd = 1e9;
  if (!goal) for (const q of sim.players) if (q !== p && q.alive && q.respawn <= 0 && (p.team < 0 || q.team !== p.team)) { const d = Math.hypot(q.x - p.x, q.z - p.z); if (d < bd) { bd = d; best = q; } }
  if (best) { tx = best.x; tz = best.z; }
  let dx = tx - p.x, dz = tz - p.z, l = Math.hypot(dx, dz) || 1; dx /= l; dz /= l;
  if (groundBelow(c, t, p.x + dx * 1.2, p.y, p.z + dz * 1.2) === null) { const cx = -p.x, cz = -p.z, cl = Math.hypot(cx, cz) || 1; dx = cx / cl; dz = cz / cl; } // do not walk off the edge
  const near = best && bd < 1.8;
  const step = groundBelow(c, t, p.x + dx * 1.0, p.y + 3, p.z + dz * 1.0); // something taller right in front: hop up
  return F({ mx: dx, mz: dz, jump: rnd() < 0.01 || (step !== null && step > p.y + 0.1 && p.grounded), use: !!p.item && t % 50 === (i * 7) % 50,
    push: !!near && p.pushCd <= 0 && (t + i * 3) % aggr === 0 || (p.grabTarget >= 0 && p.grabbing < 1.8 && t % 12 === 0),
    grab: !!near && p.grabCd <= 0 && (Math.floor(t / 90) + i) % 4 === 0 });
}
/** Hex-A-Gone: never stand still; hop to the nearest tile that is still solid for a while. */
function hexer(sim: RaceSim, p: PlayerState, i: number): InputFrame {
  const now = sim.tick / TICK_RATE; let tgt = null as null | { x: number; z: number }, bd = 1e9;
  for (const pl of sim.course.platforms) { if (pl.id === p.platformId || Math.abs(pl.y + pl.hy - p.y) > 1.2 || (pl.vanishAt !== undefined && pl.vanishAt - now < 1.1)) continue; const d = Math.hypot(pl.x - p.x, pl.z - p.z); if (d < bd && d > 1.5) { bd = d; tgt = pl; } }
  const f = fighter(sim, p, i, tgt);
  // still shove anybody close
  for (const q of sim.players) if (q !== p && q.alive && Math.hypot(q.x - p.x, q.z - p.z) < 1.8 && p.pushCd <= 0 && (sim.tick + i) % 8 === 0) f.push = true;
  return f;
}

interface Row { name: string; n: number; secs: number[]; timeouts: number; outs: Record<string, number>; shoves: number; grabs: number; throws: number; takes: number; wins: number[]; finishRate: number[]; }
function runScenario(name: string, mode: string, map: string, brain: (sim: RaceSim, p: PlayerState, i: number) => InputFrame): Row {
  const row: Row = { name, n: MATCHES, secs: [], timeouts: 0, outs: {}, shoves: 0, grabs: 0, throws: 0, takes: 0, wins: new Array(7).fill(0), finishRate: [] };
  for (let g = 0; g < MATCHES; g++) {
    const m = new Match(Array.from({ length: PLAYERS }, (_, i) => i), 1000 + g * 77, { mode, map });
    let ticks = 0, seq = 0, firstSim = m.sim;
    while (m.phase !== 'over' && ticks++ < TICK_RATE * 60 * 12) {
      const inputs: (InputFrame | undefined)[] = [];
      if (m.phase === 'round') for (const p of m.sim.players) if (p.alive) { const f = brain(m.sim, p, p.slot); f.seq = ++seq; inputs[p.slot] = f; }
      const before = m.sim; m.step(inputs);
      if (m.sim === before) for (const e of before.events as SimEvent[]) {
        if (e.t === 'impact' && e.kind === 'shove' && e.outcome === 'hit') row.shoves++; else if (e.t === 'grab') row.grabs++; else if (e.t === 'release' && e.thrown) row.throws++;
        else if (e.t === 'out') row.outs[e.how] = (row.outs[e.how] ?? 0) + 1; else if (e.t === 'crown' && e.what === 'take') row.takes++;
      }
    }
    void firstSim;
    for (const r of [m.lastResult]) if (r) { if (r.reason === 'timeout') row.timeouts++; }
    row.secs.push((m.sim.tick / TICK_RATE) - 3); if (m.winner >= 0) row.wins[m.winner]++;
    const fin = m.sim.players.filter((p) => p.finishRank > 0).length; row.finishRate.push(fin / PLAYERS);
  }
  return row;
}
const med = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)] ?? 0;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);

const scenarios: { row: Row; window: [number, number]; extra?: (r: Row) => string[] }[] = [
  { row: runScenario('Arena · Platform Panic', 'arena', 'platform-panic', (s, p, i) => fighter(s, p, i)), window: [35, 115] },
  { row: runScenario('Arena · Hex-A-Gone', 'arena', 'hex-a-gone', hexer), window: [20, 110] },
  { row: runScenario('Corona · Crown Hill', 'crown', 'crown-hill', (s, p, i) => { const c = s.crown!; return fighter(s, p, i, c.holder < 0 ? { x: c.x, z: c.z } : c.holder === p.slot ? { x: -p.x * 2, z: -p.z * 2 } : null, 40); }), window: [25, 108], extra: () => [] },
  { row: runScenario('Corsa · Neon Circuit (bot ingenuo)', 'race', 'neon-circuit', (s, p) => botInput(p, s.course, s.tick, 0, { useItems: true })), window: [20, 120] },
];

console.log(`\nBALANCE REPORT — ${MATCHES} matches x ${PLAYERS} bot players per scenario (bots are not humans!)\n`);
let bad = 0;
for (const { row: r, window: [lo, hi] } of scenarios) {
  const mm = med(r.secs), tp = (r.timeouts / r.n) * 100, expected = 1 / PLAYERS;
  const wmax = Math.max(...r.wins.slice(0, PLAYERS)) / r.n, wmin = Math.min(...r.wins.slice(0, PLAYERS)) / r.n;
  const flags: string[] = [];
  if (mm < lo || mm > hi) flags.push(`durata ${mm.toFixed(0)}s fuori da ${lo}-${hi}s`);
  const tl = r.name.startsWith('Corona') ? 60 : 15; // a crown round ending on time is a normal outcome (highest score wins)
  if (tp > tl && !r.name.startsWith('Corsa')) flags.push(`timeout ${tp.toFixed(0)}% (>${tl}%)`);
  if (r.name.startsWith('Corsa') && tp > 15) console.log('   ℹ️  il bot ingenuo non sa fare salti corti: i timeout qui dicono poco');
  if (r.name.startsWith('Arena') || r.name.startsWith('Corona')) { if (r.shoves / r.n < 3) flags.push('poche spinte efficaci'); }
  if (!r.name.startsWith('Corsa') && wmax > expected + 0.2) flags.push(`slot avvantaggiato (${(wmax * 100).toFixed(0)}% vittorie)`);
  bad += flags.length;
  const outs = Object.entries(r.outs).map(([k, v]) => `${k}:${(v / r.n).toFixed(1)}`).join(' ') || '-';
  console.log(`${flags.length ? '⚠️ ' : '✅'} ${r.name}`);
  console.log(`   durata mediana ${mm.toFixed(0)}s (media ${mean(r.secs).toFixed(0)}s) · timeout ${tp.toFixed(0)}% · spinte/partita ${(r.shoves / r.n).toFixed(1)} · prese ${(r.grabs / r.n).toFixed(1)} · lanci ${(r.throws / r.n).toFixed(1)}${r.takes ? ` · prese di corona ${(r.takes / r.n).toFixed(1)}` : ''}`);
  console.log(`   eliminazioni/partita per causa: ${outs} · vittorie per slot: ${r.wins.slice(0, PLAYERS).join(' ')} (min ${(wmin * 100).toFixed(0)}% / max ${(wmax * 100).toFixed(0)}%)${r.name.startsWith('Corsa') ? ` · arrivati ${(mean(r.finishRate) * 100).toFixed(0)}%` : ''}`);
  for (const f of flags) console.log(`   ⚠️  ${f}`);
}
void MAPS; void buildMap;
console.log(bad ? `\n${bad} segnalazione/i: vedi sopra.\n` : '\nTutto nei limiti previsti.\n');
