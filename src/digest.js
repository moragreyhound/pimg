// Digest helpers — port of src/digest.cpp + src/sha256.cpp.
// Optimized: node:crypto (native, streaming for files) replaces vendored SHA256.
import { createHash } from 'node:crypto';
import fs from 'node:fs';

const HEX64 = /^[0-9a-fA-F]{64}$/;

export function parseDigest(s) {
  const pos = s.indexOf(':');
  if (pos === -1) return { ok: false, algo: '', hex: '', err: `invalid digest '${s}': expected '<algo>:<hex>'` };
  const algo = s.slice(0, pos);
  const hx = s.slice(pos + 1);
  if (algo !== 'sha256') return { ok: false, algo: '', hex: '', err: `unsupported algorithm '${algo}': only sha256 is supported` };
  if (!HEX64.test(hx)) return { ok: false, algo: '', hex: '', err: `invalid hex in digest '${s}'` };
  return { ok: true, algo, hex: hx.toLowerCase(), err: '' };
}

export function isValidDigest(s) {
  return parseDigest(s).ok;
}

export function digestOfBytes(data) {
  const h = createHash('sha256').update(data).digest('hex');
  return `sha256:${h}`;
}

// Sync streaming hash — constant memory even for multi-GB layers.
export function digestOfFile(p) {
  try {
    const hash = createHash('sha256');
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.allocUnsafe(64 * 1024);
      let n;
      // eslint-disable-next-line no-cond-assign
      while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) {
        hash.update(buf.subarray(0, n));
      }
    } finally {
      fs.closeSync(fd);
    }
    return { ok: true, digest: `sha256:${hash.digest('hex')}`, err: '' };
  } catch {
    return { ok: false, digest: '', err: `cannot read file '${p}'` };
  }
}

export function verifyBytes(data, expected) {
  const p = parseDigest(expected);
  if (!p.ok) return { ok: false, err: p.err };
  const actual = createHash('sha256').update(data).digest('hex');
  if (actual !== p.hex) {
    return { ok: false, err: `digest mismatch: expected sha256:${p.hex}, got sha256:${actual}` };
  }
  return { ok: true, err: '' };
}

export function verifyFile(p, expected) {
  const d = digestOfFile(p);
  if (!d.ok) return { ok: false, err: d.err };
  const e = parseDigest(expected);
  if (!e.ok) return { ok: false, err: e.err };
  const actualHex = d.digest.slice(7);
  if (actualHex !== e.hex) {
    return { ok: false, err: `digest mismatch: expected ${expected}, got ${d.digest}` };
  }
  return { ok: true, err: '' };
}
