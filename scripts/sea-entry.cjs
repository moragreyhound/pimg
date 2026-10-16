// SEA entry (CJS): loads the bundled ESM app from the embedded asset.
// Node's single-executable runtime evaluates `main` as CommonJS, while
// ink/yoga need ESM (top-level await) — so the real bundle ships as an
// asset, is written once to a content-hashed temp file, and imported from
// there (the ESM loader accepts file: URLs).
'use strict';

const { getAsset, isSea } = require('node:sea');

if (!isSea()) {
  console.error('sea-entry.cjs must run inside the compiled pimg binary.');
  process.exit(1);
}

(async () => {
  if (process.env.PIMG_DEBUG_SEA) {
    process.stderr.write(`SEA argv: ${JSON.stringify(process.argv)}\n`);
  }
  const src = getAsset('app.mjs', 'utf8');
  const crypto = require('node:crypto');
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const hash = crypto.createHash('sha256').update(src).digest('hex').slice(0, 16);
  const file = path.join(os.tmpdir(), `pimg-app-${hash}.mjs`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, src);
  await import(require('node:url').pathToFileURL(file).href);
})().catch((e) => {
  console.error(e && e.message ? e.message : e);
  process.exit(1);
});
