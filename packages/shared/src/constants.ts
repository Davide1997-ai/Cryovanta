/** Hard cap enforced by Room.tryJoin AND by the Hub (see server/hub). Never raise without load-testing. */
export const MAX_PLAYERS_PER_ROOM = 7;
export const MIN_PLAYERS_TO_START = 2;

export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;
/** Server -> client snapshot every N sim ticks (60/3 = 20 Hz). */
export const SNAPSHOT_EVERY = 3;
/** Remote entities are rendered this far in the past so we can always interpolate between 2 snapshots. */
export const INTERP_DELAY_MS = 110;
/** Max unprocessed inputs the server will queue per player (anti input-flood / anti speedhack). */
export const MAX_INPUT_QUEUE = 12;
export const MAX_INPUTS_PER_PACKET = 6;

/** Player body (feet-origin AABB). */
export const BODY_HALF_W = 0.4;
export const BODY_HEIGHT = 1.1;

export const TUNING = {
  runSpeed: 9,
  accelGround: 70,
  accelAir: 28,
  frictionGround: 55,
  jumpVelocity: 11.5,
  gravity: 32,
  jumpCutGravityMul: 2.6,
  terminalVelocity: -30,
  coyoteTime: 0.1,
  jumpBuffer: 0.12,
  hoverFuel: 0.55,
  hoverMaxRise: 3.2,
  hoverAccel: 55,
  diveSpeed: 15,
  diveCooldown: 1.1,
  diveLift: 4,
  boostMul: 1.65,
  maxHorizontalSpeed: 22,
  respawnDelay: 1.4,
  bumpRadius: 0.85,
  bumpImpulse: 6,
  bounceVelocity: 19,
  slimeSpeedMul: 0.55,
  slimeJumpMul: 0.8,
  iceAccelMul: 0.15,
  iceFrictionMul: 0.06,
} as const;

/** Robot / player colours by slot (shared by the 3D scene, the lobby and the phone joypad). */
export const PLAYER_COLORS = [0x2f7bff, 0xff4f8b, 0x35d07f, 0xffc233, 0x9b6bff, 0xff7a3d, 0x3fe0d0] as const;
