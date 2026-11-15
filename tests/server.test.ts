import { beforeEach, describe, expect, it } from 'vitest';
import { MAX_PLAYERS_PER_ROOM, PROTOCOL_VERSION } from '@cryovanta/shared';
import { World, type Bot } from './harness';

let w: World;
beforeEach(() => { w = new World(); });
const GAME = 'neon-circuit';

describe('lobby: hard cap of 7 clients per instance', () => {
  it('constant is 7', () => expect(MAX_PLAYERS_PER_ROOM).toBe(7));

  it('private room: 7 can join by code, the 8th is refused with ROOM_FULL and never enters', () => {
    const host = w.connect('host'); host.send({ k: 'create', game: GAME, isPrivate: true });
    const code = host.room!.code;
    const joiners: Bot[] = [];
    for (let i = 0; i < 6; i++) { const b = w.connect('p' + i); b.send({ k: 'join', code }); joiners.push(b); }
    expect(joiners.every((b) => b.inRoom)).toBe(true);
    expect(w.hub.rooms.get(code)!.size).toBe(7);
    const eighth = w.connect('late'); eighth.send({ k: 'join', code });
    expect(eighth.errors).toEqual(['ROOM_FULL']);
    expect(eighth.inRoom).toBe(false);
    expect(w.hub.rooms.get(code)!.size).toBe(7);
  });

  it('quickplay shards 15 clients into 7 + 7 + 1 and never exceeds 7', () => {
    const bots = Array.from({ length: 15 }, (_, i) => w.connect('q' + i));
    for (const b of bots) b.send({ k: 'quickplay', game: GAME });
    const sizes = [...w.hub.rooms.values()].map((r) => r.size).sort();
    expect(sizes).toEqual([1, 7, 7]);
    expect(bots.every((b) => b.inRoom)).toBe(true);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(7);
  });

  it('a freed slot is reusable, and rooms disappear when empty', () => {
    const a = w.connect('a'); a.send({ k: 'create', game: GAME, isPrivate: true });
    const code = a.room!.code;
    const others = Array.from({ length: 6 }, (_, i) => { const b = w.connect('o' + i); b.send({ k: 'join', code }); return b; });
    others[2].send({ k: 'leave' });
    const n = w.connect('n'); n.send({ k: 'join', code });
    expect(n.inRoom).toBe(true);
    for (const b of [a, ...others, n]) if (b.inRoom) b.send({ k: 'leave' });
    expect(w.hub.rooms.size).toBe(0);
  });

  it('unknown code / unknown game / no hello are rejected cleanly', () => {
    const b = w.connect('x'); b.send({ k: 'join', code: 'ZZZZZ' });
    b.send({ k: 'quickplay', game: 'nope' });
    expect(b.errors).toEqual(['ROOM_NOT_FOUND', 'UNKNOWN_GAME']);
    const raw = w.connect('y'); raw.client.greeted = false; raw.send({ k: 'quickplay', game: GAME });
    expect(raw.errors).toEqual(['BAD_REQUEST']);
  });
});

describe('lobby: ready-up, countdown, start', () => {
  const fill = (n: number) => {
    const first = w.connect('b0'); first.send({ k: 'create', game: GAME, isPrivate: false });
    const bots = [first];
    for (let i = 1; i < n; i++) { const b = w.connect('b' + i); b.send({ k: 'quickplay', game: GAME }); bots.push(b); }
    return bots;
  };
  it('needs >= 2 ready players; countdown cancels if someone un-readies or joins', () => {
    const [a, b] = fill(2);
    a.send({ k: 'ready', ready: true });
    expect(a.room!.phase).toBe('lobby');
    b.send({ k: 'ready', ready: true });
    expect(a.room!.phase).toBe('countdown');
    b.send({ k: 'ready', ready: false });
    expect(a.room!.phase).toBe('lobby');
    b.send({ k: 'ready', ready: true });
    expect(a.room!.phase).toBe('countdown');
    const c = w.connect('c'); c.send({ k: 'quickplay', game: GAME }); // newcomer is not ready => countdown aborts
    expect(a.room!.phase).toBe('lobby');
  });
  it('a lone ready player does not start', () => {
    const [a] = fill(1); a.send({ k: 'ready', ready: true }); w.run(600);
    expect(a.room!.phase).toBe('lobby');
  });
  it('late joiners are turned away while playing and land in a fresh room', () => {
    const bots = fill(3); bots.forEach((b) => b.send({ k: 'ready', ready: true }));
    w.run(120, () => bots[0].room!.phase === 'playing');
    expect(bots[0].room!.phase).toBe('playing');
    const late = w.connect('late'); late.send({ k: 'join', code: bots[0].room!.code });
    expect(late.errors).toEqual(['ROOM_IN_PROGRESS']);
    late.send({ k: 'quickplay', game: GAME });
    expect(late.room!.code).not.toBe(bots[0].room!.code);
  });
});

