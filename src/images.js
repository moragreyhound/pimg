// Local image operations + pull/push orchestration — Phase 2.
// Images live as OCI layouts under <home>/images/<safe-name>/ with blobs
// shared in the content-addressed <home>/blobs/sha256/ store. state.json
// entries: { name, digest, os, arch }.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { digestOfBytes } from './digest.js';
import { loadLayout } from './oci.js';
import { Registry, parseRef, refToName } from './registry.js';
import { ProgressBar } from './output.js';

export const safeName = (name) => name.replace(/[^A-Za-z0-9_.-]/g, '_');

export function imageDir(store, name) {
  return path.join(store.images, safeName(name));
}

// Load a stored image's layout, resolving blobs from the shared
// content-addressed <home>/blobs pool (layouts only carry index.json).
export function loadStored(store, name) {
  const dir = imageDir(store, name);
  const loaded = loadLayout(dir, { blobRoot: store.blobs });
  return { dir, loaded };
}

export function readState(store) {
  try {
    const j = JSON.parse(fs.readFileSync(store.stateFile, 'utf8'));
    return Array.isArray(j?.images) ? j.images : [];
  } catch {
    return [];
  }
}

export function writeState(store, images) {
  fs.writeFileSync(store.stateFile, JSON.stringify({ version: 1, images }, null, 2));
}

export function upsertImage(store, entry) {
  const images = readState(store).filter((e) => e.name !== entry.name);
  images.push(entry);
  writeState(store, images);
}

export function removeImageEntry(store, name) {
  const images = readState(store);
  const found = images.find((e) => e.name === name);
  writeState(store, images.filter((e) => e.name !== name));
  return found ?? null;
}

// ---- pull ----

function registryAuth() {
  const u = process.env.PIMG_REGISTRY_USER;
  const p = process.env.PIMG_REGISTRY_PASS;
  return u ? { username: u, password: p ?? '' } : null;
}

// Pull ref into the store. Progress: one bar per layer + config, sequential.
// Returns the stored entry.
export async function pullImage(home, refStr, { platform = null, plainHttp = false } = {}) {
  const ref = parseRef(refStr);
  const store = Store.resolve(home);
  store.init();
  const reg = new Registry(ref.registry, { plainHttp, auth: registryAuth() });
  const { manifest, digest: manifestDigest } = await reg.resolveManifest(
    ref.repo, ref.digest || ref.tag, platform,
  );
  const layers = manifest.layers ?? [];
  const config = manifest.config;
  if (!config?.digest) throw new Error('manifest missing config descriptor');
  const blobs = [config, ...layers];
  const jobs = blobs.map((b) => ({ digest: b.digest, size: b.size ?? 0 }));

  let grand = 0;
  const perDigestDone = new Map();
  const bar = new ProgressBar(`pull ${refToName(ref)}`, jobs.reduce((a, j) => a + j.size, 0));
  const onProgress = ({ digest, done }) => {
    const prev = perDigestDone.get(digest) ?? 0;
    grand += done - prev;
    perDigestDone.set(digest, done);
    bar.update(grand);
  };

  for (const j of jobs) {
    const dest = path.join(store.blobs, 'sha256', j.digest.slice(7));
    let need = true;
    try {
      const st = fs.statSync(dest);
      if (st.size === j.size || j.size === 0) need = false;
    } catch { /* download */ }
    if (need) {
      await reg.downloadBlob(ref.repo, j.digest, dest, onProgress);
    } else {
      onProgress({ digest: j.digest, done: j.size });
    }
  }
  bar.finish();

  const name = refToName(ref);
  const dir = imageDir(store, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'oci-layout'), '{"imageLayoutVersion":"1.0.0"}');
  const indexManifest = {
    mediaType: manifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json',
    digest: manifestDigest || digestOfBytes(JSON.stringify(manifest)),
    size: -1,
    platform: manifestPlatform(manifest),
  };
  const blobHex = (indexManifest.digest).slice(7);
  fs.writeFileSync(path.join(store.blobs, 'sha256', blobHex), JSON.stringify(manifest));
  fs.writeFileSync(
    path.join(dir, 'index.json'),
    JSON.stringify({ schemaVersion: 2, manifests: [indexManifest] }, null, 2),
  );
  const entry = {
    name,
    digest: indexManifest.digest,
    os: indexManifest.platform?.os ?? '',
    arch: indexManifest.platform?.architecture ?? '',
    registry: ref.registry,
    repo: ref.repo,
    tag: ref.tag,
  };
  upsertImage(store, entry);
  return entry;
}

