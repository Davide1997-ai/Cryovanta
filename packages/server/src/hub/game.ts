import { MAX_PLAYERS_PER_ROOM, type InputFrame, type ServerMsg } from '@cryovanta/shared';

/** What a running game can ask of the room that hosts it. */
export interface GameHost {
  send(slot: number, msg: ServerMsg): void;
  broadcast(msg: ServerMsg): void;
}

export interface GameSession {
  readonly finished: boolean;
  start(slots: number[]): void;
  handleInput(slot: number, frames: InputFrame[]): void;
  /** Called at TICK_RATE while the room is in the `playing` phase. */
  tick(): void;
  /** Slot permanently gone (left, or reconnect grace expired). */
  removePlayer(slot: number): void;
}

/** A title in the hub. Add new games by registering another module — the room/lobby layer is game-agnostic. */
export interface GameModule {
  id: string;
  displayName: string;
  minPlayers: number;
  maxPlayers: number;
  createSession(host: GameHost): GameSession;
}

export function assertValidModule(m: GameModule) {
  if (m.maxPlayers > MAX_PLAYERS_PER_ROOM) throw new Error(`${m.id}: maxPlayers ${m.maxPlayers} exceeds hard cap ${MAX_PLAYERS_PER_ROOM}`);
  if (m.minPlayers < 1 || m.minPlayers > m.maxPlayers) throw new Error(`${m.id}: bad minPlayers`);
}
