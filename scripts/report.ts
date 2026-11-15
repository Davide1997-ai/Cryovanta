/**
 * Summarises real matches logged by the server (.data/matches.jsonl) so you can balance with data after a playtest.
 *   npm run report [-- path/to/matches.jsonl]
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const file = process.argv[2] ?? join(process.cwd(), '.data', 'matches.jsonl');
if (!existsSync(file)) { console.log(`Nessun dato in ${file}.\nGioca qualche partita con il server acceso (start-game.bat): ogni partita finita viene registrata qui.`); process.exit(0); }
const rows = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
if (!rows.length) { console.log('File vuoto.'); process.exit(0); }

const by = new Map<string, any[]>(); for (const r of rows) (by.get(r.mode) ?? by.set(r.mode, []).get(r.mode)!).push(r);
const avg = (a: number[]) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length));
console.log(`\nREPORT PARTITE REALI — ${rows.length} partite, ${new Set(rows.flatMap((r) => r.standings)).size} slot diversi\n`);
for (const [mode, rs] of by) {
  const rounds = rs.flatMap((r) => r.rounds), timeouts = rounds.filter((x: any) => x.reason === 'timeout').length;
  const sum = (k: string) => rs.reduce((a, r) => a + (r.stats[k] ?? 0), 0);
  const outs: Record<string, number> = {}; for (const r of rs) for (const [k, v] of Object.entries(r.stats.outs ?? {})) outs[k] = (outs[k] ?? 0) + (v as number);
  console.log(`▶ ${mode}: ${rs.length} partite · giocatori medi ${avg(rs.map((r) => r.players)).toFixed(1)} · durata media ${avg(rs.map((r) => r.seconds)).toFixed(0)}s`);
  console.log(`   round ${rounds.length} (durata media ${avg(rounds.map((x: any) => x.seconds)).toFixed(0)}s, ${rounds.length ? ((timeouts / rounds.length) * 100).toFixed(0) : 0}% finiti a tempo)`);
  console.log(`   per partita: spinte ${(sum('shoves') / rs.length).toFixed(1)} · urti ${(sum('bumps') / rs.length).toFixed(1)} · prese ${(sum('grabs') / rs.length).toFixed(1)} · lanci ${(sum('throws') / rs.length).toFixed(1)} · emote ${(sum('emotes') / rs.length).toFixed(1)} · prese di corona ${(sum('crownTakes') / rs.length).toFixed(1)}`);
  const total = Object.values(outs).reduce((a, b) => a + b, 0);
  if (total) console.log(`   eliminazioni per causa: ${Object.entries(outs).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(' · ')}`);
  const hints: string[] = [];
  if (rounds.length && timeouts / rounds.length > 0.3) hints.push('molti round finiscono a tempo: abbassa la durata o rendi più difficile non finire');
  if (total && (outs['fall'] ?? 0) / total > 0.7) hints.push('quasi tutti cadono da soli: spinte e prese contano poco (aumenta il knockback o i bordi pericolosi)');
  if (total && ((outs['shove'] ?? 0) + (outs['throw'] ?? 0)) / total > 0.7) hints.push('quasi solo spinte: forse troppo potenti (accorcia il knockback o allunga il cooldown)');
  if (avg(rs.map((r) => r.seconds)) < 30) hints.push('partite molto brevi');
  for (const h of hints) console.log(`   ⚠️  ${h}`);
  console.log('');
}
