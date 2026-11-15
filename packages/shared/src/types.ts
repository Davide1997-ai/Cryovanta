import type { ItemKind } from './items';

/** One tick of player intent. mx/mz are WORLD-space desired direction (client resolves camera). Server clamps. */
export interface InputFrame {
  seq: number;
  mx: number;
  mz: number;
  jump: boolean; // held
  dive: boolean; // edge-detected by the sim
  use: boolean; // item use, edge-detected by the sim
  push: boolean; // shove (edge-detected): knocks back whoever is in front
  grab: boolean; // hold: grab the robot in front and drag it
}
export const NEUTRAL_INPUT: InputFrame = { seq: 0, mx: 0, mz: 0, jump: false, dive: false, use: false, push: false, grab: false };

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
  // --- dirty play ---
  pushCd: number; pushing: number; pushHeld: boolean; pushReq: boolean; // shove (pushReq is a one-tick request consumed by the sim)
  grabHeld: boolean; grabbing: number; grabCd: number; grabTarget: number; // -1 = none
  slow: number;     // seconds of "being held / dragged": slower, cannot jump
  outAt: number;    // survival rounds: tick of elimination, -1 while alive
  team: number;     // -1 none, 0/1 team round
  crowned: boolean; // carrying the crown (slightly slower)
  lastHitKind: string; lastHitBy: number; lastHitTick: number; // who/what hit me last (for "pushed off by ..." and telemetry)
}

export type PlatformKind = 'static' | 'mover' | 'piston' | 'blink';
/** Walking surface. Pure functions of the platform => identical on server and client prediction. */
export type Surface = 'normal' | 'ice' | 'conveyor' | 'bounce' | 'slime';
export type Theme = 'neon' | 'sunny' | 'frost';
export interface Platform {
  id: number;
  kind: PlatformKind;
  x: number; y: number; z: number; // centre at t=0
  hx: number; hy: number; hz: number; // half extents
  ax: number; ay: number; az: number; // oscillation amplitude
  period: number; phase: number;
  /** cosmetic palette index for the neon trim */
  hue: number;
  collapseDelay?: number;  // dynamic tiles: seconds between the touch and the collapse (default TUNING.tileCollapseDelay)
  dynamic?: boolean;       // Hex-A-Gone: collapses ~0.7 s after somebody stands on it (the server sets vanishAt)
  vanishAt?: number;       // survival arenas: second (sim time) when this tile collapses for good
  surface?: Surface;       // default 'normal'
  flowX?: number; flowZ?: number; // conveyor belt speed (u/s)
  duty?: number;           // 'blink' tiles: fraction of the period they are solid
  skin?: number;           // cosmetic material variant (theme decides what it means)
}

export type HazardKind = 'spinner' | 'pendulum' | 'roller';
/** Giant moving obstacles. Position is a pure function of the tick (see hazards.ts). */
export interface CourseHazard {
  id: number; kind: HazardKind;
  x: number; y: number; z: number;   // spinner: hub centre · pendulum: pivot · roller: start centre
  len: number;                        // spinner: full bar length · pendulum: rope length · roller: travel distance (-z)
  radius: number;                     // bar thickness / head radius / roller radius
  halfWidth?: number;                 // roller: half length of the cylinder (x extent)
  speed: number;                      // spinner: rad/s · pendulum: max swing angle (rad)
  period: number; phase: number;      // pendulum / roller cycle
  dir: number;                        // spinner direction (+1/-1)
  axis?: 'x' | 'z';                   // pendulum swing plane
}
export interface WindZone {
  x: number; y: number; z: number; hx: number; hy: number; hz: number;
  fx: number; fz: number;            // acceleration (u/s^2) while active
  period: number; duty: number; phase: number; // period 0 => always on
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
  mapId: string;
  /** survival arenas have no finish line: last robot standing wins and falling = elimination */
  survival?: boolean;
  /** King-of-the-hill: hold the crown 25 s (cumulative). Falling just respawns. */
  crown?: boolean;
  crownPos?: [number, number, number];
  theme: Theme;
  hazards: CourseHazard[];
  zones: WindZone[];
}

export interface SeekerState { id: number; owner: number; target: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; }
export interface HazardState { id: number; owner: number; x: number; y: number; z: number; vx: number; vy: number; vz: number; armed: number; life: number; }
export interface BoxState { id: number; cooldown: number; }