describe('authoritative match over the wire', () => {
  it('7 clients play a full elimination match (7 -> 4 -> 2 -> 1), reconcile cleanly under 3-tick latency', () => {
    const bots = Array.from({ length: 7 }, (_, i) => w.connect('r' + i, 3));
    bots[0].send({ k: 'create', game: GAME, isPrivate: true }); w.run(8); // latency: wait for the room reply
    for (const b of bots.slice(1)) b.send({ k: 'join', code: bots[0].room!.code });
    w.run(8);
    bots[0].send({ k: 'config', map: 'neon-circuit', mode: 'elimination' });
    bots.forEach((b) => b.send({ k: 'ready', ready: true }));
    w.run(60 * 60 * 15, () => bots.every((b) => b.matchEnd));
    for (const b of bots) {
      expect(b.matchEnd, 'match must finish').not.toBeNull();
      expect(b.matchEnd!.standings).toHaveLength(7);
      expect(new Set(b.matchEnd!.standings).size).toBe(7);
      expect(b.roundsSeen).toBe(3);
    }
    const ends = bots[0].log.filter((m) => m.k === 'roundEnd');
    expect(ends.map((e) => e.k === 'roundEnd' && e.qualified.length)).toEqual([4, 2, 1]);
    // prediction must stay close to the authority even with latency
    const all = bots.flatMap((b) => b.errors_).sort((a, b) => a - b);
    const pct = (p: number) => all[Math.floor(all.length * p)];
    expect(pct(0.5), 'median reconciliation error').toBeLessThan(0.05);
    expect(pct(0.99), 'p99 reconciliation error (hits/bumps the client cannot predict)').toBeLessThan(5);
    expect(Math.max(...bots.map((b) => b.maxError)), 'worst case').toBeLessThan(10);
    // room returns to the lobby afterwards with ready flags reset
    w.run(600, () => bots[0].room!.phase === 'lobby');
    expect(bots[0].room!.phase).toBe('lobby');
    expect(bots[0].room!.members.every((m) => !m.ready)).toBe(true);
  });

  it('reconnect within the grace window keeps the slot (and the cap); after it expires the slot is freed', () => {
    const bots = Array.from({ length: 3 }, (_, i) => w.connect('c' + i));
    bots[0].send({ k: 'create', game: GAME, isPrivate: true });
    bots.slice(1).forEach((b) => b.send({ k: 'join', code: bots[0].room!.code }));
    bots.forEach((b) => b.send({ k: 'ready', ready: true }));
    w.run(300, () => bots[0].room!.phase === 'playing');
    const room = w.hub.rooms.get(bots[0].room!.code)!;
    const token = bots[1].token, slot = bots[1].slot;
    bots[1].disconnect();
    expect(room.size).toBe(3); // slot still reserved
    w.run(30);
    const back = w.connect('c1-again'); back.hello(token);
    expect(back.client.room).toBe(room); expect(back.client.slot).toBe(slot);
    // second drop, never returns: slot is released after the grace period
    back.disconnect();
    w.run(60 * 4);
    expect(room.size).toBe(2);
  });
});

