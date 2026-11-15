/** One round of the obstacle race. Authoritative state machine, stepped at TICK_RATE by the server. */
import { DT, MAX_PLAYERS_PER_ROOM, TICK_RATE, TUNING as T } from './constants';
import { createPlayer, sanitizeInput, stepPlayer } from './controller';
import { buildMap } from './maps';
import { hazardHit } from './hazards';
import { resolveImpact, type ImpactKind, type ImpactOutcome } from './impacts';
import { ITEM_TUNING as IT, pickSeekerTarget, rollItem, stepHazard, stepSeeker, type ItemKind } from './items';
import { NEUTRAL_INPUT, type BoxState, type Course, type HazardState, type InputFrame, type PlayerState, type SeekerState } from './types';

export type RacePhase = 'countdown' | 'running' | 'ended';
export type SimEvent =
  | { t: 'pickup'; slot: number; item: ItemKind }
  | { t: 'use'; slot: number; item: ItemKind }
  | { t: 'impact'; kind: ImpactKind; victim: number; owner: number; outcome: ImpactOutcome }
  | { t: 'finish'; slot: number; rank: number }
  | { t: 'fall'; slot: number }
  | { t: 'out'; slot: number }                       // survival: eliminated
  | { t: 'grab'; slot: number; victim: number }      // grabbed someone
  | { t: 'release'; slot: number; victim: number; thrown: boolean };

export interface RaceConfig { seed: number; round: number; participants: number[]; qualify: number; mapId: string; difficulty: number; boxRespawn: number; }
export interface RaceResult { qualified: number[]; eliminated: number[]; reason: 'qualified' | 'timeout' | 'empty'; }

export const COUNTDOWN_SECONDS = 3;
export class RaceSim {
  readonly course: Course;
  tick = 0;
  phase: RacePhase = 'countdown';
  phaseTicks = COUNTDOWN_SECONDS * TICK_RATE;
  roundTicksLeft: number;
  players: PlayerState[] = [];
  boxes: BoxState[];
  seekers: SeekerState[] = [];
  hazards: HazardState[] = [];
  rankOf: number[] = new Array(MAX_PLAYERS_PER_ROOM).fill(0);
  events: SimEvent[] = [];
  result: RaceResult | null = null;
  rng: number;
  private nextId = 1;
  private finishCounter = 0;
  /** how many robots already crossed the finish line */
  get finishers() { return this.finishCounter; }
  get survival() { return !!this.course.survival; }
  private hazardCarry = new Map<number, { v: number }>();
  /** last frame actually consumed per slot (for ack + repeat-last on starvation) is kept by the server session. */

