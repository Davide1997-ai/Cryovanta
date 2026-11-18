import * as THREE from 'three';
import qrcode from 'qrcode-generator';
import {
  DT, EMOTES, HATS, TUNING, INTERP_DELAY_MS, LOOK_COLORS, SNAPSHOT_EVERY, TEAM_COLORS, TEAM_NAMES, TICK_RATE, MAPS, MAP_IDS, MAX_PLAYERS_PER_ROOM, MODES, MODE_IDS, Predictor, buildMap, encodePlayer, lerp, lerpAngle, platformCenter,
  type Course, type InputFrame, type RoomInfo, type ServerMsg, type SnapPlayer, type Snapshot,
} from '@cryovanta/shared';
import { Input } from './input';
import { audio } from './audio';
import { layoutCells } from './layout';
import { Net } from './net';
import { Robot, ROBOT_COLORS } from './robot';
import { Stage } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAME = 'neon-circuit';
const ICON: Record<string, string> = { boost: '⚡', seeker: '🎯', hazard: '🧱', shield: '🛡️' };

/** Big-screen mode (?screen): shows the game + QR, phones are the joypads. */
const SCREEN = new URLSearchParams(location.search).has('screen');
if (SCREEN) document.body.classList.add('screen');
if (new URLSearchParams(location.search).has('debug')) document.body.classList.add('debug');
const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const canvas = $<HTMLCanvasElement>('c');
const stage = new Stage(canvas);
const input = new Input(canvas);
const net = new Net();
import { loadAssets, models } from './assets';
const robots = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, i) => { const r = new Robot(i); stage.scene.add(r.root); r.root.visible = false; return r; });
// Blender-made meshes + baked PBR textures load in the background; everything has a procedural fallback.
void loadAssets(stage.lite, Math.min(4, stage.renderer.capabilities.getMaxAnisotropy())).then(() => { robots.forEach((r) => r.upgrade()); stage.rebuild(); }).catch(() => { /* keep procedural look */ });

let room: RoomInfo | null = null;
let me = -1;
let predictor: Predictor | null = null;
let snaps: { t: number; s: Snapshot }[] = [];
let participants: number[] = [];
/** Adaptive jitter buffer: widens when Wi-Fi delivers snapshots in bursts, shrinks again when it calms down. */
/** the server streams state to big screens every tick (60 Hz) and to players every SNAPSHOT_EVERY ticks */
const SNAP_MS = (1000 * (SCREEN ? 1 : SNAPSHOT_EVERY)) / TICK_RATE;
/** The big screen has no prediction, so it uses the smallest safe buffer (2 snapshots + margin); the jitter estimate widens it when Wi-Fi is bursty. */
const MIN_DELAY = SCREEN ? Math.round(SNAP_MS * 2 + 12) : INTERP_DELAY_MS;
let interpDelay = MIN_DELAY, snapGap = 0 /* EWMA of |arrival gap - nominal| = jitter (ms) */, lastSnapT = 0;
let toastTimer = 0;
let inGameView = false;
let curCourse: Course | null = null, teamsBySlot: number[] = [], ruleNow = 'race', lastCountdown = -1, teamPointsNow: number[] = [0, 0];
const memberOf = (slot: number) => room?.members.find((m) => m.slot === slot);
/** colour a player chose (falls back to the slot colour) */
const lookColor = (slot: number) => LOOK_COLORS[memberOf(slot)?.look.c ?? -1] ?? ROBOT_COLORS[slot % 7];
/** cell/ring colour: team colour in team rounds, otherwise the player's own */
const cellColor = (slot: number) => (teamsBySlot[slot] >= 0 ? TEAM_COLORS[teamsBySlot[slot]] : lookColor(slot));
function applyLooks() { for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) { const m = memberOf(s); robots[s].applyLook(lookColor(s), m?.look.h ?? 0); robots[s].setTeam(teamsBySlot[s] >= 0 ? TEAM_COLORS[teamsBySlot[s]] : null); } }
// audio can only start after a user gesture
const unlockAudio = () => { audio.unlock(); $('audioHint')?.remove(); };
addEventListener('pointerdown', unlockAudio); addEventListener('keydown', (e) => { unlockAudio(); if (e.code === 'KeyM') { const mu = audio.toggleMute(); toast(mu ? '🔇 Audio disattivato' : '🔊 Audio attivo', 1200); } });
let mapName = '', modeName = '';

