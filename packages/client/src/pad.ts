import { COLOR_NAMES, DT, TUNING, EMOTES, HATS, LOOK_COLORS, MAPS, MAP_IDS, MODES, MODE_IDS, PLAYER_COLORS, TEAM_COLORS, TEAM_NAMES, type InputFrame, type RoomInfo, type ServerMsg, type Snapshot } from '@cryovanta/shared';
import { Net } from './net';
import { DEFAULT_TILT, screenAngles, smooth, tiltToMove, type Angles } from './tilt';

/**
 * Phone joypad: no 3D, no prediction. Reads the tilt sensors (or an on-screen stick as fallback), sends InputFrames
 * at 60 Hz and shows only what a controller needs (rank, held item). The game itself is drawn on the big screen.
 */
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const GAME = 'neon-circuit', ICON: Record<string, string> = { boost: '⚡', seeker: '🎯', hazard: '🧱', shield: '🛡️' };
const q = new URLSearchParams(location.search);
const hex = (n: number) => '#' + n.toString(16).padStart(6, '0');
const net = new Net();

// ---- never let the browser zoom/scroll the controller (iOS Safari ignores user-scalable=no) ----
for (const t of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(t, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions);
document.addEventListener('touchmove', (e) => { if (e.touches.length > 1 || ((e as any).scale && (e as any).scale !== 1) || !(e.target as HTMLElement)?.closest?.('input,select')) e.preventDefault(); }, { passive: false });
let lastTouchEnd = 0;
// only while playing: the controls use pointer events, whereas menu buttons need their synthesized click (a blocked tap would feel like lag)
document.addEventListener('touchend', (e) => { const n = Date.now(); if (n - lastTouchEnd < 350 && document.body.classList.contains('playing')) e.preventDefault(); lastTouchEnd = n; }, { passive: false });
for (const t of ['dblclick', 'contextmenu', 'selectstart']) document.addEventListener(t, (e) => { if (!(e.target as HTMLElement)?.closest?.('input,select')) e.preventDefault(); });
// the layout viewport can change when browser bars hide/show: keep the page glued to the real visible area
const fit = () => { document.documentElement.style.setProperty('--vh-px', `${window.visualViewport?.height ?? innerHeight}px`); };
fit(); window.visualViewport?.addEventListener('resize', fit); addEventListener('orientationchange', () => setTimeout(fit, 250));

let myLevelBefore = 0;
let room: RoomInfo | null = null, me = -1, joinedName = '';
let participants: number[] = [], roundRunning = false, eliminated = false;
let latest: Snapshot | null = null;
let mode: 'tilt' | 'stick' = 'stick';
let lastAngles: Angles | null = null, neutral: Angles = { roll: 0, pitch: 0 }, sensorSeen = false;
let sx = 0, sy = 0; // smoothed tilt
const stick = { x: 0, y: 0 };
// ---- look (colour + hat) and progression ----
const stored = (() => { try { return JSON.parse(localStorage.getItem('cv-look') ?? 'null') as { c: number; h: number } | null; } catch { return null; } })();
let myLook = stored ?? { c: Math.floor(Math.random() * 7), h: 0 }, myLevel = Number((() => { try { return localStorage.getItem('cv-level'); } catch { return 1; } })() ?? 1) || 1, myTeam = -1;
function renderLooks() {
  for (const id of ['looksJoin', 'looksWait']) {
    const el = $(id);
    el.innerHTML = `<div class="sw">${LOOK_COLORS.map((c, i) => `<i data-c="${i}" class="${i === myLook.c ? 'on' : ''}" style="background:${hex(c)}" title="${COLOR_NAMES[i]}"></i>`).join('')}</div>` +
      `<div class="hats">${HATS.map((h, i) => `<b data-h="${i}" class="${i === myLook.h ? 'on' : ''} ${h.level > myLevel ? 'lock' : ''}">${h.level > myLevel ? '🔒 Lv' + h.level : h.name}</b>`).join('')}</div>`;
    el.onclick = (e) => {
      const t = e.target as HTMLElement; const c = t.dataset.c, h = t.dataset.h;
      if (c !== undefined) myLook = { ...myLook, c: Number(c) }; else if (h !== undefined && HATS[Number(h)].level <= myLevel) myLook = { ...myLook, h: Number(h) }; else return;
      try { localStorage.setItem('cv-look', JSON.stringify(myLook)); } catch { /* private mode */ }
      net.look = myLook; if (room) net.send({ k: 'look', c: myLook.c, h: myLook.h }); renderLooks(); document.documentElement.style.setProperty('--me', hex(LOOK_COLORS[myLook.c])); buzz(8);
    };
  }
}
function renderProfile() {
  const p = net.profile; if (!p) return; myLevel = p.level; try { localStorage.setItem('cv-level', String(p.level)); } catch { /* ignore */ }
  const pct = Math.max(0, Math.min(100, ((p.xp - p.prevXp) / Math.max(1, p.nextXp - p.prevXp)) * 100));
  $('xpbar').innerHTML = `Livello <b>${p.level}</b> · ${p.xp} XP · ${p.wins} vittorie<div><i style="width:${pct}%"></i></div>`; renderLooks();
}
renderLooks();

let tJump = false, jumpLatch = false, diveLatch = false, useLatch = false, tDive = false, pushLatch = false, tGrab = false;

const show = (id: 'join' | 'wait' | 'play' | 'end') => { for (const s of ['join', 'wait', 'play', 'end']) $(s).classList.toggle('hidden', s !== id); document.body.classList.toggle('playing', id === 'play'); };
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const orient = () => (screen.orientation?.angle ?? (window as any).orientation ?? 0) as number;
const buzz = (p: number | number[]) => { try { navigator.vibrate?.(p); } catch { /* iOS: no vibration API */ } };

// ------------------------------------------------------------------ sensors
function onOrientation(e: DeviceOrientationEvent) {
  if (e.beta === null || e.gamma === null) return;
  sensorSeen = true; lastAngles = screenAngles(e.beta, e.gamma, orient());
}
async function enableSensors(): Promise<'ok' | 'denied' | 'insecure' | 'none'> {
  if (!window.isSecureContext) return 'insecure';
  const DOE = (window as any).DeviceOrientationEvent;
  if (!DOE) return 'none';
  let perm = 'granted';
  try { if (typeof DOE.requestPermission === 'function') perm = await DOE.requestPermission(); } catch { perm = 'denied'; } // iOS asks here (needs the tap)
  // Always listen: whether the sensor really delivers data is the only thing that matters.
  addEventListener('deviceorientation', onOrientation as EventListener);
  await new Promise((r) => setTimeout(r, 1200));
  if (sensorSeen) return 'ok';
  return perm === 'denied' ? 'denied' : 'none';
}
const calibrate = () => { if (lastAngles) neutral = { ...lastAngles }; sx = sy = 0; };

// ------------------------------------------------------------------ join flow
$<HTMLInputElement>('name').value = localStorage.getItem('cv-name') ?? '';
$<HTMLInputElement>('code').value = (q.get('room') ?? '').toUpperCase();
$('enter').onclick = async () => {
  const name = $<HTMLInputElement>('name').value.trim() || 'Robot' + Math.floor(Math.random() * 90 + 10); localStorage.setItem('cv-name', name);
  const code = $<HTMLInputElement>('code').value.trim().toUpperCase(); $('err').textContent = ''; joinedName = name;
  mode = 'stick'; syncModeUi(); // joystick is the default; tilt is an opt-in experiment (button below the stick)
  document.documentElement.requestFullscreen?.().catch(() => {}); (navigator as any).wakeLock?.request('screen').catch(() => {}); (screen.orientation as any)?.lock?.('landscape').catch(() => {});
  try { await net.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, name, myLook); } catch { return void ($('err').textContent = 'Server non raggiungibile'); }
  net.onMsg = onMsg; net.onClose = () => void reconnect(name); renderProfile();
  net.send(code ? { k: 'join', code } : { k: 'quickplay', game: GAME });
};
async function explainNoSensors(why: string) {
  const el = $('secure'); el.classList.remove('hidden');
  if (why === 'insecure') {
    let https = ''; try { const i = await (await fetch('/info')).json(); if (i.httpsPort) https = `https://${location.hostname}:${i.httpsPort}/pad.html${location.search}`; } catch { /* ignore */ }
    el.innerHTML = 'Per usare l\'inclinazione serve il collegamento sicuro (HTTPS).' + (https ? ` <a href="${https}" style="color:#00e5ff">Apri la versione HTTPS</a> (il browser mostrerà un avviso: scegli “Avanzate → Prosegui”). ` : ' ') + 'Intanto usi il joystick.';
  } else if (why === 'denied') el.textContent = 'Permesso sensori negato: riavvia la pagina e consentilo. Intanto usi il joystick.';
  else el.textContent = 'Sensori di movimento non disponibili su questo telefono: uso il joystick.';
}
let reconnecting = false;
async function reconnect(name: string) {
  if (reconnecting) return; reconnecting = true; const t0 = performance.now();
  while (performance.now() - t0 < 25000) { try { await net.connect(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}`, name); reconnecting = false; return; } catch { await new Promise((r) => setTimeout(r, 700)); } }
  reconnecting = false; show('join'); $('err').textContent = 'Connessione persa';
}

// ------------------------------------------------------------------ messages
function onMsg(m: ServerMsg) {
  switch (m.k) {
    case 'welcome': renderProfile(); break;
    case 'profile': renderProfile(); if (m.gain > 0) { $('xpgain').textContent = `+${m.gain} XP · Livello ${m.profile.level}`; if (m.profile.level > myLevelBefore) { $('xpgain').textContent += ' 🎉 NUOVO LIVELLO!'; buzz([80, 40, 80, 40, 200]); } myLevelBefore = m.profile.level; } break;
    case 'room': room = m.room; me = m.you; renderRoom(); break;
    case 'left': room = null; show('join'); break;
    case 'error': { const t = `${m.msg}`; ($('wait').classList.contains('hidden') ? $('err') : $('werr')).textContent = t; break; }
    case 'round': myTeam = m.teams?.[me] ?? -1; if (myTeam >= 0) document.documentElement.style.setProperty('--me', hex(TEAM_COLORS[myTeam])); else document.documentElement.style.setProperty('--me', hex(LOOK_COLORS[myLook.c])); participants = m.participants; eliminated = !m.participants.includes(me); roundRunning = false; $('banner').textContent = ''; calibrate(); show('play'); break;
    case 'snap': {
      latest = m; roundRunning = m.rp === 'running' && m.mp === 'round';
      const p = m.players[me]; if (!p) break;
      if (m.rp === 'countdown') { $('banner').textContent = String(Math.ceil(m.left)); calibrate(); } else if ($('banner').textContent && /^\d$/.test($('banner').textContent!)) $('banner').textContent = '';
      $('bItem').textContent = p.it ? ICON[p.it] : '🎁'; $('bItem').style.opacity = p.it ? '1' : '.4';
      $('bPush').style.opacity = p.pc > 0 ? '.45' : '1'; $('bPush').textContent = p.gb > 0 ? 'LANCIA!' : 'SPINGI'; $('bGrab').classList.toggle('on', p.gb > 0 || p.sl > 0);
      $('dist').textContent = m.cw ? `👑 ${(m.cs[me] ?? 0).toFixed(1)} / ${TUNING.crownWinSeconds} s` : m.sv ? '' : m.fz > 0 ? `🏁 ${Math.max(0, Math.round(m.fz - p.z))} m` : '';
      $('pname').textContent = joinedName + (myTeam >= 0 ? ` · ${TEAM_NAMES[myTeam]}` : p.cr ? ' · 👑' : '');
      const order = m.players.filter((x) => x.al === 1).sort((a, b) => (a.fr && b.fr ? a.fr - b.fr : a.fr ? -1 : b.fr ? 1 : b.z - a.z)); const rk = order.findIndex((x) => x.s === me) + 1;
      const alive = m.players.filter((x) => x.al === 1).length;
      $('rank').textContent = p.fr ? `🏁 #${p.fr}` : p.al ? (m.sv ? `${alive} in piedi` : `#${rk}/${order.length}`) : 'ESPULSO'; $('status').textContent = p.st > 0 ? '💫' : p.bo > 0 ? '⚡' : p.sh > 0 ? '🛡️' : p.rs > 0 ? '⌛' : '';
      for (const e of m.ev) {
        if (e.t === 'pickup' && e.slot === me) buzz(30);
        if (e.t === 'impact' && e.victim === me) buzz(e.outcome === 'hit' ? [90, 40, 90] : 40);
        if (e.t === 'finish' && e.slot === me) { buzz([60, 40, 60, 40, 200]); $('banner').textContent = `🏁 #${e.rank}`; setTimeout(() => { if ($('banner').textContent.startsWith('🏁')) $('banner').textContent = ''; }, 2500); }
        if (e.t === 'fall' && e.slot === me) buzz(60);
        if (e.t === 'grab' && (e.slot === me || e.victim === me)) buzz([40, 30, 40]);
        if (e.t === 'out' && e.slot === me) { $('banner').textContent = '💀 FUORI!'; buzz([200, 80, 200]); }
      }
      break;
    }
    case 'roundEnd': if (m.eliminated.includes(me) && room && MODES[room.options.mode]?.kind === 'elimination') { $('banner').textContent = '❌ ELIMINATO'; buzz([200, 80, 200]); } else if (m.qualified.includes(me)) $('banner').textContent = '✅'; setTimeout(() => ($('banner').textContent = ''), 3000); break;
    case 'matchEnd': {
      const names = new Map(room?.members.map((x) => [x.slot, x.name])); const gp = m.points.some((p) => p > 0);
      $('results').innerHTML = m.standings.map((s, i) => `<div style="color:${hex(PLAYER_COLORS[s % 7])}">${i + 1}. ${esc(names.get(s) ?? '?')}${s === m.winner ? ' 🏆' : ''}${gp ? ` — ${m.points[s]} pt` : ''}${s === me ? ' (tu)' : ''}</div>`).join(''); show('end'); buzz(m.winner === me ? [100, 60, 100, 60, 300] : 120); break;
    }
  }
}