describe('server-side validation & anti-cheat', () => {
  const inGame = () => {
    const bots = [w.connect('a'), w.connect('b')];
    bots[0].send({ k: 'create', game: GAME, isPrivate: true });
    bots[1].send({ k: 'join', code: bots[0].room!.code });
    bots.forEach((b) => b.send({ k: 'ready', ready: true }));
    w.run(600, () => bots[0].room!.phase === 'playing');
    return bots;
  };
  it('malformed JSON, wrong types, oversized payloads and bad versions are rejected without crashing', () => {
    const b = w.connect('m');
    b.sendRaw('not json'); b.sendRaw('{"k":"input","frames":"x"}'); b.sendRaw('{"k":"nope"}'); b.sendRaw('x'.repeat(5000));
    b.send({ k: 'hello', v: PROTOCOL_VERSION + 1, name: 'z' });
    expect(b.errors).toEqual(['BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_REQUEST', 'BAD_VERSION']);
  });
  it('NaN / out-of-range input vectors are refused at the protocol layer', () => {
    const [a] = inGame();
    a.sendRaw('{"k":"input","frames":[{"seq":1,"mx":1e9,"mz":0,"jump":false,"dive":false,"use":false}]}');
    a.sendRaw('{"k":"input","frames":[{"seq":1,"mx":null,"mz":0}]}');
    expect(a.errors.filter((e) => e === 'BAD_REQUEST')).toHaveLength(2);
  });
  it('speedhack: unit-vector clamp keeps ground speed at run speed even with mx=mz=2 and 6 frames per packet', () => {
    const [a] = inGame();
    const room = w.hub.rooms.get(a.room!.code)!;
    w.run(300, () => (room as any).session.match.sim.phase === 'running');
    let seq = 0;
    for (let t = 0; t < 120; t++) {
      const frames = Array.from({ length: 6 }, () => ({ seq: ++seq, mx: 2, mz: 2, jump: false, dive: false, use: false }));
      a.send({ k: 'input', frames }); w.step();
    }
    const p = (room as any).session.match.sim.players[a.slot];
    expect(Math.hypot(p.vx, p.vz)).toBeLessThanOrEqual(9.01 * 1.65 + 0.01);
    // flooding 720 frames could not make the robot take more than one step per tick: 2s of ticks => <= ~18u + boost margin
    expect(p.z).toBeLessThan(60);
  });
  it('replayed / rewound sequence numbers are ignored', () => {
    const [a] = inGame();
    const room = w.hub.rooms.get(a.room!.code)!;
    const sess = (room as any).session;
    a.send({ k: 'input', frames: [{ seq: 10, mx: 0, mz: 1, jump: false, dive: false, use: false }] });
    a.send({ k: 'input', frames: [{ seq: 5, mx: 0, mz: 1, jump: false, dive: false, use: false }, { seq: 10, mx: 0, mz: 1, jump: false, dive: false, use: false }] });
    expect(sess.queues[a.slot].map((f: any) => f.seq)).toEqual([10]);
  });
  it('input-queue flood is capped', () => {
    const [a] = inGame();
    const sess = (w.hub.rooms.get(a.room!.code)! as any).session;
    for (let i = 0; i < 100; i++) a.send({ k: 'input', frames: Array.from({ length: 6 }, (_, j) => ({ seq: 1000 + i * 6 + j, mx: 0, mz: 1, jump: false, dive: false, use: false })) });
    expect(sess.queues[a.slot].length).toBeLessThanOrEqual(12);
  });
  it('message-rate limiter kicks in under flood', () => {
    const b = w.connect('f');
    for (let i = 0; i < 1000; i++) b.send({ k: 'ping', t: i });
    expect(b.errors).toContain('RATE_LIMITED');
  });

  it('Wi-Fi stall: a burst of 30 queued frames is skipped-ahead (never run faster than real time) and a jump tap inside it is preserved', () => {
    const [a] = inGame();
    const room = w.hub.rooms.get(a.room!.code)!; const sess = (room as any).session;
    w.run(300, () => sess.match.sim.phase === 'running');
    const p = () => sess.match.sim.players[a.slot];
    let seq = 5000; const z0 = p().z;
    // 30 frames "arrive at once": frame #10 is a jump tap, everything else just runs forward
    for (let pkt = 0; pkt < 5; pkt++) {
      const frames = Array.from({ length: 6 }, (_, j) => ({ seq: ++seq, mx: 0, mz: 1, jump: pkt * 6 + j === 10, dive: false, use: false }));
      a.send({ k: 'input', frames });
    }
    expect(sess.queues[a.slot].length).toBeLessThanOrEqual(8);
    const q = sess.queues[a.slot];
    expect(q.some((f: any) => f.jump), 'the tap must survive the skip-ahead').toBe(true);
    let maxY = p().y; for (let i = 0; i < 30; i++) { w.step(); maxY = Math.max(maxY, p().y); } // half a second of real time
    expect(p().z - z0, 'no faster than 1 input per tick').toBeLessThan(9 * 0.5 * 1.7 + 1);
    expect(maxY, 'jump executed').toBeGreaterThan(0.3);
  });
});