// ------------------------------------------------------------------ UI
const err = (t: string) => { ($(SCREEN ? 'sErr' : 'err')).textContent = t; };
const toast = (t: string, ms = 1400) => { $('htoast').textContent = t; toastTimer = performance.now() + ms; };
function renderRoom() {
  const lobbyEl = $('lobby'), playing = room?.phase === 'playing';
  lobbyEl.style.display = playing ? 'none' : '';
  $('hud').style.display = playing ? 'block' : 'none';
  document.body.classList.toggle('playing', !!playing);
  $('menu').style.display = room ? 'none' : '';
  $('room').style.display = room ? '' : 'none';
  if (!room) return;
  $('rcode').textContent = room.code; $('rcount').textContent = String(room.members.length);
  $('rphase').textContent = room.phase === 'countdown' ? `Si parte tra ${room.countdown}…` : room.phase === 'results' ? 'Risultati' : 'In attesa';
  $('members').innerHTML = room.members.map((m) => `<li><span style="color:#${ROBOT_COLORS[m.slot].toString(16).padStart(6, '0')}">● ${esc(m.name)}${m.host ? ' 👑' : ''}${m.slot === me ? ' (tu)' : ''}</span><span class="${m.ready ? 'ready' : 'muted'}">${!m.connected ? 'offline' : m.ready ? 'PRONTO' : '…'}</span></li>`).join('');
  const isHost = room.members.find((m) => m.host)?.slot === me;
  const selMap = $<HTMLSelectElement>('selMap'), selMode = $<HTMLSelectElement>('selMode');
  if (!selMap.options.length) {
    selMap.innerHTML = ['random', ...MAP_IDS].map((id) => `<option value="${id}">${id === 'random' ? '🎲 Mappa casuale' : '🗺️ ' + MAPS[id].name}</option>`).join('');
    selMode.innerHTML = MODE_IDS.map((id) => `<option value="${id}">🏁 ${MODES[id].name}</option>`).join('');
  }
  selMap.value = room.options.map; selMode.value = room.options.mode; selMap.disabled = selMode.disabled = !isHost;
  $('optDesc').textContent = (room.options.map === 'random' ? 'Ogni round una mappa diversa. ' : MAPS[room.options.map]?.desc + ' ') + (MODES[room.options.mode]?.desc ?? '') + (isHost ? '' : ' (solo l\'host può cambiare)');
  const mine = room.members.find((m) => m.slot === me);
  $('ready').textContent = mine?.ready ? 'Annulla' : 'Pronto!';
}
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));

$('quick').onclick = () => start(() => net.send({ k: 'quickplay', game: GAME }));
$('create').onclick = () => start(() => net.send({ k: 'create', game: GAME, isPrivate: true }));
$('join').onclick = () => start(() => net.send({ k: 'join', code: ($<HTMLInputElement>('code').value || '').toUpperCase() }));
$('ready').onclick = () => {
  if (isTouch) { document.documentElement.requestFullscreen?.().catch(() => {}); (navigator as any).wakeLock?.request('screen').catch(() => {}); (screen.orientation as any)?.lock?.('landscape').catch(() => {}); } const mine = room?.members.find((m) => m.slot === me); net.send({ k: 'ready', ready: !mine?.ready }); };
const sendCfg = () => net.send({ k: 'config', map: $<HTMLSelectElement>('selMap').value, mode: $<HTMLSelectElement>('selMode').value });
$('selMap').onchange = sendCfg; $('selMode').onchange = sendCfg;
$('leave').onclick = () => { net.send({ k: 'leave' }); $('results').style.display = 'none'; };

