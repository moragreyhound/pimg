// Scheduler — pure placement of deployment units onto nodes.
// Policy: only Ready nodes (fresh heartbeat), optional label selector match,
// then least-loaded by assigned-unit count weighted against reported CPU
// capacity. Unknown capacity counts as 1 slot so new nodes still get work.
// Returns [{ deployment, index, node }]. Fully deterministic + testable.
export function nodeReady(node, now = Date.now(), staleMs = 30000) {
  if (!node) return false;
  if (node.status && node.status !== 'Ready') return false;
  return now - (node.lastHeartbeat ?? 0) <= staleMs;
}

export function labelsMatch(nodeLabels = {}, selector = {}) {
  return Object.entries(selector).every(([k, v]) => nodeLabels?.[k] === v);
}

function nodeWeight(node) {
  const cpu = Number(node?.capacity?.cpu);
  if (Number.isFinite(cpu) && cpu > 0) return Math.max(1, Math.round(cpu));
  return 1;
}

// desired: [{ deployment, replicas, nodeSelector? }]
// nodes: [{ name, capacity, labels, lastHeartbeat, status }]
// existing: [{ deployment, index, node }] — stable units keep their node.
export function schedule(desired, nodes, existing = [], now = Date.now()) {
  const ready = (nodes ?? []).filter((n) => nodeReady(n, now));
  const load = new Map(ready.map((n) => [n.name, 0]));
  const out = [];
  for (const d of desired ?? []) {
    const want = Math.max(0, d.replicas | 0);
    const keep = (existing ?? []).filter((u) => u.deployment === d.deployment && u.index < want);
    const kept = new Set(keep.map((u) => u.index));
    for (const u of keep) {
      if (load.has(u.node)) {
        load.set(u.node, load.get(u.node) + 1);
        out.push({ deployment: d.deployment, index: u.index, node: u.node });
      } else {
        kept.delete(u.index); // node gone — reschedule below
      }
    }
    for (let i = 0; i < want; i++) {
      if (kept.has(i)) continue;
      const cands = ready.filter((n) => labelsMatch(n.labels, d.nodeSelector));
      if (!cands.length) {
        out.push({ deployment: d.deployment, index: i, node: null });
        continue;
      }
      cands.sort((a, b) => (load.get(a.name) / nodeWeight(a)) - (load.get(b.name) / nodeWeight(b)));
      const pick = cands[0].name;
      load.set(pick, load.get(pick) + 1);
      out.push({ deployment: d.deployment, index: i, node: pick });
    }
  }
  return out;
}

// Combined compute pool: summed + used capacity across Ready nodes.
export function poolCapacity(nodes, units = [], now = Date.now()) {
  const ready = (nodes ?? []).filter((n) => nodeReady(n, now));
  const total = { cpu: 0, mem: 0, nodes: ready.length };
  for (const n of ready) {
    total.cpu += Number(n.capacity?.cpu) || 0;
    total.mem += Number(n.capacity?.mem) || 0;
  }
  const used = { cpu: 0, mem: 0, units: (units ?? []).length };
  for (const n of ready) {
    used.cpu += Number(n.used?.cpu) || 0;
    used.mem += Number(n.used?.mem) || 0;
  }
  return { total, used };
}