function manifestPlatform(manifest) {
  const c = manifest.config ?? {};
  if (c.platform) return c.platform;
  return undefined;
}

// ---- push ----

export async function pushImage(home, name, { plainHttp = false } = {}) {
  const store = Store.resolve(home);
  const { loaded } = loadStored(store, name);
  if (!loaded.ok) throw new Error(loaded.err);
  const entry = readState(store).find((e) => e.name === name);
  // Push back to the registry the image came from (recorded at pull time);
  // a bare name defaults to Docker Hub like pull does.
  const parsed = parseRef(name.includes('/') || name.includes(':') ? name : name);
  const registry = entry?.registry ?? parsed.registry;
  const repo = entry?.repo ?? parsed.repo;
  const tag = entry?.tag || parsed.tag || 'latest';
  const reg = new Registry(registry, { plainHttp, auth: registryAuth() });
  const man = loaded.manifests[0];
  const cfgText = fs.readFileSync(path.join(store.blobs, 'sha256', man.config.digest.slice(7)));
  void cfgText;
  const blobs = [man.config, ...man.layers];
  const bar = new ProgressBar(`push ${name}`, blobs.length);
  let n = 0;
  for (const b of blobs) {
    const file = path.join(store.blobs, 'sha256', b.digest.slice(7));
    await reg.uploadBlob(repo, file, b.digest);
    bar.update(++n);
  }
  bar.finish();
  const manifestText = fs.readFileSync(path.join(store.blobs, 'sha256', man.digest.slice(7)), 'utf8');
  const pushed = await reg.putManifest(repo, tag, JSON.parse(manifestText));
  void entry;
  return pushed;
}

// ---- tag / rmi / prune / history ----

export function tagImage(home, src, dst) {
  const store = Store.resolve(home);
  const images = readState(store);
  const found = images.find((e) => e.name === src);
  if (!found) throw new Error(`no such image '${src}'`);
  const srcDir = imageDir(store, src);
  const dstDir = imageDir(store, dst);
  if (srcDir !== dstDir) {
    fs.mkdirSync(dstDir, { recursive: true });
    for (const f of ['oci-layout', 'index.json']) {
      fs.copyFileSync(path.join(srcDir, f), path.join(dstDir, f));
    }
  }
  upsertImage(store, { ...found, name: dst });
  return dst;
}

export function removeImage(home, name) {
  const store = Store.resolve(home);
  const found = removeImageEntry(store, name);
  if (!found) throw new Error(`no such image '${name}'`);
  fs.rmSync(imageDir(store, name), { recursive: true, force: true });
  return found;
}

// Remove unreferenced blobs. Returns { blobs, bytes } reclaimed.
export function pruneStore(home) {
  const store = Store.resolve(home);
  store.init();
  const referenced = new Set();
  for (const e of readState(store)) {
    const { loaded } = loadStored(store, e.name);
    if (!loaded.ok) continue;
    for (const m of loaded.manifests) {
      referenced.add(m.digest.slice(7));
      referenced.add(m.config.digest.slice(7));
      for (const l of m.layers) referenced.add(l.digest.slice(7));
      referenced.add(e.digest.slice(7));
    }
  }
  let blobs = 0;
  let bytes = 0;
  const blobDir = path.join(store.blobs, 'sha256');
  let files = [];
  try {
    files = fs.readdirSync(blobDir);
  } catch {
    return { blobs: 0, bytes: 0 };
  }
  for (const f of files) {
    if (referenced.has(f)) continue;
    try {
      bytes += fs.statSync(path.join(blobDir, f)).size;
      fs.rmSync(path.join(blobDir, f));
      blobs++;
    } catch { /* raced */ }
  }
  return { blobs, bytes };
}

// Layer history for an image entry: [{ digest, size, platform }].
export function imageHistory(home, name) {
  const store = Store.resolve(home);
  const { loaded } = loadStored(store, name);
  if (!loaded.ok) throw new Error(loaded.err);
  const out = [];
  for (const m of loaded.manifests) {
    out.push({ kind: 'config', digest: m.config.digest, size: m.config.size });
    for (const l of m.layers) out.push({ kind: 'layer', digest: l.digest, size: l.size });
  }
  return out;
}

// ---- save / load (tar of the OCI layout, streaming, with progress) ----

const BLOCK = 512;

function tarHeader(name, size) {
  const h = Buffer.alloc(BLOCK, 0);
  h.write(name.slice(0, 100), 0, 'utf8');
  h.write('0000777\0', 100);
  h.write('0000000\0', 108);
  h.write('0000000\0', 116);
  h.write(size.toString(8).padStart(11, '0') + '\0', 124);
  h.write('00000000000\0', 136);
  h.write('0', 156);
  h.write('ustar\0', 257);
  h.write('00', 263);
  let sum = 0;
  h.write('        ', 148);
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148);
  return h;
}

