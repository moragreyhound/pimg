// Net tools — Phase 4 (lite, no raw sockets).
// All probes use TCP/UDP/DNS at user level and degrade with plain errors,
// matching the doctor `raw-sockets` note: pimg falls back to TCP/UDP probes.
import dns from 'node:dns/promises';
import net from 'node:net';
import { performance } from 'node:perf_hooks';

// TCP connect timing. Resolves { host, port, ok, ms, error }.
export function pingTcp(host, port = 80, { timeout = 3000 } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const sock = net.connect({ host, port, timeout }, () => {
      const ms = performance.now() - t0;
      sock.destroy();
      resolve({ host, port, ok: true, ms: Math.round(ms * 10) / 10, error: '' });
    });
    sock.on('timeout', () => {
      sock.destroy();
      resolve({ host, port, ok: false, ms: -1, error: `timed out after ${timeout}ms` });
    });
    sock.on('error', (e) => {
      resolve({ host, port, ok: false, ms: -1, error: e.message });
    });
  });
}

export async function dnsLookup(name) {
  const t0 = performance.now();
  try {
    const addrs = await dns.lookup(name, { all: true });
    return { name, ok: true, ms: Math.round((performance.now() - t0) * 10) / 10, addresses: addrs, error: '' };
  } catch (e) {
    return { name, ok: false, ms: -1, addresses: [], error: e.message };
  }
}

// Minimal HTTP probe via global fetch: status + bytes + timing.
export async function httpProbe(url, { timeout = 8000 } = {}) {
  const t0 = performance.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const res = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
    const buf = Buffer.from(await res.arrayBuffer());
    clearTimeout(t);
    return {
      url,
      ok: res.ok,
      status: res.status,
      bytes: buf.length,
      ms: Math.round((performance.now() - t0) * 10) / 10,
      error: '',
    };
  } catch (e) {
    return { url, ok: false, status: -1, bytes: 0, ms: -1, error: e.name === 'AbortError' ? `timed out after ${timeout}ms` : e.message };
  }
}

// TCP port scan over a small explicit list (no SYN/raw sockets).
export async function scanPorts(host, ports, { timeout = 1000 } = {}) {
  const out = [];
  for (const port of ports) {
    // eslint-disable-next-line no-await-in-loop
    const r = await pingTcp(host, port, { timeout });
    out.push({ port, open: r.ok, ms: r.ms });
  }
  return out;
}
