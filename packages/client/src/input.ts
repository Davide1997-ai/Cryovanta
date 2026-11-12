/** Keyboard + gamepad -> camera-relative intent. The server never sees camera or keys, only the resolved vector. */
export class Input {
  private keys = new Set<string>();
  private useQueued = false;
  camYaw = 0; // radians, + rotates view to the right
  constructor(canvas: HTMLElement) {
    addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.keys.add(e.code);
      if (e.code === 'KeyE' || e.code === 'KeyQ') this.useQueued = true;
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
    let x = (this.down('KeyD', 'ArrowRight') ? 1 : 0) - (this.down('KeyA', 'ArrowLeft') ? 1 : 0);
    let y = (this.down('KeyW', 'ArrowUp') ? 1 : 0) - (this.down('KeyS', 'ArrowDown') ? 1 : 0);
    let jump = this.down('Space'), dive = this.down('ShiftLeft', 'ShiftRight'), use = this.useQueued;
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
    return { mx, mz, jump, dive, use };
  }
  private down(...codes: string[]) { return codes.some((c) => this.keys.has(c)); }
}
