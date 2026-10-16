// Agent — `pimg agent`: joins the fleet, heartbeats capacity, and executes
// scheduled units locally via the emulated runtime. The unit loop is
// reconcile-based (like kubelet): fetch desired units, start missing member
// containers named `unit-<id>`, stop removed ones, report status + log tail.
// Runs until SIGINT/SIGTERM.
import os from 'node:os';
import { Store } from './store.js';
import { containerLogs, listContainers, removeContainer, runContainer } from './runtime.js';
import { api } from './client.js';

export function hostCapacity() {
  const cpus = os.cpus().length || 1;
  return { cpu: cpus, mem: os.totalmem() };
}

export function hostUsed() {
  const load = os.loadavg()[0] ?? 0;
  return { cpu: Math.round(load * 100) / 100, mem: os.totalmem() - os.freemem() };
}

export function unitContainerName(id) {
  return `unit-${id.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
}

export async function agentOnce({ server, token, home, node, labels = {} }) {
  const store = Store.resolve(home);
  store.init();
  await api(server, token, 'POST', '/api/nodes/register', {
    name: node,
    labels,
    capacity: hostCapacity(),
  });
  await api(server, token, 'POST', '/api/nodes/heartbeat', {
    name: node,
    capacity: hostCapacity(),
    used: hostUsed(),
  });
  const { units } = await api(server, token, 'GET', `/api/units?node=${encodeURIComponent(node)}`);
  const wanted = new Map((units ?? []).map((u) => [u.id, u]));
  const have = new Map(
    listContainers(store)
      .filter((c) => c.name.startsWith('unit-'))
      .map((c) => [c.name, c]),
  );
  // Stop units no longer assigned here.
  for (const [name] of have) {
    const stillWanted = [...wanted.keys()].some((wid) => unitContainerName(wid) === name);
    if (!stillWanted) {
      try {
        removeContainer(home, name, { force: true });
      } catch { /* already gone */ }
    }
  }
  // Start missing units.
  for (const [id, u] of wanted) {
    const name = unitContainerName(id);
    if (!have.has(name)) {
      try {
        runContainer(home, { name, image: u.image, command: u.command ?? [] });
      } catch { /* duplicate raced */ }
    }
  }
  // Report status + log tails.
  const after = listContainers(store).filter((c) => c.name.startsWith('unit-'));
  for (const c of after) {
    const wid = [...wanted.keys()].find((k) => unitContainerName(k) === c.name);
    if (!wid) continue;
    try {
      await api(server, token, 'POST', `/api/units/${encodeURIComponent(wid)}/status`, {
        status: c.status === 'running' ? 'Running' : 'Exited',
        logs: containerLogs(home, c.name, { tail: 20 }).map((l) => `[${c.name}] ${l}`),
      });
    } catch { /* server went away; next loop retries */ }
  }
  return { node, units: wanted.size, running: after.filter((c) => c.status === 'running').length };
}

export async function runAgent({ server, token, home, node, labels = {}, interval = 5000, onTick = null }) {
  if (!server) throw new Error('agent needs --server <url>');
  if (!node) throw new Error('agent needs --node <name>');
  let stop = false;
  const quit = () => { stop = true; };
  process.once('SIGINT', quit);
  process.once('SIGTERM', quit);
  let last = null;
  while (!stop) {
    try {
      last = await agentOnce({ server, token, home, node, labels });
      onTick?.(null, last);
    } catch (e) {
      onTick?.(e, null);
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  return last;
}
