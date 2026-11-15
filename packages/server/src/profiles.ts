import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { profileView, type Profile } from '@cryovanta/shared';

export const validToken = (t: unknown): t is string => typeof t === 'string' && /^[0-9a-f]{32}$/.test(t);

/** Persistent player profiles (xp, matches, wins) keyed by the secret token the phone keeps in localStorage. file=null => memory only (tests). */
export class ProfileStore {
  private data: Record<string, { xp: number; matches: number; wins: number }> = {};
  private timer: NodeJS.Timeout | null = null;
  constructor(private file: string | null) {
    if (file && existsSync(file)) { try { this.data = JSON.parse(readFileSync(file, 'utf8')); } catch { console.warn('[cryovanta] profiles file unreadable, starting fresh'); } }
  }
  get(token: string): Profile { const d = this.data[token]; return profileView(d?.xp ?? 0, d?.matches ?? 0, d?.wins ?? 0); }
  addMatch(token: string, xp: number, win: boolean): Profile {
    const d = (this.data[token] ??= { xp: 0, matches: 0, wins: 0 });
    d.xp += Math.max(0, Math.round(xp)); d.matches++; if (win) d.wins++;
    this.schedule(); return this.get(token);
  }
  private schedule() { if (!this.file || this.timer) return; this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 1500); this.timer.unref?.(); }
  flush() {
    if (!this.file) return;
    try { mkdirSync(dirname(this.file), { recursive: true }); const tmp = this.file + '.tmp'; writeFileSync(tmp, JSON.stringify(this.data)); renameSync(tmp, this.file); } catch (e) { console.warn('[cryovanta] cannot save profiles:', (e as Error).message); }
  }
}
