export interface Rect { x: number; y: number; w: number; h: number } // top-left origin, CSS pixels

/**
 * Split-screen grid: one cell per player, plus (when the grid has spare cells) room for the leaderboard.
 *   1 → 1×1 · 2 → 2×1 · 3-4 → 2×2 · 5-6 → 3×2 · 7-8 → 4×2
 */
export function gridFor(n: number): { cols: number; rows: number } {
  if (n <= 1) return { cols: 1, rows: 1 };
  if (n === 2) return { cols: 2, rows: 1 };
  if (n <= 4) return { cols: 2, rows: 2 };
  if (n <= 6) return { cols: 3, rows: 2 };
  return { cols: 4, rows: 2 };
}

export function layoutCells(n: number, width: number, height: number, gap = 4): { cells: Rect[]; spare: Rect[] } {
  const { cols, rows } = gridFor(n);
  const cw = (width - gap * (cols - 1)) / cols, ch = (height - gap * (rows - 1)) / rows, all: Rect[] = [];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) all.push({ x: c * (cw + gap), y: r * (ch + gap), w: cw, h: ch });
  return { cells: all.slice(0, n), spare: all.slice(n) };
}
