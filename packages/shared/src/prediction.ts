import { createPlayer, stepPlayer } from './controller';
import type { Snapshot } from './protocol';
import { decodePlayer } from './snapshot';
import type { Course, InputFrame, PlayerState } from './types';

/**
 * Client-side prediction + server reconciliation for the local robot.
 *  1. step(): apply the input locally right away (zero-latency feel) and remember it as "pending".
 *  2. reconcile(): on every snapshot, rewind to the authoritative state, drop inputs the server already
 *     consumed (seq <= ack) and re-simulate the rest with the SAME controller code.
 * Only the local player is predicted; everything else (other robots, items, hits) is interpolated server truth.
 */
export class Predictor {
  state: PlayerState;
  /** Predicted sim tick of the NEXT step (platform motion is a pure function of tick). */
  tick = 0;
  seq = 0;
  pending: InputFrame[] = [];
  running = false;
  /** Visual-only offset that decays to 0: hides small corrections instead of snapping the camera. */
  smooth = { x: 0, y: 0, z: 0 };
  lastError = 0;

  constructor(public course: Course, public slot: number) {
    this.state = createPlayer(slot, course.spawnPoints[slot]);
    this.state.grounded = true;
  }

  step(input: Omit<InputFrame, 'seq'>): InputFrame {
    const f: InputFrame = { ...input, seq: ++this.seq };
    // Teleports (respawn) are never predicted: the server alone decides when the robot reappears.
    if (this.running && this.state.respawn <= 0) {
      this.tick++;
      stepPlayer(this.state, f, this.course, this.tick);
      this.pending.push(f);
      if (this.pending.length > 120) this.pending.shift();
    }
    return f;
  }

  reconcile(snap: Snapshot) {
    const me = snap.players[this.slot];
    if (!me) return;
    this.running = snap.rp === 'running' && snap.mp === 'round';
    const wasDown = this.state.respawn > 0;
    const before = { x: this.state.x, y: this.state.y, z: this.state.z };
    decodePlayer(me, this.state);
    if (!this.running) { this.pending.length = 0; this.tick = snap.tick; return; }
    const ack = snap.ack[this.slot] ?? 0;
    this.pending = this.pending.filter((f) => f.seq > ack);
    if (this.state.respawn > 0) { this.pending.length = 0; this.tick = snap.tick; this.lastError = 0; this.smooth.x = this.smooth.y = this.smooth.z = 0; return; }
    let t = snap.tick;
    for (const f of this.pending) stepPlayer(this.state, f, this.course, ++t);
    this.tick = t;
    const dx = before.x - this.state.x, dy = before.y - this.state.y, dz = before.z - this.state.z;
    this.lastError = wasDown ? 0 : Math.hypot(dx, dy, dz); // a respawn teleport is not a prediction error
    if (wasDown || this.lastError > 3) { this.smooth.x = this.smooth.y = this.smooth.z = 0; } // teleport-sized: snap
    else { this.smooth.x += dx; this.smooth.y += dy; this.smooth.z += dz; }
  }

  /** Call once per rendered frame. */
  decaySmoothing(dt: number) {
    const k = Math.exp(-12 * dt);
    this.smooth.x *= k; this.smooth.y *= k; this.smooth.z *= k;
  }
}
