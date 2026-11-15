/**
 * Match = sequence of rounds, interpreted according to the mode:
 *  elimination/chaos: each round the first ceil(n/2) to cross the line qualify, the rest are out; last robot wins.
 *  race:              one round, everybody races, first across wins.
 *  grandprix:         3 rounds, points per finishing position, most points wins.
 */
import { TICK_RATE } from './constants';
import { CROWN_MAP_IDS, MAPS, RACE_MAP_IDS, SURVIVAL_MAP_IDS } from './maps';
import { MODES, POINTS, type ModeDef } from './modes';
import { RaceSim, type RaceResult } from './sim';
import type { InputFrame } from './types';

export type MatchPhase = 'round' | 'intermission' | 'over';
export const INTERMISSION_SECONDS = 5;
export const GRANDPRIX_ROUNDS = 3;
export const qualifyFor = (n: number) => (n <= 1 ? 1 : Math.ceil(n / 2));

export interface MatchOptions { mode: string; map: string; }
export interface RoundSetup { mapId: string; difficulty: number; /** this round is the crown final of an elimination match */ crownFinal?: boolean; }

export class Match {
  phase: MatchPhase = 'round';
  roundIdx = 0;
  sim: RaceSim;
  survivors: number[];
  winner = -1;
  lastResult: RaceResult | null = null;
  intermissionTicks = 0;
  readonly mode: ModeDef;
  points: number[] = new Array(7).fill(0);
  /** team round: team per slot and team totals */
  teams: number[] = new Array(7).fill(-1);
  teamPoints: number[] = [0, 0];
  private out: number[][] = [];
  private lastRanking: number[] = [];
  private left = new Set<number>();
  currentSetup!: RoundSetup;

  constructor(slots: number[], readonly seed: number, readonly opts: MatchOptions = { mode: 'elimination', map: 'neon-circuit' }) {
    this.mode = MODES[opts.mode] ?? MODES.elimination;
    this.survivors = [...slots];
    this.sim = this.newRound();
    this.teams = this.sim.players.map((p) => p.team);
  }

  /** Map for a round: fixed, or seeded-random (never the same map twice in a row). */
  setupFor(round: number): RoundSetup {
    // Elimination ends with a crown FINAL once only two robots are left (like the Stumble Guys finale)
    if (this.mode.kind === 'elimination' && this.survivors.length === 2) return { mapId: CROWN_MAP_IDS[0], difficulty: 0.5, crownFinal: true };
    const pool = this.mode.kind === 'survival' ? SURVIVAL_MAP_IDS : this.mode.kind === 'crown' ? CROWN_MAP_IDS : RACE_MAP_IDS; // a mode only plays maps of its own kind
    let mapId = this.opts.map;
    if (mapId === 'random' || !MAPS[mapId] || !pool.includes(mapId)) {
      const base = (this.seed >>> 0) % pool.length;
      mapId = pool[(base + round) % pool.length];
    }
    const k = this.mode.kind;
    const difficulty = k === 'elimination' ? Math.min(1, round * 0.35) : k === 'race' ? 0.55 : k === 'survival' || k === 'crown' ? 0.4 : 0.3 + round * 0.25;
    return { mapId, difficulty };
  }

  private qualify(n: number) { return this.mode.kind === 'elimination' ? qualifyFor(n) : this.mode.kind === 'survival' || this.mode.kind === 'crown' ? 1 : n; }

  private newRound(): RaceSim {
    this.currentSetup = this.setupFor(this.roundIdx);
    return new RaceSim({
      seed: (this.seed + this.roundIdx * 7919) >>> 0, round: this.roundIdx,
      participants: [...this.survivors], qualify: this.qualify(this.survivors.length),
      mapId: this.currentSetup.mapId, difficulty: this.currentSetup.difficulty, boxRespawn: this.mode.boxRespawn, teams: this.mode.kind === 'team',
    });
  }

  step(inputs: (InputFrame | undefined)[]) {
    if (this.phase === 'round') {
      this.sim.step(inputs);
      if (this.sim.phase === 'ended' && this.sim.result) this.finishRound(this.sim.result);
    } else if (this.phase === 'intermission') {
      if (--this.intermissionTicks <= 0) { this.roundIdx++; this.sim = this.newRound(); this.phase = 'round'; }
    }
  }