function renderRoom() {
  if (!room) return;
  document.documentElement.style.setProperty('--me', hex(PLAYER_COLORS[Math.max(0, me) % 7]));
  $('pname').textContent = joinedName;
  if (room.phase === 'playing' || room.phase === 'results') { if (room.phase === 'playing' && $('play').classList.contains('hidden') && $('end').classList.contains('hidden')) show('play'); return; }
  show('wait'); $('meName').textContent = joinedName; $('rcode').textContent = room.code; $('rcount').textContent = `${room.members.length}/7`;
  $('rphase').textContent = room.phase === 'countdown' ? `via tra ${room.countdown}…` : 'in attesa';
  $('plist').innerHTML = room.members.map((m) => `<li><span style="color:${hex(PLAYER_COLORS[m.slot % 7])}">● ${esc(m.name)}${m.host ? ' 👑' : ''}${m.slot === me ? ' (tu)' : ''}</span><span class="${m.ready ? 'ok' : ''}">${!m.connected ? 'offline' : m.ready ? 'PRONTO' : '…'}</span></li>`).join('');
  const mine = room.members.find((m) => m.slot === me); $('ready').textContent = mine?.ready ? 'ANNULLA' : 'PRONTO!';
  // the host phone may pick map/mode only when no big screen is attached (the screen has the full menu)
  const isHost = room.members.find((m) => m.host)?.slot === me, cfg = $('cfgRow');
  cfg.classList.toggle('hidden', !(isHost && room.displays === 0));
  const sm = $<HTMLSelectElement>('selMap'), sd = $<HTMLSelectElement>('selMode');
  if (!sm.options.length) { sm.innerHTML = ['random', ...MAP_IDS].map((id) => `<option value="${id}">${id === 'random' ? '🎲 Casuale' : MAPS[id].name}</option>`).join(''); sd.innerHTML = MODE_IDS.map((id) => `<option value="${id}">${MODES[id].name}</option>`).join(''); }
  sm.value = room.options.map; sd.value = room.options.mode;
}
$('selMap').onchange = $('selMode').onchange = () => net.send({ k: 'config', map: $<HTMLSelectElement>('selMap').value, mode: $<HTMLSelectElement>('selMode').value });
$('ready').onclick = () => { const mine = room?.members.find((m) => m.slot === me); calibrate(); net.send({ k: 'ready', ready: !mine?.ready }); };
$('leave').onclick = () => net.send({ k: 'leave' });
$('calBtn').onclick = () => { calibrate(); buzz(20); };
$('again').onclick = () => { show('wait'); renderRoom(); };
$('modeBtn').onclick = async () => {
  if (mode === 'tilt') { mode = 'stick'; syncModeUi(); return; }
  const r = await enableSensors(); // inside the tap: iOS shows its permission prompt here
  if (r === 'ok') { mode = 'tilt'; calibrate(); } else { void explainNoSensors(r); alert(r === 'insecure' ? 'L\'inclinazione richiede HTTPS: apri l\'indirizzo https del joypad (il browser mostrerà un avviso).' : 'Sensori non disponibili o permesso negato: resti sul joystick.'); }
  syncModeUi();
};
function syncModeUi() {
  const tilt = mode === 'tilt';
  $('modeBtn').textContent = tilt ? '🕹️ Joystick' : '📱 Inclinazione (beta)'; $('stickZone').style.display = tilt ? 'none' : 'block';
  $('ring').style.display = tilt ? 'block' : 'none'; $('ringLbl').style.display = tilt ? 'block' : 'none'; $('calBtn').style.display = tilt ? 'block' : 'none'; $('stickHint').style.display = tilt ? 'none' : 'block';
}

