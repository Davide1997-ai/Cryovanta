export type ModeKind = 'elimination' | 'race' | 'grandprix' | 'survival';
export interface ModeDef { id: string; name: string; desc: string; kind: ModeKind; boxRespawn: number; }

/** Predisposed game modes. A mode is data: Match interprets `kind`, the sim reads `boxRespawn`. */
export const MODES: Record<string, ModeDef> = {
  elimination: { id: 'elimination', name: 'Eliminazione', desc: 'Passa solo la metà più veloce. Ultimo robot in piedi vince.', kind: 'elimination', boxRespawn: 4 },
  race: { id: 'race', name: 'Corsa singola', desc: 'Un solo round: vince chi arriva per primo, nessuna eliminazione.', kind: 'race', boxRespawn: 4 },
  grandprix: { id: 'grandprix', name: 'Gran Premio', desc: '3 round, punti per ogni arrivo (10-8-6-5-4-3-2). Vince chi ha più punti.', kind: 'grandprix', boxRespawn: 4 },
  arena: { id: 'arena', name: 'Arena (ultimo in piedi)', desc: 'Niente traguardo: le tessere crollano, spingi e afferra gli altri per farli cadere. Vince l\'ultimo.', kind: 'survival', boxRespawn: 3 },
  chaos: { id: 'chaos', name: 'Caos', desc: 'Eliminazione con casse oggetto che ricompaiono quasi subito.', kind: 'elimination', boxRespawn: 1.2 },
};
export const MODE_IDS = Object.keys(MODES);
export const POINTS = [10, 8, 6, 5, 4, 3, 2];
