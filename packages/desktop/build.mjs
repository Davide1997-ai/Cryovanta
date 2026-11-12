import { build } from 'esbuild';
await build({ entryPoints: ['src/main.ts'], outfile: 'dist/main.cjs', bundle: true, platform: 'node', format: 'cjs', target: 'node20', external: ['electron'], sourcemap: false, logLevel: 'info' });
