// Store layout — port of src/store.cpp.
// Optimized: path/os/fs builtins only, mkdir recursive instead of manual
// component walk, tolerant state.json read (JSON.parse + regex fallback).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function joinPath(a, b) {
  if (!a) return b;
  return path.join(a, b);
}

export function defaultHome() {
  if (process.env.PIMG_HOME) return process.env.PIMG_HOME;
  if (process.platform === 'win32') {
    if (process.env.LOCALAPPDATA) return path.join(process.env.LOCALAPPDATA, 'pimg');
    if (process.env.USERPROFILE) return path.join(process.env.USERPROFILE, '.pimg');
    return '.pimg';
  }
  if (process.env.HOME) return path.join(process.env.HOME, '.pimg');
  return '.pimg';
}

export class Store {
  constructor(home, blobs, images, containers, volumes, networks, stateFile) {
    this.home = home;
    this.blobs = blobs;
    this.images = images;
    this.containers = containers;
    this.volumes = volumes;
    this.networks = networks;
    this.stateFile = stateFile;
  }

  static resolve(overrideHome = '') {
    const home = overrideHome || defaultHome();
    return new Store(
      home,
      path.join(home, 'blobs'),
      path.join(home, 'images'),
      path.join(home, 'containers'),
      path.join(home, 'volumes'),
      path.join(home, 'networks'),
      path.join(home, 'state.json'),
    );
  }

  init() {
    try {
      for (const d of [this.blobs, this.images, this.containers, this.volumes, this.networks]) {
        fs.mkdirSync(d, { recursive: true });
      }
      if (!fs.existsSync(this.stateFile)) {
        fs.writeFileSync(this.stateFile, '{"version":1,"images":[]}');
      }
      return { ok: true, err: '' };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e) };
    }
  }

  writable() {
    try {
      const probe = path.join(this.home, '.writetest');
      fs.writeFileSync(probe, 'ok');
      fs.rmSync(probe, { force: true });
      return { ok: true, err: '' };
    } catch (e) {
      return { ok: false, err: String(e?.message ?? e) };
    }
  }
}

export function fileExists(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

export function dirExists(p) {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function readFile(p) {
  try {
    return { ok: true, text: fs.readFileSync(p, 'utf8'), err: '' };
  } catch (e) {
    return { ok: false, text: '', err: `cannot open '${p}'` };
  }
}

// List images from state.json. Missing file => empty list (not an error),
// corrupt JSON => tolerant "name"/"digest" regex scan like the C++ build.
export function listImages(store) {
  let text;
  try {
    text = fs.readFileSync(store.stateFile, 'utf8');
  } catch {
    return { ok: true, images: [], err: '' };
  }
  try {
    const j = JSON.parse(text);
    const arr = Array.isArray(j?.images) ? j.images : [];
    return {
      ok: true,
      images: arr.map((e) => ({
        name: String(e?.name ?? ''),
        digest: String(e?.digest ?? ''),
        os: String(e?.os ?? ''),
        arch: String(e?.arch ?? ''),
      })),
      err: '',
    };
  } catch {
    const out = [];
    let pos = 0;
    while (true) {
      pos = text.indexOf('"name"', pos);
      if (pos === -1) break;
      const c = text.indexOf(':', pos);
      if (c === -1) break;
      const q1 = text.indexOf('"', c);
      if (q1 === -1) break;
      const q2 = text.indexOf('"', q1 + 1);
      if (q2 === -1) break;
      const name = text.slice(q1 + 1, q2);
      let digest = '';
      const dd = text.indexOf('"digest"', q2);
      if (dd !== -1 && dd < q2 + 400) {
        const dc = text.indexOf(':', dd);
        const dq1 = dc === -1 ? -1 : text.indexOf('"', dc);
        const dq2 = dq1 === -1 ? -1 : text.indexOf('"', dq1 + 1);
        if (dq1 !== -1 && dq2 !== -1) digest = text.slice(dq1 + 1, dq2);
      }
      out.push({ name, digest });
      pos = q2 + 1;
    }
    return { ok: true, images: out, err: '' };
  }
}

export { os };