// ------------------------------------------------------------------ touch: floating joystick + buttons
{
  const zone = $('stickZone'), base = $('stickBase'), knob = $('stickKnob'); let sid = -1, ox = 0, oy = 0; const R = 72;
  zone.addEventListener('pointerdown', (e) => {
    if (sid !== -1 || mode !== 'stick') return; sid = e.pointerId; zone.setPointerCapture(sid); ox = e.clientX; oy = e.clientY;
    $('stickHint').style.display = 'none'; base.style.display = 'block'; base.style.left = ox + 'px'; base.style.top = oy + 'px'; knob.style.transform = 'translate(-50%,-50%)'; stick.x = stick.y = 0; buzz(6);
  });
  zone.addEventListener('pointermove', (e) => {
    if (e.pointerId !== sid) return;
    const ev = e.getCoalescedEvents?.().pop() ?? e; // newest finger position, never a stale one
    let dx = ev.clientX - ox, dy = ev.clientY - oy; const l = Math.hypot(dx, dy);
    if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
    knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
    const k = Math.hypot(dx, dy) / R, dz = 0.08, n = k < dz ? 0 : Math.pow((k - dz) / (1 - dz), 1.15); // tiny dead-zone, almost linear
    stick.x = k ? (dx / R / k) * n : 0; stick.y = k ? (-dy / R / k) * n : 0;
  });
  const end = (e: PointerEvent) => { if (e.pointerId !== sid) return; sid = -1; stick.x = stick.y = 0; base.style.display = 'none'; if (mode === 'stick') $('stickHint').style.display = 'block'; };
  zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
  const hold = (id: string, set: (v: boolean) => void, latch: () => void) => { const b = $(id); b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); set(true); latch(); b.classList.add('on'); buzz(8); }); const up = () => { set(false); b.classList.remove('on'); }; b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); };
  hold('bJump', (v) => { tJump = v; }, () => { jumpLatch = true; }); hold('bDive', (v) => { tDive = v; }, () => { diveLatch = true; }); hold('bItem', () => {}, () => { useLatch = true; });
  hold('bPush', () => {}, () => { pushLatch = true; }); hold('bGrab', (v) => { tGrab = v; }, () => {});
}

