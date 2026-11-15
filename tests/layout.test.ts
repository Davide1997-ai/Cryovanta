import { describe, expect, it } from 'vitest';
import { gridFor, layoutCells } from '../packages/client/src/layout';

describe('split-screen layout', () => {
  it('uses the intended grids', () => { expect([1, 2, 3, 4, 5, 6, 7].map((n) => Object.values(gridFor(n)).join('x'))).toEqual(['1x1', '2x1', '2x2', '2x2', '3x2', '3x2', '4x2']); });
  for (const n of [1, 2, 3, 4, 5, 6, 7]) it(`${n} players: one cell each, inside the screen, no overlap`, () => {
    const W = 1920, H = 1080, { cells, spare } = layoutCells(n, W, H, 4);
    expect(cells).toHaveLength(n);
    const all = [...cells, ...spare];
    for (const c of all) { expect(c.x).toBeGreaterThanOrEqual(0); expect(c.y).toBeGreaterThanOrEqual(0); expect(c.x + c.w).toBeLessThanOrEqual(W + 1e-6); expect(c.y + c.h).toBeLessThanOrEqual(H + 1e-6); }
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) { const a = all[i], b = all[j]; expect(a.x + a.w <= b.x + 1e-6 || b.x + b.w <= a.x + 1e-6 || a.y + a.h <= b.y + 1e-6 || b.y + b.h <= a.y + 1e-6).toBe(true); }
  });
  it('spare cells exist when the grid is larger than the player count (leaderboard slot)', () => { expect(layoutCells(7, 1920, 1080).spare).toHaveLength(1); expect(layoutCells(3, 1920, 1080).spare).toHaveLength(1); expect(layoutCells(4, 1920, 1080).spare).toHaveLength(0); });
  it('cells are never degenerate', () => { for (const n of [1, 2, 5, 7]) for (const c of layoutCells(n, 1280, 720).cells) { expect(c.w).toBeGreaterThan(100); expect(c.h).toBeGreaterThan(100); } });
});
