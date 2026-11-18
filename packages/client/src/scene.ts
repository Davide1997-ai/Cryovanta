import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Sky } from 'three/examples/jsm/objects/Sky.js';
import { blinkPhase, groundBelow, hazardPose, platformCenter, windActive, type Course, type CourseHazard, type Platform, type Theme } from '@cryovanta/shared';
import type { Rect } from './layout';
import { bannerTexture, checkerStrip, cloudTexture, scaleBoxUV, surfaceTexture, texVersion, waterNormal, windTexture, type TexKind } from './textures';
import { models } from './assets';

export const NEON = [0x00e5ff, 0xff3df2, 0x7cff3a, 0xffb020, 0x8a6bff, 0xff4d4d];

/**
 * Stage: owns the three.js scene. Themes: 'neon' (sci-fi space), 'sunny' (giant daylight obstacle park, PBR textures,
 * physical sky, soft shadows, water) and 'frost' (snowy variant). Pure view: owns no game state.
 */
export class Stage {
  renderer: THREE.WebGLRenderer;
  scene = new THREE.Scene();
  camera = new THREE.PerspectiveCamera(62, 1, 0.1, 600);
  composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private courseGroup = new THREE.Group();
  private envGroup = new THREE.Group();
  private platMeshes: { mesh: THREE.Object3D; id: number }[] = [];
  boxMeshes: THREE.Object3D[] = [];
  private course: Course | null = null;
  private time = 0;
  private theme: Theme | null = null;
  private pmrem: THREE.PMREMGenerator;
  private sun: THREE.DirectionalLight | null = null;
  private water: THREE.Mesh | null = null; private waterTex: THREE.Texture | null = null;
  private snow: THREE.Points | null = null;
  private blinkMeshes: { p: Platform; mesh: THREE.Mesh; ghost: THREE.LineSegments; mat: THREE.MeshStandardMaterial }[] = [];
  private belts: { tex: THREE.Texture; fx: number; fz: number }[] = [];
  private hazardObjs: { h: CourseHazard; obj: THREE.Object3D; rope?: THREE.Mesh }[] = [];
  private zoneObjs: { z: Course['zones'][number]; mesh: THREE.Mesh; tex: THREE.Texture }[] = [];
  private blobs: THREE.Mesh[] = [];
  private timed: { p: Platform; g: THREE.Object3D; mat: THREE.MeshStandardMaterial }[] = [];
  private crownObj: THREE.Group | null = null;
  private bubbles: { sp: THREE.Sprite; t: number; x: number; y: number; z: number }[] = [];
  private emojiTex = new Map<string, THREE.CanvasTexture>();
  private links: THREE.Mesh[] = [];
  private conf!: { pts: THREE.Points; pos: Float32Array; col: Float32Array; vel: Float32Array; life: Float32Array; n: number; head: number; alive: number };
  /** distance culling along the track (the park maps are ~650 units long) */
  private cullables: { obj: THREE.Object3D; z: number; r: number }[] = [];
  /** phones/tablets: no post-processing/shadows, lower pixel ratio (battery + 7-player load) */
  readonly lite = matchMedia('(pointer: coarse)').matches;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    this.baseDpr = Math.min(devicePixelRatio, 1.5); this.renderer.setPixelRatio(this.baseDpr);
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.85;
    if (!this.lite) { this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap; }
    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.add(this.envGroup, this.courseGroup);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.bloom = new UnrealBloomPass(new THREE.Vector2(512, 512), 0.55, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.resize(); addEventListener('resize', () => this.resize());
  }

  resize() {
    const w = innerWidth, h = innerHeight;
    this.renderer.setSize(w, h, false); this.composer.setSize(w, h);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
  }

  // ------------------------------------------------------------------ environments
  setTheme(theme: Theme) {
    if (this.theme === theme) return;
    this.theme = theme;
    this.envGroup.clear(); this.sun = null; this.water = null; this.snow = null; this.fogBase = 0;
    if (theme === 'neon') this.envNeon(); else this.envDay(theme);
  }

  private envNeon() {
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture; // studio reflections => toy plastic / chrome
    this.scene.environmentIntensity = 0.35; this.renderer.toneMappingExposure = 0.85;
    this.scene.fog = new THREE.FogExp2(0x0a0b24, 0.007); this.camera.far = 600; this.camera.updateProjectionMatrix();
    this.bloom.strength = 0.55; this.bloom.threshold = 0.92;
    const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(-20, 40, -10);
    this.envGroup.add(this.skyNeon(), this.stars(), new THREE.HemisphereLight(0x9fb8ff, 0x2a1450, 0.55), sun);
  }

  private makeSky(elev: number, azim: number, turbidity: number, rayleigh: number) {
    const sky = new Sky(); sky.scale.setScalar(1400);
    const u = sky.material.uniforms; u.turbidity.value = turbidity; u.rayleigh.value = rayleigh; u.mieCoefficient.value = 0.004; u.mieDirectionalG.value = 0.82;
    const dir = new THREE.Vector3().setFromSphericalCoords(1, THREE.MathUtils.degToRad(90 - elev), THREE.MathUtils.degToRad(azim));
    u.sunPosition.value.copy(dir); return { sky, dir };
  }

