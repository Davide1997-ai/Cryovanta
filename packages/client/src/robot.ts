import * as THREE from 'three';
import type { SnapPlayer } from '@cryovanta/shared';

import { PLAYER_COLORS } from '@cryovanta/shared';
export const ROBOT_COLORS: readonly number[] = PLAYER_COLORS;

const LITE = matchMedia('(pointer: coarse)').matches;
// clearcoat is expensive on mobile GPUs: phones get a standard glossy material
const glossy = (c: number): THREE.Material => LITE ? new THREE.MeshStandardMaterial({ color: c, roughness: 0.3, metalness: 0.05 }) : new THREE.MeshPhysicalMaterial({ color: c, roughness: 0.28, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.08 });
const chrome = () => new THREE.MeshStandardMaterial({ color: 0xdfe8ff, roughness: 0.18, metalness: 1 });
const emissive = (c: number, i = 2.2) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: c, emissiveIntensity: i });

/**
 * Procedural bot: clean glossy plastic shell, chrome chest/joints, neon visor. Reactive animation is driven
 * purely from simulation state (velocity, grounded, stun...) so it is identical for local and remote robots.
 */
export class Robot {
  readonly root = new THREE.Group();
  private body = new THREE.Group();   // squash/stretch + lean applied here
  private head!: THREE.Group;
  private armL!: THREE.Mesh; private armR!: THREE.Mesh;
  private flame!: THREE.Mesh; private shield!: THREE.Mesh; private trail!: THREE.Mesh; private stars = new THREE.Group();
  private small: THREE.Object3D[] = [];
  private lieT = 0; private lean = 0;
  private sq = 0; private sqV = 0; private wasGrounded = true; private lastVy = 0; private t = Math.random() * 10;

  private shellMat!: THREE.Material; private neonMat!: THREE.MeshStandardMaterial; private trailMat!: THREE.MeshBasicMaterial;
  private hat: THREE.Group = new THREE.Group(); private hatId = 0; private crownOn!: THREE.Group; private teamRing!: THREE.Mesh; private propeller: THREE.Object3D | null = null;
  private emoteId = -1; private emoteUntil = 0;

