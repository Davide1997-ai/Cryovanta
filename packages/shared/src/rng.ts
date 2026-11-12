/** mulberry32 – tiny deterministic PRNG. State is a single uint32 so it can live inside the sim state. */
export function nextRand(state: { rng: number }): number {
  state.rng = (state.rng + 0x6d2b79f5) >>> 0;
  let t = state.rng;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
export function rangeRand(s: { rng: number }, a: number, b: number): number {
  return a + (b - a) * nextRand(s);
}