let connected = false, lastName = '', lastUrl = '', reconnecting = false;
/** Wi-Fi blip: keep playing locally and retry with the secret token — the server holds our slot for 20 s. */
async function reconnect() {
  connected = false;
  if (reconnecting) return;
  reconnecting = true;
  const t0 = performance.now();
  while (performance.now() - t0 < 25000) {
    toast('📶 Riconnessione…', 1200);
    try { await net.connect(lastUrl, lastName); connected = true; reconnecting = false; toast('Riconnesso!'); if (SCREEN) net.send({ k: 'screen', game: GAME, code: room?.code }); return; } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  reconnecting = false; room = null; predictor = null; renderRoom(); err('Connessione persa');
}
const wsUrl = () => new URLSearchParams(location.search).get('server') ?? (location.port === '5173' ? `ws://${location.hostname || 'localhost'}:8080` : `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`); // dev: separate server; packaged/LAN: same origin
async function ensureConnected(name: string): Promise<boolean> {
  if (connected) return true;
  const url = wsUrl();
  try { await net.connect(url, name); connected = true; } catch { err('Server non raggiungibile'); return false; }
  lastName = name; lastUrl = url; net.onMsg = onMsg; net.onClose = reconnect; return true;
}
async function start(then: () => void) {
  err('');
  if (!(await ensureConnected($<HTMLInputElement>('name').value.trim() || 'Bolt-' + Math.floor(Math.random() * 99)))) return;
  then();
}

// ------------------------------------------------------------------ network
function onMsg(m: ServerMsg) {
  switch (m.k) {
    case 'room': room = m.room; me = m.you; if (SCREEN) renderScreen(); else renderRoom(); applyLooks(); if (m.room.phase === 'lobby') { inGameView = false; audio.stopMusic(); } break;
    case 'left': room = null; predictor = null; renderRoom(); break;
    case 'error': err(`${m.code}: ${m.msg}`); break;
    case 'round': {
      const course = buildMap(m.map, m.seed, m.difficulty); mapName = MAPS[m.map]?.name ?? m.map; modeName = MODES[m.mode]?.name ?? m.mode;
      stage.buildCourse(course); curCourse = course; teamsBySlot = m.teams ?? []; ruleNow = m.rule ?? 'race'; teamPointsNow = [0, 0]; lastCountdown = -1; applyLooks();
      audio.startMusic(course.theme);
      predictor = SCREEN ? null : new Predictor(course, me); inGameView = true;
      snaps = []; participants = m.participants;
      $('results').style.display = 'none';
      toast(`${mapName.toUpperCase()} · ROUND ${m.round + 1}${MODES[m.mode]?.kind === 'elimination' ? ' — passano ' + m.qualify : ''}`, 3000);
      break;
    }
    case 'snap': {
      const nowT = performance.now();
      if (lastSnapT) { const gap = nowT - lastSnapT; snapGap = snapGap * 0.9 + Math.abs(gap - SNAP_MS) * 0.1; }
      lastSnapT = nowT;
      interpDelay += (Math.min(260, MIN_DELAY + snapGap * 3) - interpDelay) * 0.05;
      snaps.push({ t: nowT, s: m }); if (snaps.length > 40) snaps.shift();
      predictor?.reconcile(m);
      if (curCourse) for (let i = 0; i + 1 < m.tv.length; i += 2) curCourse.platforms[m.tv[i]].vanishAt = m.tv[i + 1]; // Hex-A-Gone tiles the server has marked
      if (m.rp === 'countdown' && m.mp === 'round') { const cd = Math.ceil(m.left); if (cd !== lastCountdown) { lastCountdown = cd; audio.play(cd > 0 ? 'beep' : 'go'); } }
      else if (lastCountdown > 0 && m.rp === 'running') { audio.play('go'); lastCountdown = -1; }
      for (const e of m.ev) {
        { // sounds + emotes + crown (everybody's actions are heard/seen on the big screen)
          const pos = (s: number) => robotPos[s];
          if (e.t === 'emote') { stage.bubble(EMOTES[e.id] ?? '👍', pos(e.slot).x, pos(e.slot).y, pos(e.slot).z); robots[e.slot].emote(e.id, performance.now()); audio.play('emote'); }
          else if (e.t === 'pickup') audio.play('pickup'); else if (e.t === 'use') audio.play(e.item === 'boost' ? 'use' : e.item === 'seeker' ? 'use' : 'grab');
          else if (e.t === 'impact') audio.play(e.kind === 'shove' ? 'shove' : e.kind === 'bump' ? 'bump' : 'hit');
          else if (e.t === 'grab') audio.play('grab'); else if (e.t === 'release' && e.thrown) audio.play('throw');
          else if (e.t === 'finish') audio.play(e.slot === me || SCREEN ? 'finish' : 'qualified'); else if (e.t === 'fall') audio.play('fall'); else if (e.t === 'out') audio.play('out');
          else if (e.t === 'crown') { audio.play(e.what === 'take' ? 'crownTake' : e.what === 'drop' ? 'crownDrop' : 'win'); if (SCREEN) feed(e.what === 'take' ? `👑 ${memberOf(e.slot)?.name ?? '?'} prende la corona` : e.what === 'drop' ? `💥 ${memberOf(e.slot)?.name ?? '?'} perde la corona` : `🏆 ${memberOf(e.slot)?.name ?? '?'} vince la corona!`); }
        }
        if (e.t === 'pickup' && e.slot === me) toast(`${ICON[e.item]} ${e.item.toUpperCase()}!`);
        if (e.t === 'impact' && e.victim === me) toast(e.outcome === 'blocked' ? '🛡️ PARATO!' : e.outcome === 'smashed' ? '💥 SFONDATO!' : e.kind === 'obstacle' ? '🔨 OSTACOLO!' : e.kind === 'shove' ? '👊 SPINTO!' : e.kind === 'bump' ? '💢 URTATO!' : '💫 COLPITO!');
        { // global feedback (screen shows everyone's actions; a player's own robot gets personal toasts below)
          const nm = (s: number) => room?.members.find((x) => x.slot === s)?.name ?? `P${s + 1}`;
          if (e.t === 'finish') { stage.confetti(robotPos[e.slot].x, robotPos[e.slot].y, robotPos[e.slot].z); if (SCREEN) feed(`🏁 ${nm(e.slot)} è #${e.rank}`); }
          if (e.t === 'impact' && SCREEN && (e.kind === 'shove' || e.kind === 'bump') && e.outcome === 'hit') feed(`${e.kind === 'shove' ? '👊' : '💢'} ${nm(e.owner)} ➜ ${nm(e.victim)}`);
          if (e.t === 'grab' && SCREEN) feed(`✋ ${nm(e.slot)} afferra ${nm(e.victim)}`);
          if (e.t === 'release' && e.thrown && SCREEN) feed(`🚀 ${nm(e.slot)} lancia ${nm(e.victim)}`);
          if (e.t === 'out') feed(e.by >= 0 ? `💀 ${nm(e.slot)} ${e.how === 'throw' ? 'lanciato fuori' : 'spinto fuori'} da ${nm(e.by)}` : `💀 ${nm(e.slot)} è caduto!`);
        }
        if (SCREEN && e.t === 'finish') { const nm = room?.members.find((x) => x.slot === e.slot)?.name ?? '?'; toast(`🏁 ${nm} è #${e.rank}`, 2200); }
        if (e.t === 'finish' && e.slot === me) toast(`🏁 TRAGUARDO #${e.rank}`, 2500);
        if (e.t === 'fall' && e.slot === me) toast('Caduto!');
      }
      break;
    }
    case 'roundEnd':
      if (SCREEN) { const nm = (s: number) => room?.members.find((x) => x.slot === s)?.name ?? '?'; toast(MODES[room?.options.mode ?? '']?.kind === 'elimination' && m.eliminated.length ? `❌ Eliminati: ${m.eliminated.map(nm).join(', ')}` : `🏁 Round finito: ${m.qualified.slice(0, 3).map(nm).join(' › ')}`, 4500); }
      else toast(m.qualified.includes(me) ? '✅ QUALIFICATO' : '❌ ELIMINATO', 3500);
      if (m.teamPoints) { teamPointsNow = m.teamPoints; if (SCREEN) feed(`🏁 ${TEAM_NAMES[0]} ${m.teamPoints[0]} — ${m.teamPoints[1]} ${TEAM_NAMES[1]}`); } audio.play('qualified'); break;
    case 'matchEnd': {
      const names = new Map(room?.members.map((x) => [x.slot, x.name]));
      const resEl = SCREEN ? $('sResults') : $('results'); resEl.style.display = ''; if (!SCREEN) $('lobby').style.display = '';
      const gp = m.points.some((p) => p > 0);
      const team = m.teams.some((t) => t >= 0), head = team ? `<div style="font-size:1.2em;margin-bottom:6px">${m.teamPoints[0] >= m.teamPoints[1] ? TEAM_NAMES[0] : TEAM_NAMES[1]} vincono! (${m.teamPoints[0]} — ${m.teamPoints[1]})</div>` : '';
      resEl.innerHTML = `<h3>Classifica · ${esc(modeName)}</h3>${head}` + m.standings.map((s, i) => `<div style="color:${hexc(cellColor(s))}">${i + 1}. ${esc(names.get(s) ?? '?')}${s === m.winner ? ' 🏆' : ''}${gp || team ? ` — ${m.points[s]} pt` : ''} <small style="opacity:.7">+${m.xp[s] ?? 0} XP</small></div>`).join('');
      audio.play('win'); audio.stopMusic();
      break;
    }
  }
}

// ------------------------------------------------------------------ main loop
let fpsCount = 0, fpsT = performance.now(), fps = 0;
(window as any).__cv = { get pcams() { return playerCams; }, get models() { return Object.keys(models); }, get robots() { return robots; }, get robotPos() { return robotPos; }, get cams() { return participants.map((s) => ({ slot: s, x: +playerCams[s].pos.x.toFixed(1), z: +playerCams[s].pos.z.toFixed(1) })); }, get interpDelay() { return interpDelay; }, freeCam: false, stage, net, get fps() { return fps; }, get predictor() { return predictor; }, get room() { return room; }, get latest() { return snaps[snaps.length - 1]?.s ?? null; } };
let acc = 0, last = performance.now(), sendBuf: InputFrame[] = [], unsent = 0, lastSendT = 0;
interface PlayerCam { cam: THREE.PerspectiveCamera; pos: THREE.Vector3; look: THREE.Vector3; init: boolean; baseY: number; yaw: number }
const playerCams: PlayerCam[] = Array.from({ length: MAX_PLAYERS_PER_ROOM }, () => ({ cam: new THREE.PerspectiveCamera(60, 1, 0.1, 1800), pos: new THREE.Vector3(), look: new THREE.Vector3(), init: false, baseY: 0, yaw: 0 }));
const tmpV2 = new THREE.Vector3();
const robotPos: THREE.Vector3[] = Array.from({ length: MAX_PLAYERS_PER_ROOM }, () => new THREE.Vector3());
const camPos = new THREE.Vector3(0, 6, -10), camLook = new THREE.Vector3(), tmpV = new THREE.Vector3();
const seekerMeshes = new Map<number, THREE.Object3D>(), hazardMeshes = new Map<number, THREE.Object3D>();
const seekerGeo = new THREE.OctahedronGeometry(0.35), seekerMat = new THREE.MeshStandardMaterial({ color: 0x220008, emissive: 0xff2244, emissiveIntensity: 3, metalness: 0.6, roughness: 0.2 });
const hazGeo = new THREE.BoxGeometry(1, 1, 1);
const hazMat = (armed: boolean) => new THREE.MeshStandardMaterial({ color: 0x2a2a33, metalness: 0.9, roughness: 0.25, emissive: armed ? 0xff3300 : 0xffaa00, emissiveIntensity: armed ? 1.6 : 0.5 });

function pickBracket(rt: number) {
  for (let i = snaps.length - 1; i > 0; i--) if (snaps[i - 1].t <= rt) return { a: snaps[i - 1], b: snaps[i], f: Math.min(1.6, Math.max(0, (rt - snaps[i - 1].t) / Math.max(1, snaps[i].t - snaps[i - 1].t))) /* >1 = short extrapolation while a snapshot is late */ };
  return snaps.length ? { a: snaps[0], b: snaps[0], f: 0 } : null;
}
const lerpPlayer = (a: SnapPlayer, b: SnapPlayer, f: number): SnapPlayer => ({ ...b, x: lerp(a.x, b.x, f), y: lerp(a.y, b.y, f), z: lerp(a.z, b.z, f), yaw: lerpAngle(a.yaw, b.yaw, f) });

function frame(now: number) {
  lobbySpin(now);
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (predictor && room?.phase === 'playing') {
    acc += dt;
    while (acc >= DT) {
      acc -= DT;
      const f = predictor.step(input.sample());
      sendBuf.push(f); if (sendBuf.length > 6) sendBuf.shift(); unsent++;
    }
    // Flush once per rendered frame (never leave fresh inputs waiting for the next slow frame).
    // Each packet re-sends 2 older frames: a lost/late packet costs nothing (server dedups by seq).
    if (unsent > 0 && (unsent >= 2 || now - lastSendT >= 30)) {
      net.send({ k: 'input', frames: sendBuf.slice(-Math.min(6, unsent + 2)) }); unsent = 0; lastSendT = now;
    }
    predictor.decaySmoothing(dt);
  }
  render(dt, now);
  requestAnimationFrame(frame);
}

const rideA = { x: 0, y: 0, z: 0 }, rideB = { x: 0, y: 0, z: 0 };
function render(dt: number, now: number) {
  fpsCount++; if (now - fpsT >= 1000) { fps = fpsCount * 1000 / (now - fpsT); fpsCount = 0; fpsT = now; }
  stage.adaptQuality(fps || 60, dt);
  const br = pickBracket(now - interpDelay);
  const latest = snaps[snaps.length - 1]?.s;
  const splitting = SCREEN && inGameView && room?.phase === 'playing' && !!latest && participants.length > 0;
  stage.setSplit(splitting, participants.length);
  // Platforms must be drawn in the SAME time frame as the robots standing on them. Interpolated robots live ~50 ms in the past,
  // so (without prediction) the platforms use the interpolated tick too; the predicted local robot lives "now", so it uses the predicted tick.
  const interpTick = br ? lerp(br.a.s.tick, br.b.s.tick, br.f) : (latest?.tick ?? 0);
  const dynTick = predictor?.running ? predictor.tick : interpTick;
  stage.syncPlatforms(dynTick);
  stage.syncDynamic(dynTick, dt, camLook);
  if (br && latest) {
    for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) {
      const a = br.a.s.players[s], b = br.b.s.players[s];
      let ps: SnapPlayer = lerpPlayer(a, b, br.f), pos = { x: ps.x, y: ps.y, z: ps.z };
      if (s === me && predictor) { // local robot: predicted state, no interpolation delay
        const p = predictor.state, sm = predictor.smooth;
        ps = { ...encodePlayer(p), it: latest.players[s].it };
        pos = { x: p.x + sm.x, y: p.y + sm.y, z: p.z + sm.z };
      }
      if (predictor?.running && s !== me && ps.g === 1 && ps.pf >= 0) { // remote robot riding a platform drawn at a different time: keep it glued to its deck
        const pl = predictor.course.platforms[ps.pf];
        if (pl && pl.kind !== 'static' && pl.kind !== 'blink') { platformCenter(pl, dynTick, rideA); platformCenter(pl, interpTick, rideB); pos = { x: pos.x + rideA.x - rideB.x, y: pos.y + rideA.y - rideB.y, z: pos.z + rideA.z - rideB.z }; }
      }
      robotPos[s].set(pos.x, pos.y, pos.z);
      robots[s].update(dt, ps, pos, splitting ? 0 : stage.camera.position.distanceTo(tmpV.set(pos.x, pos.y, pos.z)));
      stage.blob(s, pos.x, pos.y, pos.z, ps.al === 1 && ps.rs <= 0, dynTick);
    }
    for (let s = 0; s < MAX_PLAYERS_PER_ROOM; s++) { const p = latest.players[s]; stage.link(s, p && p.gb > 0 && p.gt >= 0 ? robotPos[s] : null, p && p.gt >= 0 ? robotPos[p.gt] : null); }
    stage.setCrown(latest.cw ? [latest.cw[0], latest.cw[1], latest.cw[2]] : null, latest.cw ? latest.cw[3] : -1);
    stage.animate(dt, latest.bx);
    syncProjectiles(br);
    if (SCREEN) { if (splitting) splitFrame(dt, latest); else hideCells(); } else hud(latest);
    if (!splitting) follow(dt, latest);
  }
  if (now > toastTimer) $('htoast').textContent = '';
  $('net').textContent = `${fps.toFixed(0)}fps · ${stage.renderer.info.render.calls} calls · rtt ${net.rtt.toFixed(0)}ms · buf ${interpDelay.toFixed(0)}ms · err ${(predictor?.lastError ?? 0).toFixed(2)}u · pending ${predictor?.pending.length ?? 0}`;
  if (!splitting) stage.render();
}

