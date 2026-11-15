import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** One line per finished match, written to .data/matches.jsonl. `npm run report` aggregates them for balancing after real playtests. */
export interface MatchLog {
  t: number; mode: string; mapOption: string; players: number; seconds: number; standings: number[]; winner: number;
  rounds: { map: string; rule: string; seconds: number; reason: string }[];
  stats: { shoves: number; bumps: number; grabs: number; throws: number; emotes: number; outs: Record<string, number>; crownTakes: number; finishes: number };
}
export type TelemetrySink = (e: MatchLog) => void;
export const fileSink = (file: string): TelemetrySink => (e) => { try { mkdirSync(dirname(file), { recursive: true }); appendFileSync(file, JSON.stringify(e) + '\n'); } catch { /* telemetry must never break a match */ } };
