import * as THREE from 'three';
import {
  DT, INTERP_DELAY_MS, MAPS, MAP_IDS, MAX_PLAYERS_PER_ROOM, MODES, MODE_IDS, Predictor, buildMap, encodePlayer, lerp, lerpAngle,
  type InputFrame, type RoomInfo, type ServerMsg, type SnapPlayer, type Snapshot,
} from '@cryovanta/shared';
import { Input } from './input';
import { Net } from './net';
import { Robot, ROBOT_COLORS } from './robot';
import { Stage } from './scene';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAME = 'neon-circuit';
const ICON: Record<string, string> = { boost: '⚡', seeker: '🎯', hazard: '🧱', shield: '🛡️' };

const isTouch = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
if (isTouch) document.body.classList.add('touch');
const canvas = $<HTMLCanvasElement>('c');
const stage = new Stage(canvas);
const input = new Input(canvas);
const net = new Net();
const robots = Array.from({ length: MAX_PLAYERS_PER_ROOM }, (_, i) => { const r = new Robot(i); stage.scene.add(r.root); r.root.visible = false; return r; });

let room: RoomInfo | null = null;
let me = -1;
let predictor: Predictor | null = null;
let snaps: { t: number; s: Snapshot }[] = [];
let participants: number[] = [];
/** Adaptive jitter buffer: widens when Wi-Fi delivers snapshots in bursts, shrinks again when it calms down. */
let interpDelay = INTERP_DELAY_MS, snapGap = 50, lastSnapT = 0;
let toastTimer = 0;
let mapName = '', modeName = '';

// ------------------------------------------------------------------ UI
const err = (t: string) => { $('err').textContent = t; };
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
    try { await net.connect(lastUrl, lastName); connected = true; reconnecting = false; toast('Riconnesso!'); return; } catch { await new Promise((r) => setTimeout(r, 700)); }
  }
  reconnecting = false; room = null; predictor = null; renderRoom(); err('Connessione persa');
}
async function start(then: () => void) {
  err('');
  if (!connected) {
    const name = $<HTMLInputElement>('name').value.trim() || 'Bolt-' + Math.floor(Math.random() * 99);
    const url = new URLSearchParams(location.search).get('server') ?? (location.port === '5173' ? `ws://${location.hostname || 'localhost'}:8080` : `ws://${location.host}`); // dev: separate server; packaged/LAN: same origin
    try { await net.connect(url, name); connected = true; } catch { return err('Server non raggiungibile'); }
    lastName = name; lastUrl = url; net.onMsg = onMsg; net.onClose = reconnect;
  }
  then();
}

// ------------------------------------------------------------------ network
function onMsg(m: ServerMsg) {
  switch (m.k) {
    case 'room': room = m.room; me = m.you; renderRoom(); break;
    case 'left': room = null; predictor = null; renderRoom(); break;
    case 'error': err(`${m.code}: ${m.msg}`); break;
    case 'round': {
      const course = buildMap(m.map, m.seed, m.difficulty); mapName = MAPS[m.map]?.name ?? m.map; modeName = MODES[m.mode]?.name ?? m.mode;
      stage.buildCourse(course);
      predictor = new Predictor(course, me);
      snaps = []; participants = m.participants;
      $('results').style.display = 'none';
      toast(`${mapName.toUpperCase()} · ROUND ${m.round + 1}${MODES[m.mode]?.kind === 'elimination' ? ' — passano ' + m.qualify : ''}`, 3000);
      break;
    }
    case 'snap': {
      const nowT = performance.now();
      if (lastSnapT) { const gap = nowT - lastSnapT; snapGap = snapGap * 0.9 + Math.abs(gap - 50) * 0.1; }
      lastSnapT = nowT;
      interpDelay += (Math.min(260, Math.max(INTERP_DELAY_MS, 90 + snapGap * 3)) - interpDelay) * 0.05;
      snaps.push({ t: nowT, s: m }); if (snaps.length > 40) snaps.shift();
      predictor?.reconcile(m);
      for (const e of m.ev) {
        if (e.t === 'pickup' && e.slot === me) toast(`${ICON[e.item]} ${e.item.toUpperCase()}!`);
        if (e.t === 'impact' && e.victim === me) toast(e.outcome === 'blocked' ? '🛡️ PARATO!' : e.outcome === 'smashed' ? '💥 SFONDATO!' : e.kind === 'obstacle' ? '🔨 OSTACOLO!' : '💫 COLPITO!');
        if (e.t === 'finish' && e.slot === me) toast(`🏁 TRAGUARDO #${e.rank}`, 2500);
        if (e.t === 'fall' && e.slot === me) toast('Caduto!');
      }
      break;
    }
    case 'roundEnd':
      toast(m.qualified.includes(me) ? '✅ QUALIFICATO' : '❌ ELIMINATO', 3500); break;
    case 'matchEnd': {
      const names = new Map(room?.members.map((x) => [x.slot, x.name]));
      $('results').style.display = ''; $('lobby').style.display = '';
      const gp = m.points.some((p) => p > 0);
      $('results').innerHTML = `<h3>Classifica · ${esc(modeName)}</h3>` + m.standings.map((s, i) => `<div>${i + 1}. ${esc(names.get(s) ?? '?')}${s === m.winner ? ' 🏆' : ''}${gp ? ` — ${m.points[s]} pt` : ''}</div>`).join('');
      break;
    }
  }
}