function syncProjectiles(br: NonNullable<ReturnType<typeof pickBracket>>) {
  const seen = new Set<number>();
  for (const sk of br.b.s.sk) {
    const prev = br.a.s.sk.find((x) => x.id === sk.id) ?? sk;
    let m = seekerMeshes.get(sk.id);
    if (!m) { m = new THREE.Mesh(seekerGeo, seekerMat); stage.scene.add(m); seekerMeshes.set(sk.id, m); }
    m.position.set(lerp(prev.x, sk.x, br.f), lerp(prev.y, sk.y, br.f), lerp(prev.z, sk.z, br.f)); m.rotation.y += 0.3; seen.add(sk.id);
  }
  for (const [id, m] of seekerMeshes) if (!seen.has(id)) { stage.scene.remove(m); seekerMeshes.delete(id); }
  const seenH = new Set<number>();
  for (const h of br.b.s.hz) {
    let m = hazardMeshes.get(h.id) as THREE.Mesh | undefined;
    if (!m) { m = new THREE.Mesh(hazGeo, hazMat(h.a === 1)); stage.scene.add(m); hazardMeshes.set(h.id, m); (m as any).armed = h.a; }
    if ((m as any).armed !== h.a) { m.material = hazMat(h.a === 1); (m as any).armed = h.a; }
    m.position.set(h.x, h.y + 0.5, h.z); seenH.add(h.id);
  }
  for (const [id, m] of hazardMeshes) if (!seenH.has(id)) { stage.scene.remove(m); hazardMeshes.delete(id); }
}

