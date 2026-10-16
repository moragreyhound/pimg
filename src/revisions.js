// Revisions — git-like history for cluster manifests.
// Every apply/scale records a revision { id, ts, deployment, manifest } on
// the deployment (cap 10). list/diff/rollback give you commit history,
// commit diff, and revert — without a git binary.
import { Store } from './store.js';
import { readCluster, writeCluster } from './cluster.js';

const CAP = 10;

export function recordRevision(home, deployment, manifest) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  const dep = c.deployments.find((d) => d.name === deployment);
  if (!dep) throw new Error(`no such deployment '${deployment}'`);
  dep.revisions = dep.revisions ?? [];
  const id = (dep.revisions.at(-1)?.id ?? 0) + 1;
  dep.revisions.push({ id, ts: new Date().toISOString(), manifest: { ...manifest } });
  dep.revisions = dep.revisions.slice(-CAP);
  writeCluster(store, c);
  return id;
}

export function listRevisions(home, deployment) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  const dep = c.deployments.find((d) => d.name === deployment);
  if (!dep) throw new Error(`no such deployment '${deployment}'`);
  return [...(dep.revisions ?? [])].reverse(); // newest first, like git log
}

// Field-level diff between two manifests (no external diff lib needed).
export function diffManifests(a, b) {
  const lines = [];
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])].sort();
  for (const k of keys) {
    const x = JSON.stringify(a?.[k] ?? null);
    const y = JSON.stringify(b?.[k] ?? null);
    if (x !== y) lines.push(`~ ${k}: ${x} -> ${y}`);
  }
  return lines;
}

export function diffRevisions(home, deployment, idA, idB) {
  const revs = listRevisions(home, deployment);
  const a = revs.find((r) => r.id === Number(idA));
  const b = revs.find((r) => r.id === Number(idB));
  if (!a || !b) throw new Error('revision not found (see `revision list`)');
  return diffManifests(a.manifest, b.manifest);
}

// Rollback = apply the old manifest as a new revision (history preserved,
// exactly like `git revert` instead of rewriting history).
export function rollbackRevision(home, deployment, id) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  const dep = c.deployments.find((d) => d.name === deployment);
  if (!dep) throw new Error(`no such deployment '${deployment}'`);
  const rev = (dep.revisions ?? []).find((r) => r.id === Number(id));
  if (!rev) throw new Error(`no such revision '${id}'`);
  dep.image = rev.manifest.image ?? dep.image;
  dep.command = rev.manifest.command ?? dep.command;
  dep.replicas = rev.manifest.replicas ?? dep.replicas ?? 0;
  writeCluster(store, c);
  const newId = recordRevision(home, deployment, {
    image: dep.image,
    replicas: rev.manifest.replicas ?? dep.replicas ?? 0,
    command: dep.command ?? [],
    rollbackOf: Number(id),
  });
  return { deployment, from: Number(id), to: newId, manifest: rev.manifest };
}
