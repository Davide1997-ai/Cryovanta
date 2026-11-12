import { q } from './math';
import type { Match } from './match';
import type { Snapshot, SnapPlayer } from './protocol';
import { TICK_RATE } from './constants';
import type { PlayerState } from './types';

export function encodePlayer(p: PlayerState): SnapPlayer {
  return {
    s: p.slot, x: q(p.x), y: q(p.y), z: q(p.z), vx: q(p.vx), vy: q(p.vy), vz: q(p.vz), yaw: q(p.yaw),
    g: p.grounded ? 1 : 0, hv: p.hovering ? 1 : 0, dv: q(p.diving),
    cy: q(p.coyote), jb: q(p.jumpBuf), jh: p.jumpHeld ? 1 : 0, hf: q(p.hoverFuel), dc: q(p.diveCd), dh: p.diveHeld ? 1 : 0, pf: p.platformId,
    st: q(p.stun), bo: q(p.boost), sh: q(p.shield), iv: q(p.invuln), rs: q(p.respawn),
    it: p.item, cp: p.checkpoint, fr: p.finishRank, al: p.alive ? 1 : 0,
  };
}

export function buildSnapshot(m: Match, ack: number[], events: Snapshot['ev']): Snapshot {
  const sim = m.sim;
  return {
    k: 'snap', tick: sim.tick, ack,
    mp: m.phase, rp: sim.phase, round: m.roundIdx,
    left: m.phase === 'intermission' ? m.intermissionTicks / TICK_RATE : sim.phase === 'countdown' ? sim.phaseTicks / TICK_RATE : sim.roundTicksLeft / TICK_RATE,
    players: sim.players.map(encodePlayer),
    bx: sim.boxes.filter((b) => b.cooldown > 0).map((b) => b.id),
    sk: sim.seekers.map((s) => ({ id: s.id, x: q(s.x), y: q(s.y), z: q(s.z), o: s.owner, t: s.target })),
    hz: sim.hazards.map((h) => ({ id: h.id, x: q(h.x), y: q(h.y), z: q(h.z), o: h.owner, a: h.armed > 0 ? 0 : 1 })),
    ev: events,
  };
}

/** Inverse of encodePlayer (lossy only by the wire quantisation). */
export function decodePlayer(s: SnapPlayer, into?: PlayerState): PlayerState {
  const p = into ?? ({} as PlayerState);
  p.slot = s.s; p.x = s.x; p.y = s.y; p.z = s.z; p.vx = s.vx; p.vy = s.vy; p.vz = s.vz; p.yaw = s.yaw;
  p.grounded = s.g === 1; p.hovering = s.hv === 1; p.diving = s.dv;
  p.coyote = s.cy; p.jumpBuf = s.jb; p.jumpHeld = s.jh === 1; p.hoverFuel = s.hf; p.diveCd = s.dc; p.diveHeld = s.dh === 1; p.platformId = s.pf;
  p.stun = s.st; p.boost = s.bo; p.shield = s.sh; p.invuln = s.iv; p.respawn = s.rs;
  p.item = s.it; p.checkpoint = s.cp; p.finishRank = s.fr; p.alive = s.al === 1;
  p.useHeld = into?.useHeld ?? false; p.finishedAt = into?.finishedAt ?? -1;
  return p;
}