  private finishRound(res: RaceResult) {
    this.lastResult = res;
    if (this.mode.kind === 'elimination') {
      this.out.push(res.eliminated.filter((s) => this.survivors.includes(s)));
      this.survivors = res.qualified.filter((s) => this.survivors.includes(s));
      this.afterSurvivorsChanged(true);
      return;
    }
    // race / grandprix / survival: `qualified` (+ `eliminated` in survival) is the full ranking, best first
    const full = this.mode.kind === 'survival' || this.mode.kind === 'crown' ? [...res.qualified, ...res.eliminated] : res.qualified;
    const ranking = full.filter((s) => this.survivors.includes(s) || this.mode.kind === 'survival' || this.mode.kind === 'crown');
    this.lastRanking = ranking;
    ranking.forEach((s, i) => {
      const pts = POINTS[Math.min(i, POINTS.length - 1)];
      if (this.mode.kind === 'grandprix') this.points[s] += pts;
      if (this.mode.kind === 'team' && this.teams[s] >= 0) { this.points[s] += pts; this.teamPoints[this.teams[s]] += pts; }
    });
    const rounds = this.mode.kind === 'grandprix' || this.mode.kind === 'team' ? GRANDPRIX_ROUNDS : 1;
    if (this.roundIdx + 1 >= rounds || this.survivors.length <= 1) { this.finishScoring(); }
    else { this.phase = 'intermission'; this.intermissionTicks = INTERMISSION_SECONDS * TICK_RATE; }
  }

  private finishScoring() {
    this.phase = 'over';
    const order = this.standings();
    this.winner = order[0] ?? -1;
  }

  private afterSurvivorsChanged(fromRoundEnd: boolean) {
    if (this.survivors.length <= 1) { this.winner = this.survivors[0] ?? -1; this.phase = 'over'; }
    else if (fromRoundEnd) { this.phase = 'intermission'; this.intermissionTicks = INTERMISSION_SECONDS * TICK_RATE; }
  }

  /** Player disconnected for good (reconnect window expired) or left the room. */
  removePlayer(slot: number) {
    this.sim.removePlayer(slot); this.left.add(slot);
    if (!this.survivors.includes(slot)) return;
    this.survivors = this.survivors.filter((s) => s !== slot);
    if (this.phase === 'over') return;
    if (this.survivors.length <= 1) {
      if (this.mode.kind === 'elimination') this.afterSurvivorsChanged(false);
      else if (this.mode.kind === 'survival' || this.mode.kind === 'crown') { /* the sim ends the round */ }
      else if (this.survivors.length === 0) { this.phase = 'over'; this.winner = -1; }
      else if (this.phase === 'round' && this.survivors.length === 1) { this.lastRanking = [...this.survivors]; this.finishScoring(); }
    }
  }

  /** Final placement, best first. */
  standings(): number[] {
    if (this.mode.kind === 'elimination') {
      const order: number[] = [...this.survivors];
      for (let i = this.out.length - 1; i >= 0; i--) order.push(...this.out[i]);
      return order;
    }
    const all = [...new Set([...this.lastRanking, ...this.survivors])];
    if (this.mode.kind === 'race' || this.mode.kind === 'survival' || this.mode.kind === 'crown') return all;
    if (this.mode.kind === 'team') { const rank = (s: number) => { const i = this.lastRanking.indexOf(s); return i < 0 ? 99 : i; }; const win = this.teamPoints[0] >= this.teamPoints[1] ? 0 : 1; return all.sort((a, b) => (this.teams[a] === win ? 0 : 1) - (this.teams[b] === win ? 0 : 1) || this.points[b] - this.points[a] || rank(a) - rank(b)); }
    const rank = (s: number) => { const i = this.lastRanking.indexOf(s); return i < 0 ? 99 : i; };
    return all.sort((a, b) => this.points[b] - this.points[a] || rank(a) - rank(b));
  }
}
