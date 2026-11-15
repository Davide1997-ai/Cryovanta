/**
 * Procedural audio: every sound is synthesised with WebAudio (no files to download or license).
 * Browsers only allow audio after a user gesture, so call `audio.unlock()` from a click/keypress.
 */
type Wave = OscillatorType;

class Sfx {
  private ctx: AudioContext | null = null;
  private master!: GainNode; private musicGain!: GainNode;
  muted = false; private musicTimer = 0; private beat = 0; private theme: 'neon' | 'sunny' | 'frost' = 'sunny'; private last = new Map<string, number>();
  get unlocked() { return !!this.ctx && this.ctx.state === 'running'; }

  unlock() {
    try {
      if (!this.ctx) {
        this.ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        this.master = this.ctx.createGain(); this.master.gain.value = this.muted ? 0 : 0.7; this.master.connect(this.ctx.destination);
        this.musicGain = this.ctx.createGain(); this.musicGain.gain.value = 0.16; this.musicGain.connect(this.master);
      }
      void this.ctx.resume();
    } catch { /* no audio available: the game stays silent */ }
  }
  toggleMute() { this.muted = !this.muted; if (this.master) this.master.gain.value = this.muted ? 0 : 0.7; return this.muted; }

  private env(g: GainNode, t: number, a: number, d: number, peak: number) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
  private tone(freq: number, dur: number, type: Wave = 'sine', vol = 0.3, slideTo?: number, delay = 0, dest?: AudioNode) {
    if (!this.ctx) return; const t = this.ctx.currentTime + delay, o = this.ctx.createOscillator(), g = this.ctx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t); if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    this.env(g, t, 0.008, dur, vol); o.connect(g); g.connect(dest ?? this.master); o.start(t); o.stop(t + dur + 0.05);
  }
  private noise(dur: number, vol = 0.3, lp = 1800, delay = 0, hp = 0) {
    if (!this.ctx) return; const t = this.ctx.currentTime + delay, n = Math.max(1, Math.floor(this.ctx.sampleRate * dur)), buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const s = this.ctx.createBufferSource(); s.buffer = buf; const f = this.ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lp; const g = this.ctx.createGain(); this.env(g, t, 0.004, dur, vol);
    s.connect(f); if (hp) { const h = this.ctx.createBiquadFilter(); h.type = 'highpass'; h.frequency.value = hp; f.connect(h); h.connect(g); } else f.connect(g); g.connect(this.master); s.start(t);
  }

  /** Named sound effects (rate-limited per name so a brawl does not turn into noise). */
  play(name: string) {
    if (!this.ctx || this.muted) return; const now = performance.now(), gap = ({ shove: 90, bump: 120, emote: 200, tile: 160 } as Record<string, number>)[name] ?? 40;
    if (now - (this.last.get(name) ?? 0) < gap) return; this.last.set(name, now);
    switch (name) {
      case 'beep': this.tone(660, 0.14, 'square', 0.18); break;
      case 'go': this.tone(990, 0.4, 'square', 0.22); this.tone(1320, 0.4, 'triangle', 0.15, undefined, 0.02); break;
      case 'pickup': [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.12, 'triangle', 0.18, undefined, i * 0.05)); break;
      case 'use': this.noise(0.25, 0.25, 3500, 0, 800); this.tone(300, 0.25, 'sawtooth', 0.12, 900); break;
      case 'shove': this.noise(0.12, 0.35, 900); this.tone(140, 0.14, 'sine', 0.35, 60); break;
      case 'bump': this.noise(0.1, 0.25, 600); this.tone(110, 0.12, 'sine', 0.3, 55); break;
      case 'grab': this.tone(380, 0.07, 'square', 0.14); this.tone(560, 0.07, 'square', 0.14, undefined, 0.06); break;
      case 'throw': this.noise(0.3, 0.3, 4000, 0, 600); this.tone(200, 0.3, 'sawtooth', 0.18, 700); break;
      case 'hit': this.tone(220, 0.2, 'sawtooth', 0.22, 80); this.noise(0.1, 0.2, 1200); break;
      case 'finish': [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.22, 'square', 0.14, undefined, i * 0.07)); break;
      case 'qualified': [392, 523, 659, 784].forEach((f, i) => this.tone(f, 0.18, 'triangle', 0.2, undefined, i * 0.09)); break;
      case 'out': this.tone(440, 0.5, 'sawtooth', 0.2, 80); break;
      case 'fall': this.tone(900, 0.6, 'sine', 0.16, 120); break;
      case 'crownTake': [784, 988, 1175].forEach((f, i) => this.tone(f, 0.16, 'triangle', 0.2, undefined, i * 0.06)); break;
      case 'crownDrop': this.tone(500, 0.3, 'triangle', 0.2, 200); break;
      case 'tile': this.noise(0.08, 0.3, 2500, 0, 500); break;
      case 'emote': this.tone(700, 0.08, 'sine', 0.2, 1200); this.tone(1100, 0.1, 'sine', 0.16, undefined, 0.07); break;
      case 'win': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.25, 'square', 0.15, undefined, i * 0.11)); break;
    }
  }

  // ---- background music: a tiny generative loop (bass + arpeggio), different feel per theme ----
  startMusic(theme: 'neon' | 'sunny' | 'frost') {
    this.theme = theme; if (!this.ctx || this.musicTimer) return;
    this.musicTimer = window.setInterval(() => { if (this.ctx && !this.muted && this.ctx.state === 'running') this.step(); }, 230);
  }
  stopMusic() { clearInterval(this.musicTimer); this.musicTimer = 0; }
  private step() {
    const scale = this.theme === 'neon' ? [0, 3, 7, 10, 12, 15] : this.theme === 'frost' ? [0, 2, 7, 9, 12, 14] : [0, 2, 4, 7, 9, 12]; // minor-ish for space, pentatonic for the sunny park
    const root = this.theme === 'neon' ? 110 : 130.8, b = this.beat++, f = (n: number) => root * Math.pow(2, n / 12);
    if (b % 4 === 0) this.tone(f(scale[(b / 4) % 3 === 0 ? 0 : 2] - 12), 0.4, 'triangle', 0.5, undefined, 0, this.musicGain);
    this.tone(f(scale[(b * 3 + (b >> 2)) % scale.length] + 12), 0.16, this.theme === 'neon' ? 'sawtooth' : 'square', 0.22, undefined, 0, this.musicGain);
    if (b % 2 === 1) this.noise(0.04, 0.1, 6000, 0, 4000);
  }
}
export const audio = new Sfx();