function hud(s: Snapshot) {
  const order = s.players.filter((p) => p.al === 1).sort((a, b) => (a.fr && b.fr ? a.fr - b.fr : a.fr ? -1 : b.fr ? 1 : b.z - a.z));
  const rank = order.findIndex((p) => p.s === me) + 1;
  $('hrank').textContent = rank ? `#${rank} / ${order.length}` : 'ESPULSO';
  $('hinfo').innerHTML = `${esc(mapName)} · ${esc(modeName)}<br/>Round ${s.round + 1}<br/>${s.mp === 'intermission' ? 'Prossimo round' : 'Tempo'} ${Math.max(0, s.left).toFixed(0)}s`;
  const mine = predictor && s.players[me] ? s.players[me].it : null;
  $('hitem').textContent = mine ? ICON[mine] : '';
  $('bItem').textContent = mine ? ICON[mine] : '🎁'; $('bItem').style.opacity = mine ? '1' : '.45';
  $('hbig').textContent = s.rp === 'countdown' && s.mp === 'round' ? String(Math.ceil(s.left)) : '';
}

const fDesired = new THREE.Vector3(), fLook = new THREE.Vector3();
function follow(dt: number, s: Snapshot) {
  if ((window as any).__cv?.freeCam) return; // debug: lets tests/QA inspect any part of the map
  let tgt = predictor && s.players[me]?.al ? { x: predictor.state.x, y: predictor.state.y, z: predictor.state.z } : null;
  if (!tgt) { // spectate the front-runner
    const lead = s.players.filter((p) => p.al === 1).sort((a, b) => b.z - a.z)[0];
    tgt = lead ? { x: lead.x, y: lead.y, z: lead.z } : { x: 0, y: 0, z: 0 };
  }
  const yaw = input.camYaw, sx = Math.sin(yaw), cz = Math.cos(yaw);
  const back = SCREEN ? 13 : 9.5, up = SCREEN ? 7.6 : 5.4;
  const desired = fDesired.set(tgt.x - sx * back, tgt.y + up, tgt.z - cz * back);
  camPos.lerp(desired, 1 - Math.exp(-7 * dt));
  camLook.lerp(fLook.set(tgt.x + sx * 5, tgt.y + 1.4, tgt.z + cz * 5), 1 - Math.exp(-10 * dt));
  stage.camera.position.copy(camPos); stage.camera.lookAt(camLook);
}

