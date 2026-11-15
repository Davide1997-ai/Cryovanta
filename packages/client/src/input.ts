/** Keyboard + gamepad -> camera-relative intent. The server never sees camera or keys, only the resolved vector. */
export class Input {
  private keys = new Set<string>();
  private useQueued = false;
  camYaw = 0; // radians, + rotates view to the right
  /** touch state (virtual stick + buttons) */
  private stick = { x: 0, y: 0 };
  private tJump = false; private tDive = false;
  /** a tap shorter than one frame must still register: latched until the next sample() */
  private jumpLatch = false; private diveLatch = false; private pushLatch = false;
  constructor(canvas: HTMLElement) {
    this.initTouch();
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyE' || e.code === 'KeyQ') this.useQueued = true;
      if (e.code === 'KeyF' && !e.repeat) this.pushLatch = true;
      if (['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.code)) e.preventDefault();
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => this.keys.clear());
    canvas.addEventListener('mousedown', () => { this.useQueued = true; });
    canvas.addEventListener('mousemove', (e) => { if (e.buttons & 2) this.camYaw = Math.max(-1.1, Math.min(1.1, this.camYaw + e.movementX * 0.004)); });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  /** Sample once per sim tick. `use` is a one-tick pulse (the sim edge-detects anyway). */
  sample() {
    let x = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0) + this.stick.x;
    let y = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0) + this.stick.y;
    let jump = this.down('Space') || this.tJump || this.jumpLatch, dive = this.down('ShiftLeft', 'ShiftRight') || this.tDive || this.diveLatch, use = this.useQueued;
    let push = this.down('KeyF') || this.pushLatch, grab = this.down('KeyG');
    this.jumpLatch = this.diveLatch = this.pushLatch = false;
    const gp = navigator.getGamepads?.()[0];
    if (gp) {
      const ax = Math.abs(gp.axes[0]) > 0.15 ? gp.axes[0] : 0, ay = Math.abs(gp.axes[1]) > 0.15 ? -gp.axes[1] : 0;
      x += ax; y += ay; jump ||= !!gp.buttons[0]?.pressed; dive ||= !!gp.buttons[1]?.pressed; use ||= !!gp.buttons[2]?.pressed || !!gp.buttons[5]?.pressed;
    }
    const l = Math.hypot(x, y); if (l > 1) { x /= l; y /= l; }
    // camera forward f=(sin t,0,cos t); screen-right r=(-cos t,0,sin t) (right-handed, camera looks down +Z at t=0)
    const c = Math.cos(this.camYaw), s = Math.sin(this.camYaw);
    const mx = -x * c + y * s, mz = x * s + y * c;
    this.useQueued = false;
    return { mx, mz, jump, dive, use, push, grab };
  }
  private down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }

  /** Floating left-thumb stick + JUMP / DIVE / ITEM buttons (pointer events => true multi-touch). */
  private initTouch() {
    const root = document.getElementById('touch'); if (!root) return;
    const zone = root.querySelector<HTMLElement>('#stickZone')!, base = root.querySelector<HTMLElement>('#stickBase')!, knob = root.querySelector<HTMLElement>('#stickKnob')!;
    const R = 62; let sid = -1, ox = 0, oy = 0;
    zone.addEventListener('pointerdown', (e) => {
      if (sid !== -1) return; sid = e.pointerId; zone.setPointerCapture(sid); ox = e.clientX; oy = e.clientY;
      base.style.display = 'block'; base.style.left = ox + 'px'; base.style.top = oy + 'px'; knob.style.transform = 'translate(-50%,-50%)';
    });
    zone.addEventListener('pointermove', (ev) => {
      if (ev.pointerId !== sid) return;
      const e = ev.getCoalescedEvents?.().pop() ?? ev; // newest sample, never a stale one
      let dx = e.clientX - ox, dy = e.clientY - oy; const l = Math.hypot(dx, dy);
      if (l > R) { dx = (dx / l) * R; dy = (dy / l) * R; }
      knob.style.transform = `translate(calc(-50% + ${dx}px), calc(-50% + ${dy}px))`;
      const k = Math.hypot(dx, dy) / R, dead = k < 0.12 ? 0 : k; // small dead-zone
      this.stick.x = l ? (dx / R) * (dead / k || 0) : 0; this.stick.y = l ? (-dy / R) * (dead / k || 0) : 0;
    });
    const end = (e: PointerEvent) => { if (e.pointerId !== sid) return; sid = -1; this.stick.x = this.stick.y = 0; base.style.display = 'none'; };
    zone.addEventListener('pointerup', end); zone.addEventListener('pointercancel', end);
    const hold = (id: string, set: (v: boolean) => void) => {
      const b = root.querySelector<HTMLElement>('#' + id)!;
      b.addEventListener('pointerdown', (e) => { b.setPointerCapture(e.pointerId); set(true); b.classList.add('on'); });
      const up = () => { set(false); b.classList.remove('on'); };
      b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up);
    };
    hold('bJump', (v) => { this.tJump = v; if (v) this.jumpLatch = true; }); hold('bDive', (v) => { this.tDive = v; if (v) this.diveLatch = true; });
    const item = root.querySelector<HTMLElement>('#bItem')!;
    item.addEventListener('pointerdown', () => { this.useQueued = true; item.classList.add('on'); });
    item.addEventListener('pointerup', () => item.classList.remove('on')); item.addEventListener('pointercancel', () => item.classList.remove('on'));
  }
}
