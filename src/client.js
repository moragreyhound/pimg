// Remote client — talks to `pimg serve`.
// Server selection: --server flag > PIMG_SERVER env > ~/.pimg/config.json.
// Token: --token flag > PIMG_TOKEN env > config.json.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';

export function configFile(home) {
  return path.join(Store.resolve(home).home, 'config.json');
}

export function loadConfig(home) {
  try {
    const j = JSON.parse(fs.readFileSync(configFile(home), 'utf8'));
    return { server: '', token: '', ...j };
  } catch {
    return { server: '', token: '' };
  }
}

export function saveConfig(home, cfg) {
  const store = Store.resolve(home);
  store.init();
  fs.writeFileSync(configFile(home), JSON.stringify(cfg, null, 2));
}

export function resolveServer(home, flags) {
  const server = flags.get('server') ?? process.env.PIMG_SERVER ?? loadConfig(home).server ?? '';
  const token = flags.get('token') ?? process.env.PIMG_TOKEN ?? loadConfig(home).token ?? '';
  return { server: server.replace(/\/$/, ''), token };
}

export async function api(server, token, method, p, body = undefined) {
  const res = await fetch(`${server}${p}`, {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch { /* plain-text error */ }
  if (!res.ok) {
    const msg = data?.error ?? `HTTP ${res.status}`;
    const e = new Error(msg);
    e.status = res.status;
    throw e;
  }
  return data;
}
