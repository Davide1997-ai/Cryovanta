import {
  EMOTE_COOLDOWN_TICKS, INTERMISSION_SECONDS, MAP_IDS, MODE_IDS, xpForMatch, MAX_INPUT_QUEUE, MAX_PLAYERS_PER_ROOM, MIN_PLAYERS_TO_START, Match, SNAPSHOT_EVERY, buildSnapshot,
  type InputFrame, type SimEvent,
} from '@cryovanta/shared';
import type { GameHost, GameModule, GameSession, RoomOptions } from '../hub/game';

/** If a client's input queue runs dry we repeat its last frame this many ticks before falling back to neutral. */
const STARVE_REPEAT_TICKS = 6;
/** Input jitter buffer: ~80 ms of queued frames is the most we tolerate (every extra queued frame = extra input lag); beyond that we skip ahead. */
const SKIP_AHEAD_AT = 5, KEEP_AFTER_SKIP = 2;

/**
 * Authoritative "Neon Circuit" session.
 *  - Clients only send *intent* (InputFrame). Position, items, hits, finish and elimination are decided here.
 *  - One input is consumed per player per tick => a client cannot move faster than the tick rate.
 *  - Per-slot `ack` tells each client which of its inputs the state already includes (for reconciliation).
 */
export class ObstacleRaceSession implements GameSession {
  private match!: Match;
  private queues: InputFrame[][] = Array.from({ length: MAX_PLAYERS_PER_ROOM }, () => []);
  private lastSeq = new Array<number>(MAX_PLAYERS_PER_ROOM).fill(0); // highest seq accepted (anti replay/rewind)
  private last: (InputFrame | undefined)[] = [];
  private starve = new Array<number>(MAX_PLAYERS_PER_ROOM).fill(0);
  private ack = new Array<number>(MAX_PLAYERS_PER_ROOM).fill(0);
  private evBuf: SimEvent[] = [];
  private announcedRound = -1;
  private resultSent: unknown = null;
  private ticks = 0;
  finished = false;
  private lastEmote = new Array<number>(MAX_PLAYERS_PER_ROOM).fill(-1e9);
  private pendingEvents: SimEvent[] = [];
  private startedAt = 0;
  private roundLogs: { map: string; rule: string; seconds: number; reason: string }[] = [];
  private logged: unknown = null;
  private stats = { shoves: 0, bumps: 0, grabs: 0, throws: 0, emotes: 0, outs: {} as Record<string, number>, crownTakes: 0, finishes: 0 };
  private opts: RoomOptions = { map: 'random', mode: 'elimination' };

  constructor(private host: GameHost, private seedFn: () => number) {}

  start(slots: number[], options: RoomOptions) {
    this.opts = options; this.startedAt = Date.now();
    this.match = new Match(slots, this.seedFn(), options);
    this.announceRound();
  }

  handleInput(slot: number, frames: InputFrame[]) {
    const q = this.queues[slot];
    for (const f of frames) {
      if (f.seq <= this.lastSeq[slot]) continue; // duplicate (redundant resend) or replay
      if (q.length >= MAX_INPUT_QUEUE) break; // flood: drop; honest clients never get this far behind
      this.lastSeq[slot] = f.seq;
      q.push(f);
    }
    // After a Wi-Fi stall a burst arrives at once. Do NOT run it faster than real time (that would be a speed
    // exploit); skip ahead instead, keeping the newest frames and merging button presses so a tap is never lost.
    if (q.length > SKIP_AHEAD_AT) {
      const dropped = q.splice(0, q.length - KEEP_AFTER_SKIP);
      const k = q[0];
      q[0] = { ...k, jump: k.jump || dropped.some((d) => d.jump), dive: k.dive || dropped.some((d) => d.dive), use: k.use || dropped.some((d) => d.use) };
    }
  }

  /** Emotes are cosmetic events relayed to everybody (screens animate them); rate-limited per player. */
  handleEmote(slot: number, id: number) {
    if (!this.match || this.finished || this.match.sim.tick - this.lastEmote[slot] < EMOTE_COOLDOWN_TICKS) return;
    this.lastEmote[slot] = this.match.sim.tick; this.stats.emotes++;
    this.pendingEvents.push({ t: 'emote', slot, id });
  }

  removePlayer(slot: number) {
    if (this.match && !this.finished) this.match.removePlayer(slot);
    this.queues[slot].length = 0;
  }