describe('room options (map + mode)', () => {
  const room2 = () => { const a = w.connect('host'), b = w.connect('guest'); a.send({ k: 'create', game: GAME, isPrivate: true }); b.send({ k: 'join', code: a.room!.code }); return [a, b]; };
  it('only the host can change map/mode; invalid values are rejected; a change clears ready flags', () => {
    const [a, b] = room2();
    b.send({ k: 'config', map: 'titan-gauntlet', mode: 'race' }); expect(b.errors).toEqual(['NOT_HOST']);
    a.send({ k: 'config', map: 'nope', mode: 'race' }); expect(a.errors).toEqual(['BAD_REQUEST']);
    a.send({ k: 'ready', ready: true }); b.send({ k: 'ready', ready: true }); expect(a.room!.phase).toBe('countdown');
    a.send({ k: 'config', map: 'titan-gauntlet', mode: 'grandprix' });
    expect(a.room!.phase).toBe('lobby'); expect(a.room!.options).toEqual({ map: 'titan-gauntlet', mode: 'grandprix' });
    expect(a.room!.members.every((m) => !m.ready)).toBe(true);
  });
  it('the chosen map/mode reach the clients in the round message', () => {
    const [a, b] = room2();
    a.send({ k: 'config', map: 'frost-run', mode: 'race' });
    [a, b].forEach((x) => x.send({ k: 'ready', ready: true })); w.run(300, () => a.roundsSeen > 0);
    const r = a.log.find((m) => m.k === 'round'); expect(r && r.k === 'round' && [r.map, r.mode]).toEqual(['frost-run', 'race']);
  });
});

