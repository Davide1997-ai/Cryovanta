/**
 * Fake players to fill a room (solo testing, demos, load tests).
 *   npm run bots -- <ROOM_CODE> [count=5] [race|brawl] [host=localhost:8080]
 *  race  : runs the course (naive navigation bot) and shoves whoever is in the way
 *  brawl : chases the nearest robot and shoves / grabs / throws it (great on the Arena map)
 */
import WebSocket from 'ws';
import { PROTOCOL_VERSION, Predictor, botInput, buildMap, type InputFrame, type ServerMsg, type Snapshot } from '@cryovanta/shared';

const [, , code, nArg = '5', style = 'race', host = 'localhost:8080'] = process.argv;
if (!code) { console.error('usage: npm run bots -- <ROOM_CODE> [count] [race|brawl] [host]'); process.exit(1); }
const n = Math.min(7, Number(nArg) || 5);

function spawn(i: number) {
  const ws = new WebSocket(`ws://${host}`);
  let me = -1, predictor: Predictor | null = null, snap: Snapshot | null = null, seq = 0, active = false;
  const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  ws.on('open', () => { send({ k: 'hello', v: PROTOCOL_VERSION, name: `Bot${i + 1}` }); send({ k: 'join', code: code.toUpperCase() }); });
  ws.on('message', (d) => {
    const m = JSON.parse(d.toString()) as ServerMsg;
    if (m.k === 'room') { me = m.you; if (m.room.phase === 'lobby' && !m.room.members.find((x) => x.slot === me)?.ready) setTimeout(() => send({ k: 'ready', ready: true }), 300 + i * 120); }
    else if (m.k === 'round') { active = m.participants.includes(me); predictor = active && style === 'race' ? new Predictor(buildMap(m.map, m.seed, m.difficulty), me) : null; }
    else if (m.k === 'snap') { snap = m; predictor?.reconcile(m); }
    else if (m.k === 'error') console.log(`Bot${i + 1}: ${m.code} ${m.msg}`);
  });
  const frames: InputFrame[] = [];
  setInterval(() => {
    if (!snap || !active || snap.rp !== 'running') return;
    const mine = snap.players[me]; if (!mine || !mine.al) return;
    let f: InputFrame;
    if (style === 'brawl') {
      let best: typeof mine | null = null, bd = 1e9;
      for (const p of snap.players) if (p.s !== me && p.al && p.rs <= 0) { const d = Math.hypot(p.x - mine.x, p.z - mine.z); if (d < bd) { bd = d; best = p; } }
      const dx = best ? best.x - mine.x : -mine.x, dz = best ? best.z - mine.z : -mine.z, l = Math.hypot(dx, dz) || 1;
      const t = snap.tick, near = bd < 1.9;
      f = { seq: ++seq, mx: dx / l, mz: dz / l, jump: false, dive: false, use: !!mine.it && t % 40 === 0, push: near && mine.pc === 0 && t % 7 === 0, grab: near && (i + Math.floor(t / 150)) % 3 === 0 && mine.gb >= 0 };
      if (mine.gb > 0 && t % 20 === 0) f.push = true; // throw what we hold
    } else if (predictor?.running) {
      const g = botInput(predictor.state, predictor.course, predictor.tick + 1, 0, { useItems: true });
      let shove = false; for (const p of snap.players) if (p.s !== me && p.al && Math.hypot(p.x - mine.x, p.z - mine.z) < 1.8 && mine.pc === 0 && (snap.tick + i) % 25 === 0) shove = true;
      f = predictor.step({ mx: g.mx, mz: g.mz, jump: g.jump, dive: g.dive, use: g.use, push: shove, grab: false });
    } else return;
    frames.push(f); if (frames.length > 3) frames.shift(); send({ k: 'input', frames });
  }, 16);
}
for (let i = 0; i < n; i++) spawn(i);
console.log(`${n} bot(s) joining room ${code} (${style})`);