// ------------------------------------------------------------------ main loop
let fpsCount = 0, fpsT = performance.now(), fps = 0;
(window as any).__cv = { freeCam: false, stage, net, get fps() { return fps; }, get predictor() { return predictor; }, get room() { return room; } };
let acc = 0, last = performance.now(), sendBuf: InputFrame[] = [], unsent = 0, lastSendT = 0;
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

function render(dt: number, now: number) {
  fpsCount++; if (now - fpsT >= 1000) { fps = fpsCount * 1000 / (now - fpsT); fpsCount = 0; fpsT = now; }
  stage.adaptQuality(fps || 60, dt);
  const br = pickBracket(now - interpDelay);
  const latest = snaps[snaps.length - 1]?.s;
  const dynTick = predictor?.running ? predictor.tick : (latest?.tick ?? 0);
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
      robots[s].update(dt, ps, pos, stage.camera.position.distanceTo(tmpV.set(pos.x, pos.y, pos.z)));
      stage.blob(s, pos.x, pos.y, pos.z, ps.al === 1 && ps.rs <= 0, dynTick);
    }
    stage.animate(dt, latest.bx);
    syncProjectiles(br);
    hud(latest);
    follow(dt, latest);
  }
  if (now > toastTimer) $('htoast').textContent = '';
  $('net').textContent = `${fps.toFixed(0)}fps · ${stage.renderer.info.render.calls} calls · rtt ${net.rtt.toFixed(0)}ms · buf ${interpDelay.toFixed(0)}ms · err ${(predictor?.lastError ?? 0).toFixed(2)}u · pending ${predictor?.pending.length ?? 0}`;
  stage.render();
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

function follow(dt: number, s: Snapshot) {
  if ((window as any).__cv?.freeCam) return; // debug: lets tests/QA inspect any part of the map
  let tgt = predictor && s.players[me]?.al ? { x: predictor.state.x, y: predictor.state.y, z: predictor.state.z } : null;
  if (!tgt) { // spectate the front-runner
    const lead = s.players.filter((p) => p.al === 1).sort((a, b) => b.z - a.z)[0];
    tgt = lead ? { x: lead.x, y: lead.y, z: lead.z } : { x: 0, y: 0, z: 0 };
  }
  const yaw = input.camYaw, sx = Math.sin(yaw), cz = Math.cos(yaw);
  const desired = new THREE.Vector3(tgt.x - sx * 9.5, tgt.y + 5.4, tgt.z - cz * 9.5);
  camPos.lerp(desired, 1 - Math.exp(-7 * dt));
  camLook.lerp(new THREE.Vector3(tgt.x + sx * 5, tgt.y + 1.4, tgt.z + cz * 5), 1 - Math.exp(-10 * dt));
  stage.camera.position.copy(camPos); stage.camera.lookAt(camLook);
}

// idle backdrop for the lobby: slow orbit over a demo course until a round starts
stage.buildCourse(buildMap('titan-gauntlet', 11, 0.5));
function lobbySpin(t: number) {
  if (predictor) return;
  stage.camera.position.set(Math.sin(t / 7000) * 22, 9, -20 + Math.cos(t / 7000) * 5);
  stage.camera.lookAt(0, 2, 30); const tk = Math.floor(t / 16.6); stage.syncPlatforms(tk); stage.syncDynamic(tk, 0.016, { x: 0, y: 2, z: 20 });
}
renderRoom();
requestAnimationFrame(frame);
