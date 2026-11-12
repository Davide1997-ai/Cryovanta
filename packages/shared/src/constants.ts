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
} as const;