  constructor(readonly slot: number) {
    const col = ROBOT_COLORS[slot % ROBOT_COLORS.length];
    const shell = glossy(col), white = glossy(0xf2f6ff), steel = chrome(), neon = emissive(col, 2.5);
    this.shellMat = shell; this.neonMat = neon;
    const torso = new THREE.Mesh(new THREE.CapsuleGeometry(0.3, 0.2, 8, 20), shell); torso.position.y = 0.5;
    const chest = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.08, 24), steel); chest.rotation.x = Math.PI / 2; chest.position.set(0, 0.52, 0.27);
    const core = new THREE.Mesh(new THREE.SphereGeometry(0.07, 16, 12), neon); core.position.set(0, 0.52, 0.32);
    this.head = new THREE.Group(); this.head.position.y = 0.97;
    const skull = new THREE.Mesh(new THREE.SphereGeometry(0.27, 28, 20), white);
    const visor = new THREE.Mesh(new THREE.SphereGeometry(0.2, 24, 16, 0, Math.PI * 2, 0, Math.PI * 0.55), new THREE.MeshStandardMaterial({ color: 0x0b1020, roughness: 0.08, metalness: 0.3 }));
    visor.rotation.x = Math.PI / 2 - 0.2; visor.position.set(0, 0.0, 0.12); visor.scale.set(1.05, 1, 0.9);
    const eyeG = new THREE.SphereGeometry(0.045, 12, 8), eyeM = emissive(0x00f0ff, 3);
    const e1 = new THREE.Mesh(eyeG, eyeM), e2 = new THREE.Mesh(eyeG, eyeM); e1.position.set(-0.09, 0.02, 0.255); e2.position.set(0.09, 0.02, 0.255);
    const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.18, 8), steel); ant.position.y = 0.34;
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.05, 12, 8), neon); tip.position.y = 0.45;
    this.head.add(skull, visor, e1, e2, ant, tip);
    const armG = new THREE.CapsuleGeometry(0.07, 0.16, 6, 12);
    this.armL = new THREE.Mesh(armG, white); this.armR = new THREE.Mesh(armG, white); this.armL.position.set(-0.4, 0.55, 0); this.armR.position.set(0.4, 0.55, 0);
    const footG = new THREE.SphereGeometry(0.13, 16, 12);
    const fl = new THREE.Mesh(footG, steel), fr = new THREE.Mesh(footG, steel); fl.position.set(-0.15, 0.12, 0.03); fr.position.set(0.15, 0.12, 0.03); fl.scale.set(1, 0.7, 1.35); fr.scale.set(1, 0.7, 1.35);
    this.body.add(torso, chest, core, this.head, this.armL, this.armR, fl, fr);
    this.small = [this.armL, this.armR, fl, fr, e1, e2, ant, tip, core, chest]; // hidden on far robots (LOD)
    this.flame = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.6, 14, 1, true), new THREE.MeshBasicMaterial({ color: 0x58f0ff, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.flame.rotation.x = Math.PI; this.flame.position.y = -0.1; this.flame.visible = false;
    this.shield = new THREE.Mesh(new THREE.SphereGeometry(0.85, 24, 16), new THREE.MeshBasicMaterial({ color: 0x6af2ff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false })); this.shield.position.y = 0.6; this.shield.visible = false;
    this.trailMat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide });
    this.trail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.8, 16, 1, true), this.trailMat);
    this.trail.rotation.x = -Math.PI / 2; this.trail.position.set(0, 0.55, -1.0); this.trail.visible = false;
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), emissive(0xffe066, 3)); this.stars.add(s); }
    this.stars.position.y = 1.45; this.stars.visible = false;
    this.head.add(this.hat); this.hat.position.y = 0.2;
    this.crownOn = makeHat(5, 1.25); this.crownOn.position.y = 0.2; this.crownOn.visible = false; this.head.add(this.crownOn);
    this.teamRing = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.05, 8, 32), new THREE.MeshBasicMaterial({ color: 0xffffff })); this.teamRing.rotation.x = Math.PI / 2; this.teamRing.position.y = 0.07; this.teamRing.visible = false;
    this.root.add(this.body, this.flame, this.shield, this.trail, this.stars, this.teamRing);
  }

  /** Colour + hat chosen on the phone (hats are unlocked by level on the server). */
  applyLook(color: number, hat: number) {
    (this.shellMat as THREE.MeshStandardMaterial).color.setHex(color); this.neonMat.emissive.setHex(color); this.trailMat.color.setHex(color);
    if (hat !== this.hatId) { this.hat.clear(); this.propeller = null; this.hatId = hat; if (hat > 0) { const h = makeHat(hat, 1); this.hat.add(h); this.propeller = h.getObjectByName('prop') ?? null; } }
  }
  setTeam(color: number | null) { this.teamRing.visible = color !== null; if (color !== null) (this.teamRing.material as THREE.MeshBasicMaterial).color.setHex(color); }
  emote(id: number, nowMs: number) { this.emoteId = id; this.emoteUntil = nowMs + 1800; }

  /** LOD switch (small parts hidden on far robots). Split-screen sets it per viewport. */
  setDetail(on: boolean) { for (const o of this.small) o.visible = on; }

  update(dt: number, s: SnapPlayer, pos: { x: number; y: number; z: number }, camDist = 0) {
    this.t += dt;
    const detail = camDist < 24; for (const o of this.small) o.visible = detail; // LOD: far robots = 5 draw calls instead of 14
    this.root.visible = s.al === 1 && s.rs <= 0;
    this.root.position.set(pos.x, pos.y, pos.z);
    this.root.rotation.y = s.yaw;
    const speed = Math.hypot(s.vx, s.vz), grounded = s.g === 1;
    // landing squash via spring
    if (grounded && !this.wasGrounded && this.lastVy < -4) this.sqV = -Math.min(5, -this.lastVy * 0.25);
    if (!grounded && this.wasGrounded && s.vy > 3) this.sqV = 3; // take-off stretch
    this.wasGrounded = grounded; this.lastVy = s.vy;
    const target = grounded ? 0 : Math.max(-0.12, Math.min(0.22, s.vy * 0.012));
    this.sqV += ((target - this.sq) * 220 - this.sqV * 16) * dt; this.sq += this.sqV * dt;
    const sy = 1 + this.sq, sxz = 1 - this.sq * 0.55;
    this.body.scale.set(sxz, sy, sxz);
    // stumble: a hit robot falls over backwards and scrambles up again (the Stumble Guys wobble)
    this.lieT += ((s.st > 0.12 ? 1 : 0) - this.lieT) * (1 - Math.exp(-14 * dt));
    const shoving = s.ph > 0, grabbing = s.gb > 0, held = s.sl > 0;
    const lean = Math.min(1, speed / 9) * 0.28 + (s.dv > 0 ? 0.9 : 0) + (shoving ? 0.35 : 0);
    this.body.rotation.x = lean - this.lieT * 1.35; this.body.rotation.z = Math.sin(this.t * 24) * 0.12 * this.lieT + (held ? Math.sin(this.t * 18) * 0.12 : 0);
    this.body.position.y = -this.lieT * 0.18;
    const swing = grounded ? Math.sin(this.t * 16) * Math.min(1, speed / 6) * 0.9 : -0.8;
    if (shoving || grabbing) { this.armL.rotation.x = this.armR.rotation.x = -1.55 + (shoving ? Math.sin(this.t * 50) * 0.15 : 0); }
    else if (this.lieT > 0.3) { this.armL.rotation.x = Math.sin(this.t * 22) * 1.2; this.armR.rotation.x = -Math.sin(this.t * 22) * 1.2; }
    else { this.armL.rotation.x = swing; this.armR.rotation.x = -swing; }
    this.crownOn.visible = s.cr === 1; if (this.propeller) this.propeller.rotation.y += dt * 30;
    const nowMs = performance.now();
    if (nowMs < this.emoteUntil && this.lieT < 0.3) { // emote overrides the idle pose (wave / dance / angry / laugh)
      const k = (this.emoteUntil - nowMs) / 1800, e = this.t * (this.emoteId === 1 ? 10 : 18);
      if (this.emoteId === 0) { this.armR.rotation.x = -2.6; this.armR.rotation.z = Math.sin(e) * 0.5; }
      else if (this.emoteId === 1) { this.root.rotation.y += Math.sin(this.t * 8) * 0.8 + this.t; this.body.position.y = Math.abs(Math.sin(this.t * 9)) * 0.22; this.armL.rotation.z = -1.2; this.armR.rotation.z = 1.2; }
      else if (this.emoteId === 2) { this.body.rotation.z = Math.sin(e * 1.6) * 0.18; this.armL.rotation.x = this.armR.rotation.x = -0.4; this.head.rotation.z = Math.sin(e * 2) * 0.12; }
      else { this.body.position.y = Math.abs(Math.sin(this.t * 14)) * 0.12; this.head.rotation.x = -0.35 * k; this.body.rotation.x -= 0.2; }
    } else { this.armL.rotation.z = 0; this.armR.rotation.z = 0; }
    this.head.rotation.z = s.st > 0 ? Math.sin(this.t * 22) * 0.35 : 0;
    this.head.position.y = 0.97 + Math.sin(this.t * 3) * 0.008;
    this.flame.visible = s.hv === 1; this.flame.scale.y = 0.8 + Math.random() * 0.5;
    this.shield.visible = s.sh > 0; (this.shield.material as THREE.MeshBasicMaterial).opacity = 0.18 + Math.sin(this.t * 8) * 0.06;
    this.trail.visible = s.bo > 0;
    this.stars.visible = s.st > 0; this.stars.rotation.y += dt * 8;
    this.stars.children.forEach((c, i) => { const a = (i / 3) * Math.PI * 2; c.position.set(Math.cos(a) * 0.35, 0, Math.sin(a) * 0.35); });
    this.body.visible = !(s.iv > 0 && s.st <= 0 && Math.floor(this.t * 16) % 2 === 0 && s.rs <= 0 && s.iv < 1.2);
  }
}