describe('big screen (TV) role', () => {
  const screen = () => { const s = w.connect('TV'); s.send({ k: 'screen', game: GAME }); return s; };
  it('a screen creates a public room, is NOT a player and does not take one of the 7 slots', () => {
    const tv = screen(); expect(tv.isScreen).toBe(true); expect(tv.room!.displays).toBe(1); expect(tv.room!.members).toHaveLength(0);
    const code = tv.room!.code; const phones = Array.from({ length: 7 }, (_, i) => { const p = w.connect('p' + i); p.send({ k: 'join', code }); return p; });
    expect(phones.every((p) => p.inRoom)).toBe(true); expect(w.hub.rooms.get(code)!.size).toBe(7);
    const late = w.connect('late'); late.send({ k: 'join', code }); expect(late.errors).toEqual(['ROOM_FULL']);   // the cap still binds PLAYERS
    expect(tv.room!.members).toHaveLength(7);
  });
  it('phones that "quick play" land in the room that has a screen', () => {
    const other = w.connect('other'); other.send({ k: 'create', game: GAME, isPrivate: false }); const a = w.connect('a'); a.send({ k: 'quickplay', game: GAME });
    const tv = screen(); const b = w.connect('b'); b.send({ k: 'quickplay', game: GAME });
    expect(b.room!.code).toBe(tv.room!.code);
  });
  it('a screen cannot send inputs / ready / join, and the room survives with only the screen attached', () => {
    const tv = screen(); tv.send({ k: 'ready', ready: true }); tv.send({ k: 'quickplay', game: GAME });
    expect(tv.errors).toEqual(['BAD_REQUEST', 'BAD_REQUEST']);
    const p = w.connect('p'); p.send({ k: 'join', code: tv.room!.code }); p.send({ k: 'leave' });
    expect(w.hub.rooms.has(tv.room!.code)).toBe(true);            // screen keeps the room alive
    tv.disconnect(); expect(w.hub.rooms.size).toBe(0);              // last screen gone => garbage collected
  });
  it('screen picks map/mode and can force the start (needs 2+ players)', () => {
    const tv = screen(); const code = tv.room!.code;
    tv.send({ k: 'config', map: 'titan-gauntlet', mode: 'grandprix' }); expect(tv.room!.options).toEqual({ map: 'titan-gauntlet', mode: 'grandprix' });
    const a = w.connect('a'); a.send({ k: 'join', code }); tv.send({ k: 'start' }); expect(tv.errors).toEqual(['BAD_REQUEST']);
    const b = w.connect('b'); b.send({ k: 'join', code }); tv.send({ k: 'start' });
    expect(tv.room!.phase).toBe('countdown');
    w.run(300, () => tv.room!.phase === 'playing'); expect(tv.room!.phase).toBe('playing');
  });
  it('the screen receives round + snapshots (and a late screen gets the course too); players cannot force-start', () => {
    const tv = screen(); const code = tv.room!.code; const a = w.connect('a'), b = w.connect('b');
    a.send({ k: 'join', code }); b.send({ k: 'join', code }); a.send({ k: 'start' }); expect(a.errors).toEqual(['NOT_HOST']);
    tv.send({ k: 'start' }); w.run(400, () => tv.room!.phase === 'playing'); w.run(30);
    expect(tv.log.some((m) => m.k === 'round')).toBe(true);
    const late = w.connect('TV2'); late.send({ k: 'screen', game: GAME, code }); expect(late.log.some((m) => m.k === 'round')).toBe(true);
    expect(w.hub.rooms.get(code)!.displayCount).toBe(2);
  });
  it('a returning player (page reload) is sent the current round again', () => {
    const a = w.connect('a'), b = w.connect('b'); a.send({ k: 'create', game: GAME, isPrivate: true }); b.send({ k: 'join', code: a.room!.code });
    [a, b].forEach((x) => x.send({ k: 'ready', ready: true })); w.run(400, () => a.room!.phase === 'playing'); w.run(5);
    const token = b.token; b.disconnect(); const back = w.connect('b2'); back.hello(token);
    expect(back.log.some((m) => m.k === 'round')).toBe(true);
  });
});

