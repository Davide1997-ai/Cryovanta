/**
 * Phone-as-joypad: turns device orientation (beta/gamma, W3C convention) into a 2D movement vector.
 * Pure functions (no DOM) so they can be unit-tested.
 *
 * Math: the world "up" direction expressed in the device frame is
 *     u = (-cos β · sin γ,  sin β,  cos β · cos γ)
 * (independent of compass heading α, and identical on iOS/Android). We rotate its x/y into SCREEN axes using the
 * screen orientation angle, then
 *     roll  = atan2(-sx, uz)   > 0 when the user-right edge goes down  => move right
 *     pitch = atan2(-sy, uz)   > 0 when the user-top edge goes away    => move forward
 * Movement = (roll, pitch) minus a calibrated neutral pose, with dead-zone, response curve and clamp.
 */
const D2R = Math.PI / 180;

export interface Angles { roll: number; pitch: number }

export function screenAngles(betaDeg: number, gammaDeg: number, orientationDeg: number): Angles {
  const b = betaDeg * D2R, g = gammaDeg * D2R, a = orientationDeg * D2R;
  const ux = -Math.cos(b) * Math.sin(g), uy = Math.sin(b), uz = Math.cos(b) * Math.cos(g);
  const sx = ux * Math.cos(a) - uy * Math.sin(a), sy = ux * Math.sin(a) + uy * Math.cos(a);
  return { roll: Math.atan2(-sx, uz), pitch: Math.atan2(-sy, uz) };
}

export interface TiltOptions {
  /** tilt (radians) that gives full speed */ max: number;
  /** radial dead-zone (radians) */ dead: number;
  /** >1 = finer control near the centre */ curve: number;
}
export const DEFAULT_TILT: TiltOptions = { max: 26 * D2R, dead: 2.5 * D2R, curve: 1.35 };

export function tiltToMove(a: Angles, neutral: Angles, o: TiltOptions = DEFAULT_TILT): { x: number; y: number } {
  const dx = a.roll - neutral.roll, dy = a.pitch - neutral.pitch, r = Math.hypot(dx, dy);
  if (r <= o.dead) return { x: 0, y: 0 };
  const n = Math.min(1, (r - o.dead) / (o.max - o.dead)), k = Math.pow(n, o.curve) / r;
  return { x: dx * k, y: dy * k };
}

/** Exponential smoothing that is independent of the sampling rate. */
export function smooth(prev: number, next: number, dt: number, tau = 0.045): number { return prev + (next - prev) * (1 - Math.exp(-dt / tau)); }
