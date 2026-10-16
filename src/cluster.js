// Single-node cluster — Phase 6 (lite, file-backed).
// State lives in <home>/cluster.json (no etcd): nodes, deployments with
// desired replicas mapped onto emulated-runtime containers, and a tiny
// manifest apply path for `pimg apply -f app.json`.
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';
import { listContainers, runContainer, stopContainer } from './runtime.js';

export function clusterFile(store) {
  return path.join(store.home, 'cluster.json');
}

export function readCluster(store) {
  try {
    const j = JSON.parse(fs.readFileSync(clusterFile(store), 'utf8'));
    if (j && typeof j === 'object') return { node: 'node0', deployments: [], ...j };
  } catch { /* fresh */ }
  return { node: 'node0', deployments: [], initialized: false };
}

export function writeCluster(store, c) {
  fs.writeFileSync(clusterFile(store), JSON.stringify(c, null, 2));
}

export function clusterInit(home) {
  const store = Store.resolve(home);
  store.init();
  const c = readCluster(store);
  c.initialized = true;
  c.node = 'node0';
  c.deployments = c.deployments ?? [];
  writeCluster(store, c);
  return c;
}

// Reconcile one deployment: ensure `replicas` member containers exist.
export function scaleDeployment(home, name, replicas) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  if (!c.initialized) throw new Error('no cluster (run `pimg cluster init`)');
  const dep = c.deployments.find((d) => d.name === name);
  if (!dep) throw new Error(`no such deployment '${name}'`);
  const existing = listContainers(store).filter((x) => x.name.startsWith(`${name}-`)).map((x) => x.name);
  const want = Math.max(0, replicas | 0);
  // Scale up.
  for (let i = existing.length; i < want; i++) {
    const member = `${name}-${i}`;
    if (!existing.includes(member)) {
      runContainer(home, { name: member, image: dep.image, command: dep.command ?? [] });
    }
  }
  // Scale down (highest indexes first).
  const live = listContainers(store).filter((x) => x.name.startsWith(`${name}-`)).map((x) => x.name).sort();
  for (let i = live.length - 1; i >= want; i--) {
    try {
      stopContainer(home, live[i]);
    } catch { /* already exited */ }
    fs.rmSync(path.join(store.containers, live[i]), { recursive: true, force: true });
  }
  dep.replicas = want;
  writeCluster(store, c);
  return dep;
}

// Apply a manifest file: { deployments: [{ name, image, replicas, command?, nodeSelector? }] }.
// Idempotent: creates/updates entries, records a revision (git-like commit),
// then reconciles each.
export function applyManifest(home, file) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  if (!c.initialized) throw new Error('no cluster (run `pimg cluster init`)');
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read manifest '${file}': ${e.message}`);
  }
  const deps = Array.isArray(m?.deployments) ? m.deployments : [];
  if (!deps.length) throw new Error('manifest has no deployments[]');
  const results = [];
  for (const d of deps) {
    const norm = normalizeDeployment(d);
    let dep = c.deployments.find((x) => x.name === norm.name);
    if (!dep) {
      dep = { name: norm.name, image: norm.image, replicas: 0, command: norm.command, nodeSelector: norm.nodeSelector };
      c.deployments.push(dep);
    } else {
      dep.image = norm.image;
      dep.command = norm.command;
      dep.nodeSelector = norm.nodeSelector;
    }
    writeCluster(store, c);
    results.push(scaleDeployment(home, norm.name, norm.replicas));
  }
  return results;
}

// Shared manifest validation/normalization (CLI + server).
export function normalizeDeployment(d) {
  if (!d?.name || !d?.image) throw new Error('each deployment needs { name, image }');
  return {
    name: d.name,
    image: d.image,
    replicas: Math.max(0, d.replicas ?? 1),
    command: Array.isArray(d.command) ? d.command : [],
    nodeSelector: d.nodeSelector && typeof d.nodeSelector === 'object' ? d.nodeSelector : {},
  };
}

// Server-side upsert: same as apply but without running local containers.
// The scheduler places units; agents execute them.
export function upsertDeployment(home, norm) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  if (!c.initialized) throw new Error('no cluster (run `pimg cluster init`)');
  let dep = c.deployments.find((x) => x.name === norm.name);
  if (!dep) {
    dep = { name: norm.name, image: norm.image, replicas: norm.replicas, command: norm.command, nodeSelector: norm.nodeSelector };
    c.deployments.push(dep);
  } else {
    dep.image = norm.image;
    dep.command = norm.command;
    dep.nodeSelector = norm.nodeSelector;
    dep.replicas = norm.replicas;
  }
  writeCluster(store, c);
  return dep;
}

export function deleteDeployment(home, name) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  const dep = c.deployments.find((d) => d.name === name);
  if (!dep) throw new Error(`no such deployment '${name}'`);
  const members = listContainers(store).filter((x) => x.name.startsWith(`${name}-`)).map((x) => x.name);
  for (const m of members) {
    try {
      stopContainer(home, m);
    } catch { /* already exited */ }
    fs.rmSync(path.join(store.containers, m), { recursive: true, force: true });
  }
  c.deployments = c.deployments.filter((d) => d.name !== name);
  writeCluster(store, c);
  return { name, removed: members.length };
}

// Render diff between manifest file and current cluster state (no changes).
export function diffManifest(home, file) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  let m;
  try {
    m = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    throw new Error(`cannot read manifest '${file}': ${e.message}`);
  }
  const lines = [];
  for (const d of m?.deployments ?? []) {
    const cur = c.deployments.find((x) => x.name === d.name);
    if (!cur) lines.push(`+ deployment/${d.name} image=${d.image} replicas=${d.replicas ?? 1} (new)`);
    else {
      if (cur.image !== d.image) lines.push(`~ deployment/${d.name} image: ${cur.image} -> ${d.image}`);
      if (d.replicas !== undefined && cur.replicas !== d.replicas) {
        lines.push(`~ deployment/${d.name} replicas: ${cur.replicas} -> ${d.replicas}`);
      }
      if (lines.length === 0 || !lines[lines.length - 1].includes(d.name)) {
        lines.push(`= deployment/${d.name} up to date`);
      }
    }
  }
  return lines;
}