/** Hats (also used for the crown carried by the king of the hill). scale > 1 for the bigger crown. */
function makeHat(id: number, scale = 1): THREE.Group {
  const g = new THREE.Group(), gold = new THREE.MeshStandardMaterial({ color: 0xffc933, metalness: 0.9, roughness: 0.25, emissive: 0x553300, emissiveIntensity: 0.4 });
  const mat = (c: number) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.45, metalness: 0.05 });
  if (id === 1) { const cap = new THREE.Mesh(new THREE.SphereGeometry(0.29, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), mat(0xe33b3b)); const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.025, 20, 1, false, 0, Math.PI), mat(0xb52b2b)); brim.rotation.y = Math.PI / 2; brim.position.set(0, 0.01, 0.27); g.add(cap, brim); }
  else if (id === 2) { const cone = new THREE.Mesh(new THREE.ConeGeometry(0.17, 0.42, 16), mat(0xff3df2)); cone.position.y = 0.2; const pom = new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), mat(0xffe24a)); pom.position.y = 0.44; g.add(cone, pom); }
  else if (id === 3) { const base = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.1, 12), mat(0x2f7bff)); base.position.y = 0.04; const prop = new THREE.Group(); prop.name = 'prop'; for (const a of [0, Math.PI / 2]) { const b = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.02, 0.08), mat(0xffd23d)); b.rotation.y = a; prop.add(b); } prop.position.y = 0.12; g.add(base, prop); }
  else if (id === 4) { const halo = new THREE.Mesh(new THREE.TorusGeometry(0.2, 0.03, 8, 28), new THREE.MeshBasicMaterial({ color: 0xfff3a0 })); halo.rotation.x = Math.PI / 2; halo.position.y = 0.26; g.add(halo); }
  else if (id === 5) { const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.23, 0.14, 16, 1, true), gold); ring.material.side = THREE.DoubleSide; ring.position.y = 0.07; g.add(ring); for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, s = new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.14, 6), gold); s.position.set(Math.sin(a) * 0.2, 0.2, Math.cos(a) * 0.2); g.add(s); } }
  else if (id === 6) { const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.03, 20), mat(0x151515)); const top = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.18, 0.3, 20), mat(0x151515)); top.position.y = 0.16; const band = new THREE.Mesh(new THREE.CylinderGeometry(0.182, 0.182, 0.05, 20), mat(0xd33)); band.position.y = 0.06; g.add(brim, top, band); }
  else if (id === 7) { for (const s of [-1, 1]) { const h = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.3, 8), mat(0xf0e6d2)); h.position.set(s * 0.2, 0.18, 0); h.rotation.z = -s * 0.5; g.add(h); } }
  g.scale.setScalar(scale); return g;
}
