/**
 * Match = sequence of rounds, interpreted according to the mode:
 *  elimination/chaos: each round the first ceil(n/2) to cross the line qualify, the rest are out; last robot wins.
 *  race:              one round, everybody races, first across wins.
 *  grandprix:         3 rounds, points per finishing position, most points wins.
 */
import { TICK_RATE } from './constants';
import { MAP_IDS } from './maps';
import { MODES, POINTS, type ModeDef } from './modes';
import { RaceSim, type RaceResult } from './sim';
import type { InputFrame } from './types';

export type MatchPhase = 'round' | 'intermission' | 'over';
export const INTERMISSION_SECONDS = 5;
export const GRANDPRIX_ROUNDS = 3;
export const qualifyFor = (n: number) => (n <= 1 ? 1 : Math.ceil(n / 2));

export interface MatchOptions { mode: string; map: string; }
export interface RoundSetup { mapId: string; difficulty: number; }

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
  private out: number[][] = [];
  private lastRanking: number[] = [];
  private left = new Set<number>();
  currentSetup!: RoundSetup;

  constructor(slots: number[], readonly seed: number, readonly opts: MatchOptions = { mode: 'elimination', map: 'neon-circuit' }) {
    this.mode = MODES[opts.mode] ?? MODES.elimination;
    this.survivors = [...slots];
    this.sim = this.newRound();
  }

  /** Map for a round: fixed, or seeded-random (never the same map twice in a row). */
  setupFor(round: number): RoundSetup {
    let mapId = this.opts.map;
    if (mapId === 'random' || !MAP_IDS.includes(mapId)) {
      const base = (this.seed >>> 0) % MAP_IDS.length;
      mapId = MAP_IDS[(base + round) % MAP_IDS.length];
    }
    const k = this.mode.kind;
    const difficulty = k === 'elimination' ? Math.min(1, round * 0.35) : k === 'race' ? 0.55 : 0.3 + round * 0.25;
    return { mapId, difficulty };
  }

  private qualify(n: number) { return this.mode.kind === 'elimination' ? qualifyFor(n) : n; }

  private newRound(): RaceSim {
    this.currentSetup = this.setupFor(this.roundIdx);
    return new RaceSim({
      seed: (this.seed + this.roundIdx * 7919) >>> 0, round: this.roundIdx,
      participants: [...this.survivors], qualify: this.qualify(this.survivors.length),
      mapId: this.currentSetup.mapId, difficulty: this.currentSetup.difficulty, boxRespawn: this.mode.boxRespawn,
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
    // race / grandprix: nobody is eliminated; `qualified` is the full ranking (finishers first, then by progress)
    const ranking = res.qualified.filter((s) => this.survivors.includes(s));
    this.lastRanking = ranking;
    ranking.forEach((s, i) => { this.points[s] += this.mode.kind === 'race' ? 0 : POINTS[Math.min(i, POINTS.length - 1)]; });
    const rounds = this.mode.kind === 'race' ? 1 : GRANDPRIX_ROUNDS;
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
    if (this.mode.kind === 'race') return all;
    const rank = (s: number) => { const i = this.lastRanking.indexOf(s); return i < 0 ? 99 : i; };
    return all.sort((a, b) => this.points[b] - this.points[a] || rank(a) - rank(b));
  }
}
