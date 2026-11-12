/** Elimination format: each round the first ceil(n/2) to cross the line qualify; the rest are out. Last robot standing wins. */
import { TICK_RATE } from './constants';
import { RaceSim, type RaceResult } from './sim';
import type { InputFrame } from './types';

export type MatchPhase = 'round' | 'intermission' | 'over';
export const INTERMISSION_SECONDS = 5;
export const qualifyFor = (n: number) => (n <= 1 ? 1 : Math.ceil(n / 2));

export class Match {
  phase: MatchPhase = 'round';
  roundIdx = 0;
  sim: RaceSim;
  survivors: number[];
  winner = -1;
  lastResult: RaceResult | null = null;
  intermissionTicks = 0;
  /** eliminated slots grouped per round, each ordered best -> worst within the round */
  private out: number[][] = [];
  onRoundStart?: (sim: RaceSim) => void;

  constructor(slots: number[], readonly seed: number) {
    this.survivors = [...slots];
    this.sim = this.newRound();
  }

  private newRound(): RaceSim {
    const n = this.survivors.length;
    return new RaceSim({
      seed: (this.seed + this.roundIdx * 7919) >>> 0, round: this.roundIdx,
      participants: [...this.survivors], qualify: qualifyFor(n),
    });
  }

  step(inputs: (InputFrame | undefined)[]) {
    if (this.phase === 'round') {
      this.sim.step(inputs);
      if (this.sim.phase === 'ended' && this.sim.result) this.finishRound(this.sim.result);
    } else if (this.phase === 'intermission') {
      if (--this.intermissionTicks <= 0) {
        this.roundIdx++;
        this.sim = this.newRound();
        this.phase = 'round';
        this.onRoundStart?.(this.sim);
      }
    }
  }

  private finishRound(res: RaceResult) {
    this.lastResult = res;
    this.out.push(res.eliminated.filter((s) => this.survivors.includes(s)));
    this.survivors = res.qualified.filter((s) => this.survivors.includes(s));
    this.afterSurvivorsChanged(true);
  }

  private afterSurvivorsChanged(fromRoundEnd: boolean) {
    if (this.survivors.length <= 1) {
      this.winner = this.survivors[0] ?? -1;
      this.phase = 'over';
    } else if (fromRoundEnd) {
      this.phase = 'intermission';
      this.intermissionTicks = INTERMISSION_SECONDS * TICK_RATE;
    }
  }

  /** Player disconnected for good (reconnect window expired) or left the room. */
  removePlayer(slot: number) {
    this.sim.removePlayer(slot);
    if (!this.survivors.includes(slot)) return;
    this.survivors = this.survivors.filter((s) => s !== slot);
    if (this.phase !== 'over' && this.survivors.length <= 1) this.afterSurvivorsChanged(false);
  }

  /** Final placement, best first (winner, then latest-eliminated groups first). */
  standings(): number[] {
    const order: number[] = [...this.survivors];
    for (let i = this.out.length - 1; i >= 0; i--) order.push(...this.out[i]);
    return order;
  }
}