// ---- emotes: tap 💬, pick one (the server rate-limits them; everybody sees it on the big screen) ----
$('bEmote').addEventListener('pointerdown', (e) => { e.stopPropagation(); $('emoteWheel').classList.toggle('open'); });
$('emoteWheel').addEventListener('pointerdown', (e) => { const b = (e.target as HTMLElement).closest('button'); if (!b) return; net.send({ k: 'emote', id: Number(b.dataset.e) }); $('emoteWheel').classList.remove('open'); buzz(10); });
void EMOTES;

// ------------------------------------------------------------------ 60 Hz control loop
let acc = 0, last = performance.now(), seq = 0, unsent = 0, lastSend = 0; const buf: InputFrame[] = [];
function sample(): InputFrame {
  let x = 0, y = 0;
  if (mode === 'tilt' && lastAngles) { const v = tiltToMove(lastAngles, neutral, DEFAULT_TILT); sx = smooth(sx, v.x, DT); sy = smooth(sy, v.y, DT); x = sx; y = sy; }
  else { sx = stick.x; sy = stick.y; x = sx; y = sy; } // joystick: no smoothing => zero added latency
  const f: InputFrame = { seq: ++seq, mx: -x, mz: y, jump: tJump || jumpLatch, dive: tDive || diveLatch, use: useLatch, push: pushLatch, grab: tGrab }; // screen camera looks down +Z: right = -X
  jumpLatch = diveLatch = useLatch = pushLatch = false; return f;
}
function frame(now: number) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  const active = room?.phase === 'playing' && !eliminated && !$('play').classList.contains('hidden');
  if (active) {
    acc += dt;
    while (acc >= DT) { acc -= DT; buf.push(sample()); if (buf.length > 6) buf.shift(); unsent++; }
    // flush on EVERY frame: nothing waits for the next one (each packet repeats 2 older frames for loss protection)
    if (unsent > 0) { net.send({ k: 'input', frames: buf.slice(-Math.min(6, unsent + 2)) }); unsent = 0; lastSend = now; }
    if (mode === 'tilt') $('dot').style.transform = `translate(${sx * 52}px, ${-sy * 52}px)`;
  } else acc = 0;
  requestAnimationFrame(frame);
}
syncModeUi(); requestAnimationFrame(frame);
addEventListener('beforeunload', () => net.send({ k: 'leave' }));
(window as any).__pad = { get mode() { return mode; }, get sensorSeen() { return sensorSeen; }, get tilt() { return { sx, sy }; }, get room() { return room; }, get me() { return me; } };
