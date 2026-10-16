// OCI layout loader — port of src/oci.cpp.
// Verifies every referenced blob; rejects traversal via strict hex check.
import fs from 'node:fs';
import path from 'node:path';
import { parseDigest, verifyFile } from './digest.js';

function loadDescriptor(j) {
  const mediaType = typeof j?.mediaType === 'string' ? j.mediaType : '';
  const digest = typeof j?.digest === 'string' ? j.digest : '';
  if (!digest) return { ok: false, err: 'descriptor missing digest' };
  const p = parseDigest(digest);
  if (!p.ok) return { ok: false, err: p.err };
  const d = { mediaType, digest, size: -1, platformOs: '', platformArch: '' };
  if (typeof j?.size === 'number') d.size = j.size;
  if (j?.platform && typeof j.platform === 'object') {
    if (typeof j.platform.os === 'string') d.platformOs = j.platform.os;
    if (typeof j.platform.architecture === 'string') d.platformArch = j.platform.architecture;
  }
  return { ok: true, desc: d, err: '' };
}

export function verifyBlob(layoutDir, digest, fallbackBlobRoot = '') {
  const p = parseDigest(digest);
  if (!p.ok) return { ok: false, err: p.err };
  if (p.hex.includes('/') || p.hex.includes('\\')) {
    return { ok: false, err: 'refusing blob path with separator' };
  }
  const blob = path.join(layoutDir, 'blobs', 'sha256', p.hex);
  const v = verifyFile(blob, digest);
  // Stored images share the content-addressed <home>/blobs pool instead of
  // duplicating bytes per layout dir — fall back to it when provided.
  if (!v.ok && fallbackBlobRoot) {
    return verifyFile(path.join(fallbackBlobRoot, 'sha256', p.hex), digest);
  }
  return v;
}

function readBlobText(layoutDir, digest, fallbackBlobRoot) {
  const p = parseDigest(digest);
  const primary = path.join(layoutDir, 'blobs', 'sha256', p.hex);
  try {
    return { ok: true, text: fs.readFileSync(primary, 'utf8'), err: '' };
  } catch {
    if (fallbackBlobRoot) {
      const fb = path.join(fallbackBlobRoot, 'sha256', p.hex);
      try {
        return { ok: true, text: fs.readFileSync(fb, 'utf8'), err: '' };
      } catch {
        return { ok: false, text: '', err: `cannot open '${fb}'` };
      }
    }
    return { ok: false, text: '', err: `cannot open '${primary}'` };
  }
}

export function loadLayout(dir, { blobRoot = '' } = {}) {
  let layoutText;
  try {
    layoutText = fs.readFileSync(path.join(dir, 'oci-layout'), 'utf8');
  } catch (e) {
    return { ok: false, err: `not an OCI layout: cannot open '${path.join(dir, 'oci-layout')}'` };
  }
  let layout;
  try {
    layout = JSON.parse(layoutText);
  } catch (e) {
    return { ok: false, err: `bad oci-layout: ${e.message}` };
  }
  if (layout?.imageLayoutVersion !== '1.0.0') {
    return { ok: false, err: 'unsupported imageLayoutVersion (want 1.0.0)' };
  }
  let indexText;
  try {
    indexText = fs.readFileSync(path.join(dir, 'index.json'), 'utf8');
  } catch {
    return { ok: false, err: `cannot open '${path.join(dir, 'index.json')}'` };
  }
  let idx;
  try {
    idx = JSON.parse(indexText);
  } catch (e) {
    return { ok: false, err: `bad index.json: ${e.message}` };
  }
  if (!Array.isArray(idx?.manifests)) return { ok: false, err: 'index.json missing manifests[]' };

  const index = { manifests: [] };
  for (const m of idx.manifests) {
    const r = loadDescriptor(m);
    if (!r.ok) return { ok: false, err: r.err };
    index.manifests.push(r.desc);
  }

  const manifests = [];
  for (const d of index.manifests) {
    const v = verifyBlob(dir, d.digest, blobRoot);
    if (!v.ok) return { ok: false, err: v.err };
    const t = readBlobText(dir, d.digest, blobRoot);
    if (!t.ok) return { ok: false, err: t.err };
    const text = t.text;
    let mj;
    try {
      mj = JSON.parse(text);
    } catch (e) {
      return { ok: false, err: `bad manifest blob: ${e.message}` };
    }
    const man = { digest: d.digest, mediaType: mj?.mediaType ?? '', config: null, layers: [] };
    if (!mj?.config || typeof mj.config !== 'object') return { ok: false, err: 'manifest missing config' };
    const cfg = loadDescriptor(mj.config);
    if (!cfg.ok) return { ok: false, err: cfg.err };
    man.config = cfg.desc;
    const cv = verifyBlob(dir, man.config.digest, blobRoot);
    if (!cv.ok) return { ok: false, err: `config blob: ${cv.err}` };
    if (!Array.isArray(mj?.layers)) return { ok: false, err: 'manifest missing layers[]' };
    for (const l of mj.layers) {
      const ld = loadDescriptor(l);
      if (!ld.ok) return { ok: false, err: ld.err };
      const lv = verifyBlob(dir, ld.desc.digest, blobRoot);
      if (!lv.ok) return { ok: false, err: `layer blob: ${lv.err}` };
      man.layers.push(ld.desc);
    }
    manifests.push(man);
  }
  return { ok: true, index, manifests, err: '' };
}
