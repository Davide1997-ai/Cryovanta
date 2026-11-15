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
  private sq = 0; private sqV = 0; private wasGrounded = true; private lastVy = 0; private t = Math.random() * 10;

  constructor(readonly slot: number) {
    const col = ROBOT_COLORS[slot % ROBOT_COLORS.length];
    const shell = glossy(col), white = glossy(0xf2f6ff), steel = chrome(), neon = emissive(col, 2.5);
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
    this.trail = new THREE.Mesh(new THREE.ConeGeometry(0.35, 1.8, 16, 1, true), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    this.trail.rotation.x = -Math.PI / 2; this.trail.position.set(0, 0.55, -1.0); this.trail.visible = false;
    for (let i = 0; i < 3; i++) { const s = new THREE.Mesh(new THREE.OctahedronGeometry(0.06), emissive(0xffe066, 3)); this.stars.add(s); }
    this.stars.position.y = 1.45; this.stars.visible = false;
    this.root.add(this.body, this.flame, this.shield, this.trail, this.stars);
  }

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
    this.body.rotation.x = Math.min(1, speed / 9) * 0.28 + (s.dv > 0 ? 0.9 : 0);
    const swing = grounded ? Math.sin(this.t * 16) * Math.min(1, speed / 6) * 0.9 : -0.8;
    this.armL.rotation.x = swing; this.armR.rotation.x = -swing;
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