function collectFiles(dir, base = '') {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...collectFiles(full, rel));
    else if (e.isFile()) out.push({ full, rel, size: fs.statSync(full).size });
  }
  return out;
}

export function saveImage(home, name, destTar) {
  const store = Store.resolve(home);
  const { dir, loaded } = loadStored(store, name);
  if (!loaded.ok) throw new Error(`no such image '${name}'`);
  const files = collectFiles(dir);
  // Blobs live in the shared pool — pack every referenced one so the tar is
  // self-contained and loadImage can verify it standalone.
  const digests = new Set();
  for (const m of loaded.manifests) {
    digests.add(m.digest);
    digests.add(m.config.digest);
    for (const l of m.layers) digests.add(l.digest);
  }
  for (const d of digests) {
    const full = path.join(store.blobs, 'sha256', d.slice(7));
    try {
      files.push({ full, rel: `blobs/sha256/${d.slice(7)}`, size: fs.statSync(full).size });
    } catch {
      throw new Error(`missing blob for '${name}': ${d}`);
    }
  }
  const total = files.reduce((a, f) => a + f.size, 0);
  const bar = new ProgressBar(`save ${name}`, total);
  const out = fs.createWriteStream(destTar);
  let done = 0;
  for (const f of files) {
    out.write(tarHeader(f.rel, f.size));
    const data = fs.readFileSync(f.full);
    out.write(data);
    const pad = (BLOCK - (f.size % BLOCK)) % BLOCK;
    if (pad) out.write(Buffer.alloc(pad, 0));
    done += f.size;
    bar.update(done);
  }
  out.write(Buffer.alloc(BLOCK * 2, 0));
  return new Promise((resolve, reject) => {
    out.end((err) => (err ? reject(err) : (bar.finish(), resolve({ files: files.length, bytes: total }))));
  });
}

function readTarNames(buf) {
  // Returns entry names (used by load to validate + list).
  const names = [];
  let off = 0;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
    names.push(rawName);
    off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return names;
}

export async function loadImage(home, srcTar, { onProgress = null } = {}) {
  const buf = fs.readFileSync(srcTar);
  const store = Store.resolve(home);
  store.init();
  // Extract into a staging dir, guarding traversal (Phase-2 invariant).
  const stage = path.join(store.images, `.load-${process.pid}-${Date.now()}`);
  fs.mkdirSync(stage, { recursive: true });
  let off = 0;
  let bytes = 0;
  try {
    while (off + BLOCK <= buf.length) {
      const h = buf.subarray(off, off + BLOCK);
      if (h.every((b) => b === 0)) break;
      const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
      const size = parseInt(h.subarray(124, 136).toString('utf8').replace(/\0.*$/, '').trim() || '0', 8);
      if (!rawName || rawName.includes('..') || path.isAbsolute(rawName)) {
        throw new Error(`tar entry refused: '${rawName}'`);
      }
      const dest = path.join(stage, rawName);
      if (!dest.startsWith(stage)) throw new Error(`tar escape refused: '${rawName}'`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf.subarray(off + BLOCK, off + BLOCK + size));
      bytes += size;
      onProgress?.({ done: bytes, total: buf.length });
      off += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
    }
  } catch (e) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw e;
  }
  const loaded = loadLayout(stage);
  if (!loaded.ok) {
    fs.rmSync(stage, { recursive: true, force: true });
    throw new Error(`not a pimg image tar: ${loaded.err}`);
  }
  // Move blobs into the shared store, layout into images/<digest>.
  for (const m of loaded.manifests) {
    const digests = [m.digest, m.config.digest, ...m.layers.map((l) => l.digest)];
    for (const d of digests) {
      const hx = d.slice(7);
      const src = path.join(stage, 'blobs', 'sha256', hx);
      const dst = path.join(store.blobs, 'sha256', hx);
      if (fs.existsSync(src) && !fs.existsSync(dst)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.renameSync(src, dst);
      }
    }
  }
  const name = `loaded:${loaded.manifests[0].digest.slice(7, 19)}`;
  const dir = imageDir(store, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  fs.renameSync(stage, dir);
  const hash = createHash('sha256').update(buf).digest('hex');
  void hash;
  const entry = { name, digest: loaded.manifests[0].digest, os: '', arch: '' };
  upsertImage(store, entry);
  return { ...entry, names: readTarNames(buf) };
}
