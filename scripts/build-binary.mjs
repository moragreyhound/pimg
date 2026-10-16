// Build a standalone pimg binary via Node.js Single Executable Applications.
// Steps: esbuild bundle -> sea blob -> copy node binary -> postject inject.
// Usage: npm run build:binary  (output: dist/pimg.exe on Windows, dist/pimg elsewhere)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const dist = path.join(root, 'dist');
const isWin = process.platform === 'win32';
const outBin = path.join(dist, isWin ? 'pimg.exe' : 'pimg');
const blob = path.join(dist, 'sea-prep.blob');
const seaConfig = path.join(dist, 'sea-config.json');

fs.mkdirSync(dist, { recursive: true });

// 1. Bundle (ESM: ink/yoga use top-level await, which CJS cannot hold).
console.log('> esbuild bundle...');
const bundle = path.join(dist, 'sea-main.mjs');
execFileSync(
  process.execPath,
  [
    path.join(root, 'node_modules', 'esbuild', 'bin', 'esbuild'),
    path.join(root, 'bin', 'pimg.js'),
    '--bundle',
    '--platform=node',
    '--format=esm',
    `--outfile=${bundle}`,
    '--alias:react-devtools-core=./scripts/devtools-stub.js',
    '--log-level=warning',
  ],
  { stdio: 'inherit' },
);

// 2. Generate the SEA blob (CJS entry + ESM app bundle as an asset).
console.log('> sea blob...');
fs.copyFileSync(path.join(root, 'scripts', 'sea-entry.cjs'), path.join(dist, 'sea-entry.cjs'));
fs.writeFileSync(
  seaConfig,
  JSON.stringify({
    main: path.join(dist, 'sea-entry.cjs'),
    output: blob,
    disableExperimentalSEAWarning: true,
    assets: { 'app.mjs': bundle },
  }),
);
execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' });

// 3. Copy the host node binary and inject the blob with postject.
console.log('> inject blob...');
fs.copyFileSync(process.execPath, outBin);
// The SEA fuse suffix varies across Node releases — read it from the host
// binary instead of hardcoding it.
const hostBin = fs.readFileSync(process.execPath, 'utf8');
const fuse = /NODE_SEA_FUSE_[0-9a-f]{32}/.exec(hostBin)?.[0]
  ?? 'NODE_SEA_FUSE_fce680ab2cc467b6e84043b1a903c4d';
const { inject } = await import('postject');
await inject(outBin, 'NODE_SEA_BLOB', fs.readFileSync(blob), { sentinelFuse: fuse });

try {
  fs.chmodSync(outBin, 0o755);
} catch { /* windows */ }

const size = (fs.statSync(outBin).size / 1024 / 1024).toFixed(1);
console.log(`ok: ${outBin} (${size} MB)`);
