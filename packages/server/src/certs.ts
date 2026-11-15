import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import selfsigned from 'selfsigned';

/**
 * Phones only expose accelerometer/gyroscope on secure origins (HTTPS). On a home LAN there is no public CA for
 * 192.168.x.y, so we mint a self-signed certificate that lists localhost and every LAN address. The browser shows a
 * one-time warning ("connection not private") that the player accepts. Cached per address set in `.cert/`.
 */
export function ensureCert(ips: string[], dir = join(process.cwd(), '.cert')): { key: string; cert: string } {
  const names = ['localhost', ...ips].sort();
  const id = createHash('sha1').update(names.join(',')).digest('hex').slice(0, 10);
  const keyF = join(dir, `key-${id}.pem`), certF = join(dir, `cert-${id}.pem`);
  if (existsSync(keyF) && existsSync(certF)) return { key: readFileSync(keyF, 'utf8'), cert: readFileSync(certF, 'utf8') };
  const alt = [{ type: 2, value: 'localhost' }, { type: 7, ip: '127.0.0.1' }, ...ips.map((ip) => ({ type: 7, ip }))];
  const p = selfsigned.generate([{ name: 'commonName', value: 'Cryovanta local game' }], { days: 825, keySize: 2048, algorithm: 'sha256', extensions: [{ name: 'subjectAltName', altNames: alt }] });
  try { mkdirSync(dir, { recursive: true }); writeFileSync(keyF, p.private); writeFileSync(certF, p.cert); } catch { /* read-only dir: still usable in memory */ }
  return { key: p.private, cert: p.cert };
}