describe('profiles, looks, emotes, telemetry', () => {
  const token = 'ab'.repeat(16);
  const pair = (hello1?: (b: Bot) => void) => { const a = w.connect('A'), b = w.connect('B'); a.send({ k: 'create', game: GAME, isPrivate: true }); b.send({ k: 'join', code: a.room!.code }); return [a, b] as const; };
  const play = (a: Bot, b: Bot, mode = 'race') => { a.send({ k: 'config', map: 'neon-circuit', mode }); [a, b].forEach((x) => x.send({ k: 'ready', ready: true })); w.run(60 * 60 * 10, () => !!a.matchEnd && !!b.matchEnd); };

  it('a well-formed token is a persistent identity; garbage tokens get a fresh one', () => {
    const a = w.connect('A'); a.hello(token); expect(a.token).toBe(token);
    const b = w.connect('B'); b.hello('not-a-token'); expect(b.token).toMatch(/^[0-9a-f]{32}$/); expect(b.token).not.toBe('not-a-token');
    expect(a.profile).toMatchObject({ level: 1, xp: 0 });
  });
  it('finishing a match awards XP (more for placing higher), saved on the profile and sent to the phone', () => {
    const [a, b] = pair(); a.hello(token); play(a, b);
    const win = a.matchEnd!.winner === a.slot ? a : b, lose = win === a ? b : a;
    expect(a.matchEnd!.xp[win.slot]).toBeGreaterThan(a.matchEnd!.xp[lose.slot]); expect(a.matchEnd!.xp[win.slot]).toBeGreaterThanOrEqual(65);
    expect(w.profiles.get(win.token).xp).toBe(a.matchEnd!.xp[win.slot]); expect(w.profiles.get(win.token).wins).toBe(1);
    expect(win.gain).toBe(a.matchEnd!.xp[win.slot]); expect(win.profile!.xp).toBeGreaterThan(0);
  });
  it('the same token on a new connection keeps its XP (levels survive across sessions)', () => {
    w.profiles.addMatch(token, 500, true); const a = w.connect('A'); a.hello(token); expect(a.profile!.xp).toBe(500); expect(a.profile!.level).toBeGreaterThanOrEqual(3);
  });
  it('look: colour is free, hats are locked by level (a forged hat is refused)', () => {
    const [a, b] = pair(); a.send({ k: 'look', c: 9, h: 5 }); // crown hat needs level 7
    expect(a.room!.members.find((m) => m.slot === a.slot)!.look).toEqual({ c: 9, h: 0 });
    w.profiles.addMatch(token, 60 * 36, false); const c = w.connect('C'); c.hello(token); c.send({ k: 'join', code: a.room!.code }); b.send({ k: 'leave' });
    c.send({ k: 'look', c: 2, h: 5 }); expect(c.room!.members.find((m) => m.slot === c.slot)!.look).toEqual({ c: 2, h: 5 });
    c.send({ k: 'look', c: 99, h: 99 }); expect(c.room!.members.find((m) => m.slot === c.slot)!.look).toEqual({ c: 2, h: 5 }); // invalid values keep the previous look
  });
  it('emotes are relayed to everyone in the snapshot stream and rate-limited per player', () => {
    const tv = w.connect('TV'); tv.send({ k: 'screen', game: GAME }); const a = w.connect('A'), b = w.connect('B'); a.send({ k: 'join', code: tv.room!.code }); b.send({ k: 'join', code: tv.room!.code });
    tv.send({ k: 'start' }); w.run(600, () => tv.room!.phase === 'playing'); w.run(200);
    const seen: any[] = []; const orig = (tv as any).onMsg.bind(tv); (tv as any).onMsg = (m: any) => { if (m.k === 'snap') seen.push(...m.ev.filter((e: any) => e.t === 'emote')); orig(m); };
    a.send({ k: 'emote', id: 1 }); a.send({ k: 'emote', id: 2 }); w.run(5); b.send({ k: 'emote', id: 3 }); w.run(5);
    expect(seen.map((e) => [e.slot, e.id])).toEqual([[a.slot, 1], [b.slot, 3]]);   // a's second emote was dropped (cooldown)
    a.send({ k: 'emote', id: 0 }); w.run(100); a.send({ k: 'emote', id: 0 }); w.run(5); expect(seen.filter((e) => e.slot === a.slot)).toHaveLength(2); // allowed again after the cooldown
    a.sendRaw('{"k":"emote","id":99}'); expect(a.errors).toContain('BAD_REQUEST');
  });
  it('every finished match writes one telemetry record with rounds, stats and standings', () => {
    const [a, b] = pair(); play(a, b);
    expect(w.telemetry).toHaveLength(1); const t = w.telemetry[0];
    expect(t).toMatchObject({ mode: 'race', players: 2 }); expect(t.rounds).toHaveLength(1); expect(t.standings).toHaveLength(2); expect(t.seconds).toBeGreaterThanOrEqual(0);
    expect(Object.keys(t.stats)).toEqual(expect.arrayContaining(['shoves', 'grabs', 'throws', 'outs', 'emotes']));
  });
});