// idle backdrop for the lobby: slow orbit over a demo course until a round starts
stage.buildCourse(buildMap('titan-gauntlet', 11, 0.5));
function lobbySpin(t: number) {
  if (predictor || (SCREEN ? inGameView && room?.phase === 'playing' : inGameView)) return;
  stage.camera.position.set(Math.sin(t / 7000) * 22, 9, -20 + Math.cos(t / 7000) * 5);
  stage.camera.lookAt(0, 2, 30); const tk = Math.floor(t / 16.6); stage.syncPlatforms(tk); stage.syncDynamic(tk, 0.016, { x: 0, y: 2, z: 20 });
}
renderRoom();
requestAnimationFrame(frame);

// ------------------------------------------------------------------ big-screen mode
let info: { ips: string[]; port: number; httpsPort: number | null } | null = null, qrFor = '', ipIdx = 0;
$('qr').addEventListener('click', () => { if (info && info.ips.length > 1) { ipIdx++; renderScreen(); } });
function joinUrl(code: string) {
  // plain HTTP: no certificate warning on the phone (HTTPS is only needed for the optional tilt control)
  const local = /^(localhost|127\.|\[?::1)/.test(location.hostname); // screen opened via a LAN address: that address is proven reachable
  const host = !local ? location.hostname : info?.ips.length ? info.ips[ipIdx % info.ips.length] : location.hostname;
  return `http://${host}:${info?.port ?? location.port}/pad.html?room=${code}`;
}
function renderScreen() {
  const playing = room?.phase === 'playing';
  $('screenPanel').style.display = playing ? 'none' : 'block'; $('hud').style.display = playing ? 'block' : 'none'; if (!playing) hideCells();
  if (!room) return;
  const url = joinUrl(room.code);
  if (qrFor !== url) { qrFor = url; const qr = qrcode(0, 'M'); qr.addData(url); qr.make(); $('qr').innerHTML = qr.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); $('joinUrl').textContent = url.replace(/^https?:\/\//, '') + (info && info.ips.length > 1 ? `  (rete ${ipIdx % info.ips.length + 1}/${info.ips.length}: tocca il QR se non si collega)` : ''); }
  $('scode').textContent = room.code;
  $('smembers').innerHTML = room.members.length ? room.members.map((m) => `<li><span style="color:#${ROBOT_COLORS[m.slot].toString(16).padStart(6, '0')}">● ${esc(m.name)} <small style="opacity:.7">Lv${m.level}</small>${m.host ? ' 👑' : ''}</span><span class="${m.ready ? 'ready' : 'muted'}">${!m.connected ? 'offline' : m.ready ? 'PRONTO' : '…'}</span></li>`).join('') : '<li class="muted">Nessun giocatore: scansiona il QR con il telefono</li>';
  $('scount').textContent = `${room.members.length}/7 giocatori · ${room.phase === 'countdown' ? 'via tra ' + room.countdown + '…' : 'in attesa'}`;
  const sm = $<HTMLSelectElement>('sMap'), sd = $<HTMLSelectElement>('sMode');
  if (!sm.options.length) { sm.innerHTML = ['random', ...MAP_IDS].map((id) => `<option value="${id}">${id === 'random' ? '🎲 Mappa casuale' : '🗺️ ' + MAPS[id].name}</option>`).join(''); sd.innerHTML = MODE_IDS.map((id) => `<option value="${id}">🏁 ${MODES[id].name}</option>`).join(''); }
  sm.value = room.options.map; sd.value = room.options.mode;
  $('sDesc').textContent = (room.options.map === 'random' ? 'Ogni round una mappa diversa. ' : MAPS[room.options.map]?.desc + ' ') + (MODES[room.options.mode]?.desc ?? '');
  ($('sStart') as HTMLButtonElement).disabled = room.members.length < 2 || room.phase !== 'lobby';
}
// ---- split screen: one camera + one HUD cell per player ----
const feedItems: { t: number; text: string }[] = [];
function feed(text: string) { feedItems.push({ t: performance.now(), text }); if (feedItems.length > 6) feedItems.shift(); }
function renderFeed(now: number) { const live = feedItems.filter((f) => now - f.t < 4500).slice(-4); setTxt($('feed'), 'feed', live.map((f) => `<div>${esc(f.text)}</div>`).join('')); }
const cellEls: HTMLElement[] = [];
const cache = new Map<string, string>();
const setTxt = (el: Element, key: string, v: string) => { if (cache.get(key) !== v) { cache.set(key, v); el.innerHTML = v; } };
const hexc = (n: number) => '#' + n.toString(16).padStart(6, '0');
function hideCells() { $('cells').style.display = 'none'; $('board').style.display = 'none'; }

function followCam(pc: PlayerCam, tgt: THREE.Vector3, dt: number, yawTarget = 0) {
  const back = 9.2, up = 5.2, k = 1 - Math.exp(-11 * dt), kl = 1 - Math.exp(-14 * dt); // tight follow: a floaty camera makes controls feel laggy
  pc.yaw = lerpAngle(pc.yaw, yawTarget, 1 - Math.exp(-16 * dt)); // phone-steered view, smoothed between network snapshots
  const sx = Math.sin(pc.yaw), cz = Math.cos(pc.yaw);
  const dx = tgt.x - sx * back, dy = tgt.y + up, dz = tgt.z - cz * back, lx = tgt.x + sx * 5, lz = tgt.z + cz * 5;
  if (!pc.init) { pc.yaw = yawTarget; pc.pos.set(dx, dy, dz); pc.look.set(lx, tgt.y + 1.4, lz); pc.init = true; }
  pc.pos.x += (dx - pc.pos.x) * k; pc.pos.y += (dy - pc.pos.y) * k; pc.pos.z += (dz - pc.pos.z) * k;
  pc.look.x += (lx - pc.look.x) * kl; pc.look.y += (tgt.y + 1.4 - pc.look.y) * kl; pc.look.z += (lz - pc.look.z) * kl;
  pc.cam.position.copy(pc.pos); pc.cam.lookAt(pc.look);
}

function splitFrame(dt: number, s: Snapshot) {
  const slots = [...participants].sort((a, b) => a - b), n = slots.length;
  const { cells, spare } = layoutCells(n, innerWidth, innerHeight, 4);
  const order = s.players.filter((p) => p.al === 1 || p.fr > 0).sort((a, b) => (a.fr && b.fr ? a.fr - b.fr : a.fr ? -1 : b.fr ? 1 : b.z - a.z));
  const leader = order[0] ? robotPos[order[0].s] : robotPos[slots[0]];
  const name = (slot: number) => room?.members.find((m) => m.slot === slot)?.name ?? `P${slot + 1}`;

  const views = slots.map((slot, i) => {
    const pc = playerCams[slot], p = s.players[slot];
    // an eliminated player's cell spectates the leader; a falling robot is watched from the last ground height (no chasing into the void)
    const tgt = tmpV2.copy(p && p.al === 1 ? robotPos[slot] : leader);
    if (!p || p.al !== 1 || p.g === 1 || !pc.init) pc.baseY = tgt.y; else tgt.y = Math.max(tgt.y, pc.baseY);
    if (!(window as any).__cv?.freeCam) followCam(pc, tgt, dt, (s.cy?.[slot] ?? 0) / 100); // freeCam: QA hook
    return { cam: pc.cam, rect: cells[i], before: () => { stage.focusView(pc.cam); for (let r = 0; r < robots.length; r++) robots[r].setDetail(pc.cam.position.distanceTo(robotPos[r]) < 24); } };
  });
  stage.renderViews(views);

  // ---- HUD overlay, one per cell ----
  const host = $('cells'); host.style.display = 'block';
  while (cellEls.length < n) { const d = document.createElement('div'); d.className = 'cell'; d.innerHTML = '<div class="cname"></div><div class="crank"></div><div class="cstat"></div><div class="citem"></div><div class="cover"></div><div class="cdist"></div><div class="cprog"><i></i></div>'; host.appendChild(d); cellEls.push(d); }
  cellEls.forEach((el, i) => (el.style.display = i < n ? 'block' : 'none'));
  slots.forEach((slot, i) => {
    const el = cellEls[i], r = cells[i], p = s.players[slot], k = `c${i}`;
    el.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px;--c:${hexc(cellColor(slot))}`;
    const rk = order.findIndex((o) => o.s === slot) + 1;
    const lv = memberOf(slot)?.level ?? 1, tn = teamsBySlot[slot] >= 0 ? ` · ${TEAM_NAMES[teamsBySlot[slot]]}` : '';
    setTxt(el.children[0], k + 'n', `${esc(name(slot))}<small style="opacity:.75;font-weight:600"> Lv${lv}${tn}</small>`);
    setTxt(el.children[1], k + 'r', p?.fr ? '🏁 #' + p.fr : p?.al ? `#${rk}/${order.length}` : '');
    setTxt(el.children[2], k + 's', p ? (p.st > 0 ? '💫' : p.sh > 0 ? '🛡️' : p.bo > 0 ? '⚡' : p.rs > 0 ? '⌛' : '') : '');
    setTxt(el.children[3], k + 'i', p?.it ? ICON[p.it] : '');
    const kind = MODES[room?.options.mode ?? '']?.kind, cover = el.children[4] as HTMLElement;
    let cv = '', cls = 'cover';
    if (p && !p.al && !p.fr) cv = s.sv ? '💀 ELIMINATO' : 'ESPULSO';
    else if (p?.fr) { if (kind === 'elimination') { if (p.fr <= s.qq) { cv = `✅ QUALIFICATO!<small>#${p.fr}</small>`; cls = 'cover ok'; } else { cv = `🏁 TROPPO TARDI<small>#${p.fr}</small>`; cls = 'cover late'; } } else { cv = `🏁 TRAGUARDO!<small>#${p.fr}</small>`; cls = 'cover ok'; } }
    if (cover.className !== cls) cover.className = cls; setTxt(cover, k + 'o', cv);
    const fz = s.fz, pr = fz > 0 && p ? Math.max(0, Math.min(1, p.z / fz)) : 0;
    const crownTxt = s.cw ? `${p?.cr ? '👑 ' : ''}${(s.cs[slot] ?? 0).toFixed(1)} / ${TUNING.crownWinSeconds} s` : '';
    setTxt(el.children[5], k + 'd', s.cw ? crownTxt : !s.sv && fz > 0 && p && p.al && !p.fr ? `🏁 ${Math.max(0, Math.round(fz - p.z))} m` : s.sv && p?.al ? `${s.players.filter((x) => x.al === 1).length} in piedi` : '');
    (el.children[6].firstElementChild as HTMLElement).style.width = `${(s.cw ? Math.min(1, (s.cs[slot] ?? 0) / TUNING.crownWinSeconds) : s.sv ? 0 : pr) * 100}%`;
  });
  // leaderboard goes into a spare grid cell (7 players -> 8th cell, 3 players -> 4th cell)
  const bd = $('board');
  if (spare.length) { const r = spare[0]; bd.style.cssText = `display:block;left:${r.x}px;top:${r.y}px;width:${r.w}px;height:${r.h}px`; bd.classList.add('cellboard'); }
  else bd.style.display = 'none';
  setTxt(bd, 'bd', `<div class="bt">${esc(mapName)}<br/>${esc(modeName)} · Round ${s.round + 1}</div>` + order.map((p, i) => `<div class="row-b"><b>${i + 1}</b><i style="background:${hexc(cellColor(p.s))}"></i><span>${esc(name(p.s))}</span><em>${s.cw ? (s.cs[p.s] ?? 0).toFixed(1) + 's' : p.fr ? '🏁' : p.it ? ICON[p.it] : ''}</em></div>`).join(''));
  const kd = MODES[room?.options.mode ?? '']?.kind;
  const holder = s.cw ? s.cw[3] : -1;
  const tail = s.cw ? (holder >= 0 ? `👑 ${esc(name(holder))}` : '👑 libera!') : s.sv ? `${s.players.filter((x) => x.al === 1).length} in piedi` : kd === 'team' ? `${TEAM_NAMES[0]} ${teamPointsNow[0]} — ${teamPointsNow[1]} ${TEAM_NAMES[1]}` : kd === 'elimination' ? `qualificati ${s.qf}/${s.qq}` : `arrivati ${s.qf}/${n}`;
  setTxt($('hinfo'), 'hi', `Round ${s.round + 1} · ${tail} · ${s.mp === 'intermission' ? 'prossimo round' : 'tempo'} ${Math.max(0, s.left).toFixed(0)}s`);
  renderFeed(performance.now());
  $('hbig').textContent = s.rp === 'countdown' && s.mp === 'round' ? String(Math.ceil(s.left)) : '';
}
if (SCREEN) {
  $('sMap').onchange = $('sMode').onchange = () => net.send({ k: 'config', map: $<HTMLSelectElement>('sMap').value, mode: $<HTMLSelectElement>('sMode').value });
  $('sStart').onclick = () => net.send({ k: 'start' });
  addEventListener('keydown', (e) => { if (e.code === 'KeyF') document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.(); });
  fetch('/info').then((r) => r.json()).then((i) => { info = i; if (room) renderScreen(); }).catch(() => {});
  (async () => { if (await ensureConnected('Schermo')) net.send({ k: 'screen', game: GAME }); })();
}