  tick() {
    if (this.finished) return;
    const inputs: (InputFrame | undefined)[] = [];
    for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) {
      const next = this.queues[s].shift();
      if (next) { inputs[s] = next; this.last[s] = next; this.starve[s] = 0; this.ack[s] = next.seq; }
      else if (this.last[s] && this.starve[s] < STARVE_REPEAT_TICKS) { inputs[s] = this.last[s]; this.starve[s]++; }
    }
    const simBefore = this.match.sim, tickBefore = simBefore.tick;
    this.match.step(inputs);
    const stepped = this.match.sim === simBefore && simBefore.tick !== tickBefore;
    const evTick = stepped ? [...simBefore.events] : [];
    if (this.pendingEvents.length) { evTick.push(...this.pendingEvents); this.pendingEvents = []; }
    this.evBuf.push(...evTick);
    this.countStats(evTick);

    if (this.match.roundIdx !== this.announcedRound) this.announceRound();
    if (this.match.lastResult && this.resultSent !== this.match.lastResult) {
      this.resultSent = this.match.lastResult; // identity: each round result is announced exactly once
      this.host.broadcast({ k: 'roundEnd', qualified: this.match.lastResult.qualified, eliminated: this.match.lastResult.eliminated, teamPoints: this.match.mode.kind === 'team' ? this.match.teamPoints : undefined });
      const sim = simBefore; this.roundLogs.push({ map: sim.cfg.mapId, rule: sim.course.crown ? 'crown' : sim.course.survival ? 'survival' : 'race', seconds: Math.round((sim.tick / 60 - 3) * 10) / 10, reason: this.match.lastResult.reason });
    }
    // Big screens have no prediction, so they get state on EVERY tick (60 Hz); players/phones every SNAPSHOT_EVERY ticks.
    if (this.host.displayCount > 0) this.host.sendDisplays(buildSnapshot(this.match, this.ack, evTick));
    if (++this.ticks % SNAPSHOT_EVERY === 0) {
      this.host.sendPlayers(buildSnapshot(this.match, this.ack, this.evBuf));
      this.evBuf = [];
    }
    if (this.match.phase === 'over') {
      this.finished = true;
      this.host.broadcast(buildSnapshot(this.match, this.ack, this.evBuf));
      const standings = this.match.standings(), n = standings.length, xp = new Array<number>(MAX_PLAYERS_PER_ROOM).fill(0);
      standings.forEach((s, i) => { xp[s] = xpForMatch(i, n, s === this.match.winner) + Math.round(this.match.sim.crownScore[s] * 0.5); });
      this.host.broadcast({ k: 'matchEnd', standings, winner: this.match.winner, points: this.match.points, teams: this.match.teams, teamPoints: this.match.teamPoints, xp });
      this.host.telemetry?.({ t: Date.now(), mode: this.match.mode.id, mapOption: this.opts.map, players: n, seconds: Math.round((Date.now() - this.startedAt) / 100) / 10, standings, winner: this.match.winner, rounds: this.roundLogs, stats: this.stats });
    }
  }

  private countStats(evs: SimEvent[]) {
    for (const e of evs) {
      if (e.t === 'impact') { if (e.kind === 'shove' && e.outcome === 'hit') this.stats.shoves++; if (e.kind === 'bump' && e.outcome === 'hit') this.stats.bumps++; }
      else if (e.t === 'grab') this.stats.grabs++; else if (e.t === 'release' && e.thrown) this.stats.throws++;
      else if (e.t === 'out') this.stats.outs[e.how] = (this.stats.outs[e.how] ?? 0) + 1;
      else if (e.t === 'crown' && e.what === 'take') this.stats.crownTakes++; else if (e.t === 'finish') this.stats.finishes++;
    }
  }

  private announceRound() {
    this.announcedRound = this.match.roundIdx;
    const sim = this.match.sim;
    this.host.broadcast({ k: 'round', round: this.match.roundIdx, seed: sim.cfg.seed, participants: sim.cfg.participants, qualify: sim.cfg.qualify, tick: sim.tick, map: sim.cfg.mapId, mode: this.match.mode.id, difficulty: sim.cfg.difficulty, teams: sim.players.map((p) => p.team), rule: sim.course.crown ? 'crown' : sim.course.survival ? 'survival' : 'race' });
    for (const s of sim.cfg.participants) { this.queues[s].length = 0; }
  }
}

export function createObstacleRaceModule(seedFn: () => number = () => (Math.random() * 0xffffffff) >>> 0): GameModule {
  return {
    id: 'neon-circuit',
    displayName: 'Neon Circuit',
    minPlayers: MIN_PLAYERS_TO_START,
    maxPlayers: MAX_PLAYERS_PER_ROOM,
    options: { map: ['random', ...MAP_IDS], mode: MODE_IDS },
    createSession: (host) => new ObstacleRaceSession(host, seedFn),
  };
}
export const obstacleRaceModule = createObstacleRaceModule();
export { INTERMISSION_SECONDS };