  constructor(readonly cfg: RaceConfig) {
    this.course = buildMap(cfg.mapId, cfg.seed, cfg.difficulty);
    this.rng = (cfg.seed ^ 0x9e3779b9) >>> 0;
    this.boxes = this.course.boxes.map((b) => ({ id: b.id, cooldown: 0 }));
    for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) {
      const p = createPlayer(s, this.course.spawnPoints[s]);
      p.alive = cfg.participants.includes(s);
      p.grounded = true;
      this.players.push(p);
    }
    const roundSeconds = this.course.survival ? 120 : 40 + this.course.length * 0.45;
    this.roundTicksLeft = Math.round(roundSeconds * TICK_RATE);
    this.computeRanks();
  }

  get active(): PlayerState[] { return this.players.filter((p) => p.alive); }

  removePlayer(slot: number) {
    const p = this.players[slot];
    if (p) { p.alive = false; p.item = null; }
  }

  step(inputs: (InputFrame | undefined)[]): void {
    this.events.length = 0;
    this.tick++;
    if (this.phase === 'ended') return;
    if (this.phase === 'countdown') {
      if (--this.phaseTicks <= 0) this.phase = 'running';
      return;
    }
    // ---- 1. players ----
    for (const p of this.players) {
      if (!p.alive) continue;
      const raw = p.finishRank > 0 ? NEUTRAL_INPUT : inputs[p.slot] ? sanitizeInput(inputs[p.slot]!) : NEUTRAL_INPUT;
      const wasDown = p.respawn > 0;
      stepPlayer(p, raw, this.course, this.tick);
      if (!wasDown && p.respawn > 0) {
        if (this.course.survival) { this.eliminate(p); continue; } // falling is final in survival rounds
        this.events.push({ t: 'fall', slot: p.slot });
      }
      const useEdge = raw.use && !p.useHeld;
      p.useHeld = raw.use;
      if (useEdge && p.item && p.stun <= 0 && p.respawn <= 0 && p.finishRank === 0) this.useItem(p);
    }
    this.computeRanks();
    this.pickups();
    this.stepSeekers();
    this.stepHazards();
    this.obstacles();
    this.shoves();
    this.grabs();
    this.contacts();
    this.checkFinish();
    this.checkEnd();
  }

  // ------------------------------------------------------------------ items
  private useItem(p: PlayerState) {
    const kind = p.item!;
    const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
    let used = true;
    switch (kind) {
      case 'boost':
        p.boost = Math.max(p.boost, IT.boostTime);
        p.vx += fx * IT.boostKick; p.vz += fz * IT.boostKick;
        break;
      case 'shield':
        p.shield = IT.shieldTime;
        break;
      case 'seeker': {
        if (this.seekers.filter((s) => s.owner === p.slot).length >= IT.seekerMaxLive) { used = false; break; }
        this.seekers.push({
          id: this.nextId++, owner: p.slot, target: pickSeekerTarget(this.players, this.rankOf, p.slot),
          x: p.x + fx * 1.1, y: p.y + 0.8, z: p.z + fz * 1.1, vx: fx * IT.seekerSpeed, vy: 0, vz: fz * IT.seekerSpeed, life: IT.seekerLife,
        });
        break;
      }
      case 'hazard': {
        if (this.hazards.filter((h) => h.owner === p.slot).length >= IT.hazardMaxLive) { used = false; break; }
        this.hazards.push({
          id: this.nextId++, owner: p.slot, x: p.x - fx * 1.1, y: p.y + 0.3, z: p.z - fz * 1.1,
          vx: -fx * 2.5 + p.vx * 0.3, vy: 3.5, vz: -fz * 2.5 + p.vz * 0.3, armed: IT.hazardArm, life: IT.hazardLife,
        });
        break;
      }
    }
    if (!used) return; // cap reached: keep the item
    p.item = null;
    this.events.push({ t: 'use', slot: p.slot, item: kind });
  }

  private pickups() {
    const r2 = IT.boxPickupRadius * IT.boxPickupRadius;
    const n = this.active.length;
    for (const b of this.boxes) {
      if (b.cooldown > 0) { b.cooldown -= DT; continue; }
      const def = this.course.boxes[b.id];
      for (const p of this.players) {
        if (!p.alive || p.item || p.respawn > 0 || p.finishRank > 0) continue;
        const dx = p.x - def.x, dy = p.y + 0.55 - def.y, dz = p.z - def.z;
        if (dx * dx + dy * dy + dz * dz < r2) {
          const rankFrac = n > 1 ? this.rankOf[p.slot] / (n - 1) : 0;
          p.item = rollItem(this, rankFrac);
          b.cooldown = this.cfg.boxRespawn;
          this.events.push({ t: 'pickup', slot: p.slot, item: p.item });
          break;
        }
      }
    }
  }

  private stepSeekers() {
    this.seekers = this.seekers.filter((s) => {
      stepSeeker(s, this.players);
      if (s.life <= 0 || s.y < this.course.killY) return false;
      for (const p of this.players) {
        if (!p.alive || p.slot === s.owner) continue;
        const dx = p.x - s.x, dy = p.y + 0.55 - s.y, dz = p.z - s.z;
        if (dx * dx + dy * dy + dz * dz > IT.seekerHitRadius * IT.seekerHitRadius) continue;
        const res = resolveImpact({ kind: 'seeker', owner: s.owner, x: s.x, y: s.y, z: s.z, vx: s.vx, vz: s.vz }, p);
        if (res.outcome !== 'ignored') this.events.push({ t: 'impact', kind: 'seeker', victim: p.slot, owner: s.owner, outcome: res.outcome });
        if (res.consumeSource) return false;
      }
      return true;
    });
  }

  private stepHazards() {
    this.hazards = this.hazards.filter((h) => {
      let carry = this.hazardCarry.get(h.id);
      if (!carry) this.hazardCarry.set(h.id, (carry = { v: -1 }));
      stepHazard(h, this.course, this.tick, carry);
      if (h.life <= 0) { this.hazardCarry.delete(h.id); return false; }
      if (h.armed > 0) return true;
      const age = IT.hazardLife - h.life;
      for (const p of this.players) {
        if (!p.alive || (p.slot === h.owner && age < IT.hazardOwnerGrace)) continue;
        const reach = IT.hazardHalf + 0.4;
        if (Math.abs(p.x - h.x) > reach || Math.abs(p.z - h.z) > reach) continue;
        if (p.y > h.y + IT.hazardHalf * 2 || p.y + 1.1 < h.y) continue;
        const res = resolveImpact({ kind: 'hazard', owner: h.owner, x: h.x, y: h.y, z: h.z, vx: 0, vz: 0 }, p);
        if (res.outcome !== 'ignored') this.events.push({ t: 'impact', kind: 'hazard', victim: p.slot, owner: h.owner, outcome: res.outcome });
        if (res.consumeSource) { this.hazardCarry.delete(h.id); return false; }
      }
      return true;
    });
  }

  /** Giant course hazards (spinners, hammers, rollers). Poses are a pure function of the tick. */
  private obstacles() {
    const hz = this.course.hazards;
    if (!hz.length) return;
    for (const p of this.players) {
      if (!p.alive || p.respawn > 0 || p.finishRank > 0 || p.invuln > 0 && p.shield <= 0) continue;
      for (const h of hz) {
        if (Math.abs(h.z - p.z) > h.len + 4 && h.kind !== 'roller') continue; // cheap reject
        const hit = hazardHit(h, this.tick, p.x, p.y, p.z);
        if (!hit) continue;
        const res = resolveImpact({ kind: 'obstacle', owner: -1, x: hit.x, y: hit.y, z: hit.z, vx: hit.dx, vz: hit.dz }, p);
        if (res.outcome !== 'ignored') { this.events.push({ t: 'impact', kind: 'obstacle', victim: p.slot, owner: -1, outcome: res.outcome }); break; }
      }
    }
  }

  // ------------------------------------------------------------------ dirty play
  private ok(q: PlayerState) { return q.alive && q.respawn <= 0 && q.finishRank === 0; }

  /** Shove button: knocks back everyone in a short cone in front. Pressing it while holding someone THROWS them. */
  private shoves() {
    for (const p of this.players) {
      if (!p.alive || !p.pushReq) continue;
      p.pushReq = false;
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      if (p.grabTarget >= 0) { // throw
        const q = this.players[p.grabTarget], thrown = this.ok(q);
        this.releaseGrab(p);
        if (thrown) {
          q.vx = fx * 15; q.vz = fz * 15; q.vy = 6.5; q.stun = 0.7; q.invuln = 0.5; q.slow = 0; q.grounded = false; q.platformId = -1; q.hovering = false;
          this.events.push({ t: 'release', slot: p.slot, victim: q.slot, thrown: true }, { t: 'impact', kind: 'shove', victim: q.slot, owner: p.slot, outcome: 'hit' });
        }
        continue;
      }
      for (const q of this.players) {
        if (q === p || !this.ok(q) || Math.abs(q.y - p.y) > 1.1) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
        if (d > T.pushRange || d < 1e-3 || (dx * fx + dz * fz) / d < 0.35) continue;
        const res = resolveImpact({ kind: 'shove', owner: p.slot, x: p.x, y: p.y, z: p.z, vx: fx, vz: fz, power: p.boost > 0 ? 1.25 : 1 }, q);
        if (res.outcome !== 'ignored') this.events.push({ t: 'impact', kind: 'shove', victim: q.slot, owner: p.slot, outcome: res.outcome });
      }
    }
  }

  private releaseGrab(p: PlayerState) {
    if (p.grabTarget < 0) return;
    const victim = p.grabTarget; p.grabTarget = -1; p.grabbing = 0; p.grabCd = T.grabCooldown;
    this.events.push({ t: 'release', slot: p.slot, victim, thrown: false });
  }

  /** Grab (hold): drag the robot in front of you, slowing both. Lasts a few seconds, then a cooldown. */
  private grabs() {
    for (const p of this.players) {
      if (!p.alive) continue;
      const fx = Math.sin(p.yaw), fz = Math.cos(p.yaw);
      if (p.grabTarget >= 0) {
        const q = this.players[p.grabTarget];
        if (!p.grabHeld || p.grabbing <= 0 || !this.ok(q) || p.stun > 0 || p.respawn > 0 || Math.hypot(q.x - p.x, q.z - p.z) > T.grabRange * 1.6) { this.releaseGrab(p); continue; }
        q.x += (p.x + fx * 1.15 - q.x) * 0.3; q.z += (p.z + fz * 1.15 - q.z) * 0.3; q.vx *= 0.6; q.vz *= 0.6; q.slow = 0.12; // keep them slowed while held
        continue;
      }
      if (!p.grabHeld || p.grabCd > 0 || p.stun > 0 || p.respawn > 0 || p.finishRank > 0) continue;
      let best: PlayerState | null = null, bd = 1e9;
      for (const q of this.players) {
        if (q === p || !this.ok(q) || Math.abs(q.y - p.y) > 1.1 || q.invuln > 0.6) continue;
        const dx = q.x - p.x, dz = q.z - p.z, d = Math.hypot(dx, dz);
        if (d > T.grabRange || d < 1e-3 || (dx * fx + dz * fz) / d < 0.2 || d >= bd) continue;
        best = q; bd = d;
      }
      if (!best) continue;
      if (best.shield > 0) { best.shield = 0; best.invuln = 0.6; this.events.push({ t: 'impact', kind: 'shove', victim: best.slot, owner: p.slot, outcome: 'blocked' }); p.grabCd = 1; continue; }
      p.grabTarget = best.slot; p.grabbing = T.grabMax; best.slow = 0.12;
      this.events.push({ t: 'grab', slot: p.slot, victim: best.slot });
    }
  }

  /** Robot-vs-robot: soft separation (reactive bumping) + dive shoves. */
  private contacts() {
    const R = T.bumpRadius;
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (!a.alive || a.respawn > 0 || a.finishRank > 0) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const b = ps[j];
        if (!b.alive || b.respawn > 0 || b.finishRank > 0) continue;
        const dx = b.x - a.x, dz = b.z - a.z;
        if (Math.abs(b.y - a.y) > 0.9) continue;
        const d = Math.hypot(dx, dz);
        const reach = a.diving > 0 || b.diving > 0 ? R * 1.35 : R;
        if (d >= reach) continue;
        for (const [att, vic] of [[a, b], [b, a]] as const) {
          if (att.diving > 0 && vic.diving <= 0) {
            const res = resolveImpact({ kind: 'dive', owner: att.slot, x: att.x, y: att.y, z: att.z, vx: att.vx, vz: att.vz }, vic);
            if (res.outcome !== 'ignored') this.events.push({ t: 'impact', kind: 'dive', victim: vic.slot, owner: att.slot, outcome: res.outcome });
          }
        }
        if (d < R) {
          const nx = d > 1e-4 ? dx / d : 1, nz = d > 1e-4 ? dz / d : 0;
          const overlap = R - d;
          a.x -= nx * overlap * 0.5; a.z -= nz * overlap * 0.5;
          b.x += nx * overlap * 0.5; b.z += nz * overlap * 0.5;
          const k = (T.bumpImpulse * overlap) / R;
          // ramming: running into someone fast knocks them back and staggers them
          const closing = (a.vx - b.vx) * nx + (a.vz - b.vz) * nz;
          if (closing > T.rammingSpeed) {
            const aIsAttacker = a.vx * nx + a.vz * nz > -(b.vx * nx + b.vz * nz), att = aIsAttacker ? a : b, vic = aIsAttacker ? b : a, sg = aIsAttacker ? 1 : -1;
            const res = resolveImpact({ kind: 'bump', owner: att.slot, x: att.x, y: att.y, z: att.z, vx: nx * sg, vz: nz * sg, power: Math.min(1.7, closing / 7) }, vic);
            if (res.outcome !== 'ignored') this.events.push({ t: 'impact', kind: 'bump', victim: vic.slot, owner: att.slot, outcome: res.outcome });
          } else { a.vx -= nx * k; a.vz -= nz * k; b.vx += nx * k; b.vz += nz * k; }
        }
      }
    }
  }

  // ------------------------------------------------------------------ race flow
  private computeRanks() {
    if (this.course.survival) { // alive first, then the dead by elimination time (later = better)
      const all = this.players.filter((p) => this.cfg.participants.includes(p.slot));
      all.sort((a, b) => (a.alive !== b.alive ? (a.alive ? -1 : 1) : a.alive ? 0 : b.outAt - a.outAt));
      all.forEach((p, i) => { this.rankOf[p.slot] = i; });
      return;
    }
    const ps = this.players.filter((p) => p.alive || p.finishRank > 0);
    ps.sort((a, b) => {
      if (a.finishRank && b.finishRank) return a.finishRank - b.finishRank;
      if (a.finishRank) return -1;
      if (b.finishRank) return 1;
      return b.z - a.z;
    });
    ps.forEach((p, i) => { this.rankOf[p.slot] = i; });
  }

  private checkFinish() {
    for (const p of this.players) {
      if (!p.alive || p.finishRank > 0 || p.respawn > 0) continue;
      if (p.z > this.course.finishZ && p.grounded) {
        p.finishRank = ++this.finishCounter; p.finishedAt = this.tick;
        this.events.push({ t: 'finish', slot: p.slot, rank: p.finishRank });
      }
    }
  }

  private eliminate(p: PlayerState) {
    p.alive = false; p.outAt = this.tick; p.respawn = 0; p.item = null; this.releaseGrab(p);
    for (const o of this.players) if (o.grabTarget === p.slot) this.releaseGrab(o);
    this.events.push({ t: 'out', slot: p.slot });
  }

  private checkEnd() {
    if (this.course.survival) {
      const alive = this.active, timeout = --this.roundTicksLeft <= 0, solo = this.cfg.participants.length === 1;
      if (!timeout && (solo ? alive.length === 1 : alive.length > 1)) return; // still fighting
      const out = this.cfg.participants.filter((s) => !this.players[s].alive).sort((a, b) => this.players[b].outAt - this.players[a].outAt);
      const winners = alive.map((p) => p.slot);
      return this.end(winners.length ? [winners[0]] : out.slice(0, 1), timeout && alive.length > 1 ? 'timeout' : 'qualified', winners.slice(1).concat(out).filter((s) => s !== (winners[0] ?? out[0])));
    }
    const act = this.active;
    const finished = act.filter((p) => p.finishRank > 0).sort((a, b) => a.finishRank - b.finishRank);
    const allDone = act.length > 0 && finished.length === act.length;
    const quota = finished.length >= this.cfg.qualify;
    const timeout = --this.roundTicksLeft <= 0;
    if (act.length === 0) return this.end([], 'empty');
    if (!(allDone || quota || timeout)) return;
    const qualified = finished.slice(0, this.cfg.qualify).map((p) => p.slot);
    if (qualified.length < this.cfg.qualify) {
      // timeout: fill the remaining spots with the furthest-progressed runners so the match never stalls
      const rest = act.filter((p) => p.finishRank === 0).sort((a, b) => b.z - a.z);
      for (const p of rest) if (qualified.length < Math.min(this.cfg.qualify, act.length)) qualified.push(p.slot);
    }
    this.end(qualified, quota || allDone ? 'qualified' : 'timeout');
  }

  private end(qualified: number[], reason: RaceResult['reason'], eliminated?: number[]) {
    this.phase = 'ended';
    const order = [...this.cfg.participants].sort((a, b) => this.rankOf[a] - this.rankOf[b]);
    this.result = { qualified, eliminated: eliminated ?? order.filter((s) => !qualified.includes(s)), reason };
  }
}