  /** Daylight: physical sky (also used as the image-based light => reflections match the sky), soft sun shadows, water, clouds. */
  private envDay(theme: Theme) {
    const frost = theme === 'frost';
    const { sky, dir } = this.makeSky(frost ? 22 : 40, 150, frost ? 9 : 3.5, frost ? 2.6 : 1.3);
    const envScene = new THREE.Scene(); envScene.add(this.makeSky(frost ? 22 : 40, 150, frost ? 9 : 3.5, frost ? 2.6 : 1.3).sky);
    this.scene.environment = this.pmrem.fromScene(envScene).texture;
    this.scene.environmentIntensity = frost ? 0.75 : 0.6; this.renderer.toneMappingExposure = frost ? 0.42 : 0.48;
    this.scene.fog = new THREE.FogExp2(frost ? 0xd5e4ee : 0xa9c6e0, (frost ? 0.0042 : 0.0022) * (this.lite ? 2.2 : 1));
    this.camera.far = 1800; this.camera.updateProjectionMatrix();
    this.bloom.strength = 0.22; this.bloom.threshold = 0.96;
    const sun = new THREE.DirectionalLight(frost ? 0xeaf2ff : 0xfff0d8, frost ? 2.2 : 3.2);
    sun.position.copy(dir).multiplyScalar(120); this.sun = sun;
    if (!this.lite) {
      sun.castShadow = true; sun.shadow.mapSize.set(2048, 2048); const c = sun.shadow.camera; c.left = -48; c.right = 48; c.top = 48; c.bottom = -48; c.near = 10; c.far = 320; sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
    }
    this.envGroup.add(sky, sun, sun.target, new THREE.HemisphereLight(frost ? 0xdbeaff : 0xbfdcff, frost ? 0x8fa6b8 : 0x6b7a4a, 0.28));
    // water / sea of jelly far below the course
    this.waterTex = waterNormal(this.lite ? 128 : 256); this.waterTex.repeat.set(220, 220);
    const wm = this.lite ? new THREE.MeshStandardMaterial({ color: frost ? 0x9fd3e6 : 0x1f93ad, roughness: 0.15, metalness: 0.05 })
      : new THREE.MeshPhysicalMaterial({ color: frost ? 0x9fd3e6 : 0x1b8fb0, roughness: 0.06, metalness: 0.0, clearcoat: 0.6, normalMap: this.waterTex, normalScale: new THREE.Vector2(0.55, 0.55), envMapIntensity: 1.3 });
    this.water = new THREE.Mesh(new THREE.PlaneGeometry(4000, 4000), wm); this.water.rotation.x = -Math.PI / 2; this.water.receiveShadow = !this.lite;
    this.envGroup.add(this.water);
    // clouds
    const ct = cloudTexture(), r = (i: number) => ((Math.sin(i * 91.3) * 43758.5453) % 1 + 1) % 1;
    for (let i = 0; i < (this.lite ? 8 : 18); i++) {
      const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: ct, transparent: true, opacity: frost ? 0.9 : 0.8, depthWrite: false, fog: false }));
      s.scale.set(220 + r(i) * 200, 90 + r(i + 5) * 60, 1); s.position.set((r(i + 9) - 0.5) * 900, 140 + r(i + 3) * 90, (r(i + 17)) * 900 - 80); this.envGroup.add(s);
    }
    if (frost && !this.lite) { // falling snow
      const n = 700, pos = new Float32Array(n * 3); for (let i = 0; i < n; i++) pos.set([(r(i) - 0.5) * 60, r(i + 1) * 30, (r(i + 2) - 0.5) * 60], i * 3);
      const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      this.snow = new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 0.12, transparent: true, opacity: 0.85, depthWrite: false }));
      this.snow.frustumCulled = false; this.envGroup.add(this.snow);
    }
  }

  private skyNeon() {
    const mat = new THREE.ShaderMaterial({
      side: THREE.BackSide, depthWrite: false, fog: false,
      uniforms: { top: { value: new THREE.Color(0x05061a) }, mid: { value: new THREE.Color(0x2a0f5c) }, bot: { value: new THREE.Color(0xff3df2) } },
      vertexShader: 'varying vec3 p; void main(){ p = normalize(position); gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 mid; uniform vec3 bot; varying vec3 p; void main(){ float h = p.y; vec3 c = h>0.0 ? mix(mid, top, pow(h,0.6)) : mix(mid, bot, pow(-h,0.5)); gl_FragColor = vec4(c,1.0); }',
    });
    return new THREE.Mesh(new THREE.SphereGeometry(450, 32, 16), mat);
  }
  private stars() {
    const n = 1400, pos = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) { const v = new THREE.Vector3().randomDirection().multiplyScalar(400); pos.set([v.x, v.y, v.z], i * 3); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(g, new THREE.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false }));
  }

  // ------------------------------------------------------------------ course construction
  buildCourse(course: Course) {
    this.setTheme(course.theme);
    this.course = course;
    this.courseGroup.clear(); this.platMeshes = []; this.boxMeshes = []; this.blinkMeshes = []; this.belts = []; this.hazardObjs = []; this.zoneObjs = []; this.cullables = []; this.timed = []; this.crownObj = null;
    if (course.theme === 'neon') this.buildNeonCourse(course); else this.buildParkCourse(course);
    if (this.water) this.water.position.y = course.killY + 8;
  }

  /** Re-create the current course (used when Blender-baked textures / meshes finish loading). */
  rebuild() { if (this.course) this.buildCourse(this.course); }

  private matCache = new Map<string, THREE.Material>();
  private mat(key: string, make: () => THREE.Material) { let m = this.matCache.get(key); if (!m) { m = make(); this.matCache.set(key, m); } return m; }

  private buildNeonCourse(course: Course) {
    const lite = this.lite;
    // Draw-call budget: one top mesh + one merged trim per platform on phones (was 8 per platform).
    const panel = this.mat('panel', () => new THREE.MeshStandardMaterial({ color: 0x1a2142, metalness: 0.55, roughness: 0.55 }));
    for (const p of course.platforms) {
      const g = new THREE.Group();
      const top = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2), panel);
      const col = p.kind === 'piston' ? 0xff4d4d : NEON[p.hue % NEON.length];
      const trimMat = this.mat('trim' + col, () => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: col, emissiveIntensity: p.kind === 'piston' ? 2.4 : 1.8 }));
      // neon FRAME on the top face: 4 bars merged into ONE geometry => one draw call
      const t = 0.09, y = p.hy + 0.005, bars: THREE.BufferGeometry[] = [];
      const bar = (w: number, d: number, x: number, z: number) => { const bg = new THREE.BoxGeometry(w, 0.04, d); bg.translate(x, y, z); bars.push(bg); };
      bar(p.hx * 2, t, 0, p.hz - t / 2); bar(p.hx * 2, t, 0, -p.hz + t / 2); bar(t, p.hz * 2 - 2 * t, p.hx - t / 2, 0); bar(t, p.hz * 2 - 2 * t, -p.hx + t / 2, 0);
      const trim = new THREE.Mesh(mergeGeometries(bars)!, trimMat);
      g.add(top, trim);
      if (!lite) { // desktop-only extras
        g.add(new THREE.LineSegments(new THREE.EdgesGeometry(top.geometry), new THREE.LineBasicMaterial({ color: col })));
        const glow = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 1.4, 0.05, p.hz * 1.4), this.mat('glow' + col, () => new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.55 })));
        glow.position.y = -p.hy - 0.03; g.add(glow);
      }
      this.courseGroup.add(g);
      this.platMeshes.push({ mesh: g, id: p.id });
    }
    // finish gate: neon arch
    const fz = course.finishZ, arch = new THREE.Group();
    const m = new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xffffff, emissiveIntensity: 2.5 });
    const L = new THREE.Mesh(new THREE.BoxGeometry(0.4, 8, 0.4), m), R = L.clone(), T = new THREE.Mesh(new THREE.BoxGeometry(16.4, 0.5, 0.5), m);
    L.position.set(-8, 4, 0); R.position.set(8, 4, 0); T.position.set(0, 8, 0); arch.add(L, R, T);
    const goal = course.platforms[course.platforms.length - 1];
    const sign = new THREE.Mesh(new THREE.BoxGeometry(14, 3.4, 0.5), new THREE.MeshBasicMaterial({ map: bannerTexture('FINISH'), fog: false })); sign.position.y = 6.2; arch.add(sign);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(16, 2.2), new THREE.MeshBasicMaterial({ map: checkerStrip() })); strip.rotation.x = -Math.PI / 2; strip.position.y = 0.04; arch.add(strip);
    arch.position.set(0, goal.y + goal.hy, fz); this.courseGroup.add(arch);
    // item boxes (shared geometry/materials; colour is animated per box)
    const cubeGeo = models.item_box ? models.item_box.clone().scale(0.9, 0.9, 0.9) : new THREE.BoxGeometry(0.9, 0.9, 0.9), ringGeo = new THREE.TorusGeometry(0.75, 0.035, 6, 24), ringMat = new THREE.MeshBasicMaterial({ color: 0x00e5ff });
    for (const b of course.boxes) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff3df2, emissiveIntensity: 1.4, roughness: 0.2 }));
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2; g.add(cube, ring); g.position.set(b.x, b.y, b.z);
      this.courseGroup.add(g); this.boxMeshes[b.id] = g;
    }
    // distant floating decor (fewer on phones)
    const decorN = lite ? 8 : 26, decorGeo = new THREE.IcosahedronGeometry(1, 1), decorMat = new THREE.MeshStandardMaterial({ color: 0x1a1f44, metalness: 0.7, roughness: 0.4, flatShading: true });
    for (let i = 0; i < decorN; i++) {
      const k = lite ? 26 / decorN : 1, j = Math.floor(i * k);
      const m2 = new THREE.Mesh(decorGeo, decorMat); m2.scale.setScalar(3 + (j * 7919 % 13));
      m2.position.set((j % 2 ? 1 : -1) * (40 + (j * 31) % 55), -20 + ((j * 17) % 60), (j / 26) * (course.length + 60) - 20);
      this.courseGroup.add(m2);
    }
  }


  // ---- giant daylight obstacle park (Titan Gauntlet / Frost Run) ----
  private parkMat(kind: TexKind, frost: boolean, key = ''): THREE.MeshStandardMaterial {
    return this.mat('park' + kind + frost + key + texVersion(), () => {
      const t = surfaceTexture(frost && kind === 'grass' ? 'snow' : kind, this.lite ? 128 : 256);
      const rough = { concrete: 0.9, wood: 0.7, candy: 0.35, grass: 0.95, metal: 0.4, conveyor: 0.6, bounce: 0.3, ice: 0.12, slime: 0.15, stripes: 0.5, snow: 0.85, stripesRW: 0.4 }[kind];
      const metal = kind === 'metal' ? 0.8 : 0;
      const rmap = t.rough, rr = rmap ? 1 : rough; // baked sets carry their own roughness map (absolute values)
      const coat = kind === 'ice' || kind === 'slime' || kind === 'bounce' || kind === 'candy';
      // baked sets already carry their relief in the albedo/roughness: no screen-space bump (costly with 7 split views) and the cheaper
      // standard shader unless the surface needs a clear-coat
      const m = this.lite || (rmap && !coat) ? new THREE.MeshStandardMaterial({ map: t.map, roughnessMap: rmap, roughness: rr, metalness: metal, bumpMap: !this.lite && !rmap ? t.bump : null, bumpScale: 1.2 })
        : new THREE.MeshPhysicalMaterial({ map: t.map, bumpMap: rmap ? null : t.bump, bumpScale: kind === 'ice' ? 0.2 : 1.2, roughnessMap: rmap, roughness: rr, metalness: metal, clearcoat: coat ? 0.8 : 0, clearcoatRoughness: 0.15 });
      if (frost && kind !== 'ice') m.color.setHex(0xeaf4ff);
      return m;
    }) as THREE.MeshStandardMaterial;
  }
  private skinKind(p: Platform, frost: boolean): TexKind {
    if (p.kind === 'piston') return 'stripes';
    const s = p.surface ?? 'normal';
    if (s === 'conveyor') return 'conveyor'; if (s === 'bounce') return 'bounce'; if (s === 'ice') return 'ice'; if (s === 'slime') return 'slime';
    if (p.kind === 'blink') return frost ? 'ice' : 'candy';
    return (['concrete', 'wood', 'candy', 'grass', 'metal'] as TexKind[])[(p.skin ?? 0) % 5];
  }

  private buildParkCourse(course: Course) {
    const frost = course.theme === 'frost', lite = this.lite;
    const under = this.parkMat('concrete', frost, 'under'); 
    for (const p of course.platforms) {
      const g = new THREE.Group();
      const kind = this.skinKind(p, frost);
      const geo = new THREE.BoxGeometry(p.hx * 2, p.hy * 2, p.hz * 2); scaleBoxUV(geo, p.hx, p.hy, p.hz, kind === 'conveyor' || kind === 'bounce' ? 6 : 4);
      let material: THREE.Material = this.parkMat(kind, frost);
      const mesh = new THREE.Mesh(geo, material);
      if (kind === 'conveyor') { // each belt animates its own texture offset
        const base = surfaceTexture('conveyor', lite ? 128 : 256), tex = base.map.clone(); tex.needsUpdate = true; tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
        material = (material as THREE.MeshStandardMaterial).clone(); (material as THREE.MeshStandardMaterial).map = tex; mesh.material = material;
        this.belts.push({ tex, fx: p.flowX ?? 0, fz: p.flowZ ?? 0 });
      }
      let ghost: THREE.LineSegments | null = null;
      if (p.kind === 'blink') {
        const m = (this.parkMat(kind, frost) as THREE.MeshStandardMaterial).clone(); mesh.material = m;
        ghost = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 })); ghost.visible = false;
        this.blinkMeshes.push({ p, mesh, ghost, mat: m });
      }
      mesh.castShadow = mesh.receiveShadow = !lite; g.add(mesh); if (ghost) g.add(ghost);
      if (!lite && p.kind !== 'piston' && p.hy > 0.3) { // dark skirt under big slabs => reads as a heavy floating block
        const sk = new THREE.Mesh(new THREE.BoxGeometry(p.hx * 1.7, 1.4, p.hz * 1.7), under); sk.position.y = -p.hy - 0.7; sk.castShadow = true; g.add(sk);
      }
      this.courseGroup.add(g); this.platMeshes.push({ mesh: g, id: p.id });
      if (p.vanishAt !== undefined || p.dynamic) { const m = (this.parkMat(kind, frost) as THREE.MeshStandardMaterial).clone(); mesh.material = m; this.timed.push({ p, g, mat: m }); } // collapsing arena tiles
      else this.cullables.push({ obj: g, z: p.z, r: p.hz + p.az + 2 });
    }
    if (!course.survival && !course.crown) this.addFinishLine(course, frost);
    if (course.crown) this.addCrown();
    // item boxes
    const cubeGeo = models.item_box ?? new THREE.BoxGeometry(1, 1, 1), ringGeo = new THREE.TorusGeometry(0.85, 0.04, 6, 24), ringMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const b of course.boxes) {
      const g = new THREE.Group();
      const cube = new THREE.Mesh(cubeGeo, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xff3df2, emissiveIntensity: 1.1, roughness: 0.2 })); cube.castShadow = !lite;
      const ring = new THREE.Mesh(ringGeo, ringMat); ring.rotation.x = Math.PI / 2; g.add(cube, ring); g.position.set(b.x, b.y, b.z);
      this.courseGroup.add(g); this.boxMeshes[b.id] = g;
    }
    for (const h of course.hazards) { const ho = this.makeHazard(h, frost); this.hazardObjs.push(ho); this.cullables.push({ obj: ho.obj, z: h.kind === 'roller' ? h.z - h.len / 2 : h.z, r: h.kind === 'roller' ? h.len / 2 + 3 : h.len + 3 }); if (ho.rope) this.cullables.push({ obj: ho.rope, z: h.z, r: h.len + 3 }); }
    for (const z of course.zones) {
      const tex = windTexture(); tex.repeat.set(Math.max(1, Math.round(z.hz / 3)), 1);
      const m = new THREE.Mesh(new THREE.BoxGeometry(z.hx * 2, z.hy * 2, z.hz * 2), new THREE.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.3, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
      m.position.set(z.x, z.y, z.z); if (Math.abs(z.fz) > Math.abs(z.fx)) m.rotation.y = Math.PI / 2;
      this.courseGroup.add(m); this.zoneObjs.push({ z, mesh: m, tex }); this.cullables.push({ obj: m, z: z.z, r: z.hz + 2 });
    }
    // scenery: tethered balloons, floating rock islands (fewer on phones)
    const nProps = lite ? 6 : 18, sp = this.parkMat('candy', frost), bal = this.parkMat('stripesRW', frost);
    for (let i = 0; i < nProps; i++) {
      const rr = (k: number) => ((Math.sin((i + 1) * 12.9898 + k * 78.233) * 43758.5453) % 1 + 1) % 1, side = i % 2 ? 1 : -1, z = rr(1) * (course.length + 60) - 20, x = side * (34 + rr(2) * 70);
      if (i % 3) { const s = 4 + rr(3) * 6, b = new THREE.Mesh(new THREE.SphereGeometry(s, 24, 16), i % 2 ? sp : bal); b.position.set(x, 10 + rr(4) * 40, z); b.castShadow = !lite; this.courseGroup.add(b); this.cullables.push({ obj: b, z, r: s + 4 }); }
      else { const isl = new THREE.Group(), s = 9 + rr(5) * 12; const rock = new THREE.Mesh(new THREE.ConeGeometry(s, s * 1.4, 7), this.parkMat('concrete', frost, 'rock')); rock.rotation.x = Math.PI; rock.position.y = -s * 0.7; const top = new THREE.Mesh(new THREE.CylinderGeometry(s, s, 0.8, 7), this.parkMat('grass', frost)); isl.add(rock, top); isl.position.set(x, -4 + rr(6) * 14, z); this.courseGroup.add(isl); this.cullables.push({ obj: isl, z, r: s * 1.5 + 4 }); }
    }
  }

  /** Finish line: tall posts, a huge FINISH banner and a checkered strip across the goal platform — impossible to miss. */
  private addFinishLine(course: Course, frost: boolean) {
    const lite = this.lite, goal = course.platforms[course.platforms.length - 1], g = new THREE.Group(), cm = this.parkMat('candy', frost);
    const w = (goal.hx - 0.5) * 2;
    for (const sx of [-1, 1]) { const m = new THREE.Mesh(new THREE.BoxGeometry(1.4, 16, 1.4), cm); m.position.set(sx * (w / 2), 8, 0); m.castShadow = !lite; g.add(m); }
    const sign = new THREE.Mesh(new THREE.BoxGeometry(w, 5, 1), new THREE.MeshBasicMaterial({ map: bannerTexture('FINISH'), fog: false })); sign.position.y = 15; g.add(sign);
    g.position.set(0, goal.y + goal.hy, course.finishZ); this.courseGroup.add(g);
    const strip = new THREE.Mesh(new THREE.PlaneGeometry(w, 2.4), new THREE.MeshBasicMaterial({ map: checkerStrip(), fog: false })); strip.rotation.x = -Math.PI / 2; strip.position.set(0, goal.y + goal.hy + 0.04, course.finishZ); this.courseGroup.add(strip);
  }

  private makeHazard(h: CourseHazard, frost: boolean): { h: CourseHazard; obj: THREE.Object3D; rope?: THREE.Mesh } {
    const g = new THREE.Group(), rw = this.parkMat('stripesRW', frost), steel = this.mat('hz-steel', () => new THREE.MeshStandardMaterial({ color: 0x8a919c, metalness: 0.9, roughness: 0.3 })), red = this.mat('hz-red', () => new THREE.MeshStandardMaterial({ color: 0xd93a2b, metalness: 0.2, roughness: 0.35 })), lite = this.lite;
    if (h.kind === 'spinner') {
      const bgeo = new THREE.BoxGeometry(h.len, h.radius * 2, h.radius * 2); scaleBoxUV(bgeo, h.len / 2, h.radius, h.radius, 2);
      const bar = new THREE.Mesh(bgeo, rw), hub = new THREE.Mesh(models.hz_hub ?? new THREE.CylinderGeometry(0.75, 0.9, 1.4, 20), red);
      bar.castShadow = hub.castShadow = !lite;
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 0.8, 12), steel); pole.position.y = -0.7;
      g.add(bar, hub, pole); this.courseGroup.add(g); g.position.set(h.x, h.y, h.z); return { h, obj: g };
    }
    if (h.kind === 'pendulum') {
      const w = (h.halfWidth ?? 4.2) + 0.5, postH = h.len + 0.8;
      const beam = new THREE.Mesh(new THREE.BoxGeometry(w * 2 + 1, 0.8, 0.8), red); beam.position.set(h.x, h.y, h.z);
      for (const sx of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(0.9, postH, 0.9), red); p.position.set(h.x + sx * w, h.y - postH / 2, h.z); p.castShadow = !lite; g.add(p); }
      beam.castShadow = !lite; g.add(beam);
      const head = new THREE.Group(), ball = new THREE.Mesh(models.hz_ball ?? new THREE.SphereGeometry(h.radius, 24, 16), this.mat('hz-ball', () => new THREE.MeshStandardMaterial({ color: 0xff8a1f, metalness: 0.5, roughness: 0.3 }))); ball.castShadow = !lite; if (models.hz_ball) ball.scale.setScalar(h.radius); head.add(ball);
      for (let i = 0; i < 10; i++) { const s = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.55, 8), steel), d = new THREE.Vector3().setFromSphericalCoords(1, Math.acos(1 - 2 * ((i + 0.5) / 10)), i * 2.4); s.position.copy(d).multiplyScalar(h.radius + 0.12); s.lookAt(d.multiplyScalar(5)); s.rotateX(Math.PI / 2); head.add(s); }
      const rope = new THREE.Mesh(new THREE.CylinderGeometry(0.06, 0.06, 1, 6), steel); g.add(head, rope);
      this.courseGroup.add(g); return { h, obj: head, rope };
    }
    // roller: striped giant log rolling along the lane
    const geo = new THREE.CylinderGeometry(h.radius, h.radius, (h.halfWidth ?? 6) * 2, 32); geo.rotateZ(Math.PI / 2);
    const mat = this.mat('hz-roller' + frost + texVersion(), () => { const t = surfaceTexture('stripesRW', lite ? 128 : 256).map.clone(); t.needsUpdate = true; t.repeat.set(6, 3); const m = new THREE.MeshStandardMaterial({ map: t, roughness: 0.45, metalness: 0.1 }); return m; });
    const log = new THREE.Mesh(geo, mat); log.castShadow = !lite; g.add(log); this.courseGroup.add(g); g.position.set(h.x, h.y, h.z); return { h, obj: g };
  }

  /** Moving platforms are a pure function of tick, so every client renders the identical motion. */
  syncPlatforms(tick: number) {
    if (!this.course) return;
    const c = { x: 0, y: 0, z: 0 };
    for (const pm of this.platMeshes) {
      const p = this.course.platforms[pm.id];
      if (p.kind === 'static' || p.kind === 'blink') { if (pm.mesh.position.y !== p.y || pm.mesh.position.z !== p.z) pm.mesh.position.set(p.x, p.y, p.z); continue; }
      platformCenter(p, tick, c); pm.mesh.position.set(c.x, c.y, c.z);
    }
  }


  /** Hide everything farther than the view range along z (phones draw less; fog hides the pop-in). */
  private cullRange = 320;
  private updateCull(camZ: number) {
    const range = this.lite ? 190 : this.cullRange;
    for (const c of this.cullables) c.obj.visible = Math.abs(c.z - camZ) < range + c.r;
  }

  /** Everything that moves is a pure function of the tick, so all clients render identical hazards. */
  syncDynamic(tick: number, dt: number, focus: { x: number; y: number; z: number }) {
    this.focusView(this.camera);                    // single-view path (split-screen calls focusView per viewport instead)
    if (!this.course || this.course.theme === 'neon') return;
    const t = tick / 60;
    for (const tm of this.timed) {
      if (tm.p.vanishAt === undefined) continue; // dynamic tile nobody has stepped on yet
      const left = tm.p.vanishAt - t;
      if (left > 0) {
        const warn = left < 4, k = left < 1.2 ? 30 : 16;
        tm.mat.emissive.setHex(warn && Math.floor(t * (left < 1.2 ? 14 : 6)) % 2 === 0 ? 0xff2a00 : 0x000000); tm.mat.emissiveIntensity = warn ? 1.1 : 0;
        tm.g.position.y = tm.p.y + (warn ? Math.sin(t * k) * (left < 1.2 ? 0.09 : 0.03) : 0);
      } else { const f = -left; tm.g.position.y = tm.p.y - 4.5 * f * f; tm.g.rotation.x = f * 0.8; tm.g.visible = tm.g.position.y > -60; } // the tile drops away
    }
    for (const b of this.blinkMeshes) {
      const ph = blinkPhase(b.p, tick), duty = b.p.duty ?? 0.6, solid = ph < duty, warn = solid && ph > duty - 0.2;
      b.mesh.visible = solid; b.ghost.visible = !solid;
      b.mat.emissive.setHex(warn && Math.floor(t * 14) % 2 === 0 ? 0xff2a00 : 0x000000); b.mat.emissiveIntensity = warn ? 1.2 : 0;
    }
    // +v points toward -z on a box top; the pattern moves toward -v as offset grows, so a -z belt needs a decreasing offset
    for (const bl of this.belts) { bl.tex.offset.y = (bl.fz * t * 0.12) % 1; bl.tex.offset.x = (bl.fx * t * 0.12) % 1; }
    const pose = { x: 0, y: 0, z: 0, x1: 0, z1: 0, x2: 0, z2: 0, angle: 0, vx: 0, vz: 0 };
    for (const ho of this.hazardObjs) {
      hazardPose(ho.h, tick, pose);
      if (ho.h.kind === 'spinner') { ho.obj.rotation.y = -pose.angle; }
      else if (ho.h.kind === 'pendulum') {
        ho.obj.position.set(pose.x, pose.y, pose.z);
        const rope = ho.rope!, a = new THREE.Vector3(ho.h.x, ho.h.y, ho.h.z), b = new THREE.Vector3(pose.x, pose.y, pose.z), d = b.clone().sub(a), l = d.length();
        rope.position.copy(a).add(b).multiplyScalar(0.5); rope.scale.set(1, l, 1); rope.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
      } else { ho.obj.position.set(pose.x, pose.y, pose.z); ho.obj.rotation.x = -pose.angle; }
    }
    for (const zo of this.zoneObjs) {
      const on = windActive(zo.z, tick), dir = Math.abs(zo.z.fx) >= Math.abs(zo.z.fz) ? Math.sign(zo.z.fx) : Math.sign(zo.z.fz);
      (zo.mesh.material as THREE.MeshBasicMaterial).opacity = on ? 0.32 : 0.04; zo.tex.offset.x = (-dir * t * (on ? 1.6 : 0.2)) % 1;
    }
    if (this.waterTex) { this.waterTex.offset.set((t * 0.004) % 1, (t * 0.0025) % 1); }
    if (this.sun && !this.split) { // keep the shadow frustum centred on the action
      const off = this.sun.position.clone().sub(this.sun.target.position); this.sun.target.position.set(focus.x, focus.y, focus.z); this.sun.position.copy(this.sun.target.position).add(off);
      this.sun.target.updateMatrixWorld();
    }
    if (this.snow) { const pos = this.snow.geometry.attributes.position as THREE.BufferAttribute;
      for (let i = 0; i < pos.count; i++) { let y = pos.getY(i) - dt * (2 + (i % 5) * 0.4); if (y < -4) y += 34; pos.setY(i, y); pos.setX(i, pos.getX(i) + Math.sin(t + i) * dt * 0.4); } pos.needsUpdate = true; }
  }

  /** Per-camera state: everything whose visibility/position depends on WHERE the camera is (called once per viewport). */
  focusView(cam: THREE.Camera) {
    const p = cam.position;
    if (this.water) { this.water.position.x = p.x; this.water.position.z = p.z; }
    if (this.snow) this.snow.position.set(p.x, p.y, p.z);
    if (this.course && this.course.theme !== 'neon') this.updateCull(p.z);
    this.applyBoxes(p.z);
  }
  private hiddenBoxes: ReadonlySet<number> = new Set();
  private applyBoxes(camZ: number) {
    this.boxMeshes.forEach((m, id) => { if (m) m.visible = Math.abs(m.position.z - camZ) < 90 && !this.hiddenBoxes.has(id); });
  }

  /** Split-screen: one render per player camera, each clipped to its own rectangle (CSS px, top-left origin). */
  split = false; private fogBase = 0;
  setSplit(on: boolean, views = 1) {
    this.split = on;
    this.cullRange = on ? (views > 4 ? 150 : views > 1 ? 230 : 320) : 320;
    const fog = this.scene.fog as THREE.FogExp2 | null; if (fog) { if (this.fogBase === 0) this.fogBase = fog.density; fog.density = this.fogBase * (on && views > 4 && this.theme !== 'neon' ? 1.9 : 1); }
    if (this.sun) this.sun.castShadow = !this.lite && !this.noShadow && (!on || views <= 1); // one shadow frustum cannot cover several distant players
    const base = Math.min(devicePixelRatio, on ? (views > 2 ? 1.25 : 1.5) : 1.5);
    if (base !== this.baseDpr) { this.baseDpr = base; this.renderer.setPixelRatio(base * this.dprScale); this.renderer.setSize(innerWidth, innerHeight, false); }
  }
  renderViews(views: { cam: THREE.PerspectiveCamera; rect: Rect; before?: () => void }[]) {
    const r = this.renderer, H = innerHeight;
    r.setScissorTest(true);
    for (const v of views) {
      const y = H - v.rect.y - v.rect.h;
      r.setViewport(v.rect.x, y, v.rect.w, v.rect.h); r.setScissor(v.rect.x, y, v.rect.w, v.rect.h);
      const aspect = v.rect.w / v.rect.h; if (Math.abs(v.cam.aspect - aspect) > 1e-3) { v.cam.aspect = aspect; v.cam.updateProjectionMatrix(); }
      v.before?.(); r.render(this.scene, v.cam);
    }
    r.setScissorTest(false); r.setViewport(0, 0, innerWidth, innerHeight);
  }

  /** Cheap contact shadow under a robot (works on phones where real shadows are off). */
  blob(slot: number, x: number, y: number, z: number, visible: boolean, tick: number) {
    let m = this.blobs[slot];
    if (!m) { m = new THREE.Mesh(new THREE.CircleGeometry(0.55, 20), new THREE.MeshBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.35, depthWrite: false, fog: false })); m.rotation.x = -Math.PI / 2; this.scene.add(m); this.blobs[slot] = m; }
    const gy = visible && this.course ? groundBelow(this.course, tick, x, y + 0.5, z) : null;
    m.visible = gy !== null; if (gy === null) return;
    m.position.set(x, gy + 0.03, z); const k = Math.max(0.35, 1 - (y - gy) * 0.08); m.scale.setScalar(k); (m.material as THREE.MeshBasicMaterial).opacity = 0.38 * k;
  }

  private addCrown() {
    const g = new THREE.Group(), gold = new THREE.MeshStandardMaterial({ color: 0xffc933, metalness: 0.95, roughness: 0.2, emissive: 0xaa6a00, emissiveIntensity: 0.9, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.62, 0.38, 20, 1, true), gold); g.add(ring);
    for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, c = new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.4, 8), gold); c.position.set(Math.sin(a) * 0.55, 0.36, Math.cos(a) * 0.55); g.add(c); const j = new THREE.Mesh(new THREE.SphereGeometry(0.07, 8, 6), new THREE.MeshBasicMaterial({ color: [0xff3df2, 0x00e5ff, 0x7cff3a][i % 3] })); j.position.set(Math.sin(a) * 0.58, 0.58, Math.cos(a) * 0.58); g.add(j); }
    const glow = new THREE.Mesh(new THREE.SphereGeometry(0.95, 16, 12), new THREE.MeshBasicMaterial({ color: 0xffd23d, transparent: true, opacity: 0.18, blending: THREE.AdditiveBlending, depthWrite: false })); g.add(glow);
    this.crownObj = g; this.courseGroup.add(g);
  }
  /** The crown on the map: floats and spins on the pedestal; hidden while a robot carries it (the robot wears it). */
  setCrown(pos: [number, number, number] | null, holder: number) {
    if (!this.crownObj) return;
    this.crownObj.visible = !!pos && holder < 0; if (!pos) return;
    this.crownObj.position.set(pos[0], pos[1] + Math.sin(this.time * 2.5) * 0.12, pos[2]); this.crownObj.rotation.y = this.time * 1.4;
  }
  /** Emoji speech bubble above a robot. */
  bubble(text: string, x: number, y: number, z: number) {
    let tex = this.emojiTex.get(text);
    if (!tex) { const c = document.createElement('canvas'); c.width = c.height = 128; const g = c.getContext('2d')!; g.font = '96px system-ui, "Apple Color Emoji", "Segoe UI Emoji", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 64, 70); tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; this.emojiTex.set(text, tex); }
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, fog: false })); sp.scale.set(0.85, 0.85, 1); sp.renderOrder = 10; this.scene.add(sp);
    this.bubbles.push({ sp, t: 0, x, y: y + 1.9, z });
  }
  /** Follow the robot that emoted (so the bubble stays above it). */
  private updateBubbles(dt: number, at: (i: number) => THREE.Vector3 | null) { void at; for (const b of this.bubbles) { b.t += dt; b.sp.position.set(b.x, b.y + b.t * 0.5, b.z); (b.sp.material as THREE.SpriteMaterial).opacity = Math.min(1, (2.2 - b.t) * 1.4); } this.bubbles = this.bubbles.filter((b) => { if (b.t > 2.2) { this.scene.remove(b.sp); b.sp.material.dispose(); return false; } return true; }); }

  /** Confetti burst (finish line celebration). */
  confetti(x: number, y: number, z: number) {
    if (!this.conf) {
      const n = 600, pos = new Float32Array(n * 3).fill(-9999), col = new Float32Array(n * 3), g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.32, vertexColors: true, transparent: true, depthWrite: false, fog: false })); pts.frustumCulled = false; this.scene.add(pts);
      this.conf = { pts, pos, col, vel: new Float32Array(n * 3), life: new Float32Array(n), n, head: 0, alive: 0 };
    }
    const c = this.conf, pal = [0xff3df2, 0x00e5ff, 0xffd23d, 0x7cff3a, 0xffffff, 0xff6a3d], tc = new THREE.Color();
    for (let k = 0; k < 140; k++) {
      const i = c.head++ % c.n, a = Math.random() * Math.PI * 2, sp = 3 + Math.random() * 7;
      c.pos.set([x, y + 1.5, z], i * 3); c.vel.set([Math.cos(a) * sp, 6 + Math.random() * 7, Math.sin(a) * sp], i * 3); c.life[i] = 2.4 + Math.random() * 0.8;
      tc.setHex(pal[k % pal.length]); c.col.set([tc.r, tc.g, tc.b], i * 3);
    }
    c.alive = 1;
  }
  private updateConfetti(dt: number) {
    const c = this.conf; if (!c || !c.alive) return; let any = false;
    for (let i = 0; i < c.n; i++) {
      if (c.life[i] <= 0) continue; any = true; c.life[i] -= dt; const j = i * 3;
      c.vel[j + 1] -= 9 * dt; c.vel[j] *= 1 - 0.6 * dt; c.vel[j + 2] *= 1 - 0.6 * dt; c.pos[j] += c.vel[j] * dt; c.pos[j + 1] += c.vel[j + 1] * dt; c.pos[j + 2] += c.vel[j + 2] * dt;
      if (c.life[i] <= 0) c.pos[j + 1] = -9999;
    }
    c.alive = any ? 1 : 0; (c.pts.geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true; (c.pts.geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  /** Glowing "rope" between a grabber and the robot it holds. */
  link(slot: number, a: THREE.Vector3 | null, b: THREE.Vector3 | null) {
    let m = this.links[slot];
    if (!m) { m = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.07, 1, 8), new THREE.MeshBasicMaterial({ color: 0x7cff3a, fog: false })); this.scene.add(m); this.links[slot] = m; }
    m.visible = !!(a && b); if (!a || !b) return;
    const d = new THREE.Vector3().subVectors(b, a); const l = d.length() || 0.01;
    m.position.copy(a).add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, 0.7, 0)); m.scale.set(1, l, 1); m.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize());
  }

  private tmpColor = new THREE.Color();
  animate(dt: number, hiddenBoxes: ReadonlySet<number> | number[]) {
    this.time += dt; this.updateConfetti(dt); this.updateBubbles(dt, () => null);
    this.hiddenBoxes = hiddenBoxes instanceof Set ? hiddenBoxes : new Set(hiddenBoxes);
    this.boxMeshes.forEach((m, id) => {
      if (!m) return;
      m.rotation.y += dt * 1.6; m.rotation.x = Math.sin(this.time * 1.4 + id) * 0.3;
      this.tmpColor.setHSL((this.time * 0.25 + id * 0.13) % 1, 1, 0.55);
      ((m.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).emissive.copy(this.tmpColor);
    });
    this.applyBoxes(this.camera.position.z);
  }

  /** Dynamic resolution: trade sharpness for frame-rate so controls stay fluid on slow phones. */
  private baseDpr = 1; private dprScale = 1; private slowT = 0; private fastT = 0;
  /** Quality tiers, cheapest visual loss first: resolution -> bloom -> shadows. Climbs back up when frames are fast. */
  private noBloom = false; private noShadow = false; private warm = 0;
  adaptQuality(fps: number, dtSec: number) {
    this.warm += dtSec; if (this.warm < 2) return; // ignore the shader-compile hitch right after load
    if (fps < 45) { this.slowT += dtSec; this.fastT = 0; } else if (fps > 57) { this.fastT += dtSec; this.slowT = 0; } else { this.slowT = this.fastT = 0; }
    let changed = false;
    if (this.slowT > 1.0) {
      this.slowT = 0;
      if (this.dprScale > 0.7) { this.dprScale = Math.max(0.7, this.dprScale * 0.8); changed = true; }
      else if (!this.lite && !this.noBloom) this.noBloom = true;
      else if (!this.lite && !this.noShadow) { this.noShadow = true; if (this.sun) this.sun.castShadow = false; }
      else if (this.dprScale > 0.45) { this.dprScale = Math.max(0.45, this.dprScale * 0.85); changed = true; }
    }
    if (this.fastT > 8) {
      this.fastT = 0;
      if (this.dprScale < 1) { this.dprScale = Math.min(1, this.dprScale * 1.15); changed = true; }
      else if (this.noShadow) { this.noShadow = false; if (this.sun && !this.split) this.sun.castShadow = !this.lite; }
      else if (this.noBloom) this.noBloom = false;
    }
    if (changed) { this.renderer.setPixelRatio(this.baseDpr * this.dprScale); this.renderer.setSize(innerWidth, innerHeight, false); this.composer.setSize(innerWidth, innerHeight); }
  }

  render() { if (this.lite || this.noBloom) this.renderer.render(this.scene, this.camera); else this.composer.render(); }
}
