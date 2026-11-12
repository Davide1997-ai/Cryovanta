import type { ItemKind } from './items';

/** One tick of player intent. mx/mz are WORLD-space desired direction (client resolves camera). Server clamps. */
export interface InputFrame {
  seq: number;
  mx: number;
  mz: number;
  jump: boolean; // held
  dive: boolean; // edge-detected by the sim
  use: boolean; // item use, edge-detected by the sim
}
export const NEUTRAL_INPUT: InputFrame = { seq: 0, mx: 0, mz: 0, jump: false, dive: false, use: false };

export interface PlayerState {
  slot: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  yaw: number;
  grounded: boolean;
  /** id of the platform we stand on (-1 none) – used to carry the player with moving platforms. */
  platformId: number;
  coyote: number;
  jumpBuf: number;
  jumpHeld: boolean;
  hoverFuel: number;
  hovering: boolean;
  diveCd: number;
  diving: number; // seconds of dive state remaining (render + shove window)
  // --- status effects ---
  stun: number;
  boost: number;
  shield: number;
  invuln: number;
  // --- race state ---
  respawn: number; // >0: waiting to respawn
  checkpoint: number;
  item: ItemKind | null;
  useHeld: boolean;
  diveHeld: boolean;
  finishedAt: number; // tick, -1 if not finished
  finishRank: number; // 0 = not finished
  alive: boolean; // false: eliminated / left (not simulated)
}

export type PlatformKind = 'static' | 'mover' | 'piston';
export interface Platform {
  id: number;
  kind: PlatformKind;
  x: number; y: number; z: number; // centre at t=0
  hx: number; hy: number; hz: number; // half extents
  ax: number; ay: number; az: number; // oscillation amplitude
  period: number; phase: number;
  /** cosmetic palette index for the neon trim */
  hue: number;
}
export interface Checkpoint { z: number; spawn: [number, number, number]; }
export interface ItemBoxDef { id: number; x: number; y: number; z: number; }
export interface Course {
  seed: number;
  platforms: Platform[];
  checkpoints: Checkpoint[];
  boxes: ItemBoxDef[];
  finishZ: number;
  killY: number;
  spawnPoints: [number, number, number][]; // 7 slots
  length: number;
}

export interface SeekerState { id: number; owner: number; target: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; }
export interface HazardState { id: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; armed: number; life: number; }
export interface BoxState { id: number; cooldown: number; }
