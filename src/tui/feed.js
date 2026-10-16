// Activity feed — Claude-style transcript of what changed between polls.
// diffSnapshots(prev, next, now) is pure and null-safe; the UI accumulates
// events via pushFeed (capped) and renders icon + relative age + text.
export const FEED_CAP = 30;

function byId(list) {
  const m = new Map();
  for (const r of list ?? []) {
    if (r && r.id !== undefined) m.set(r.id, r);
  }
  return m;
}

export function diffSnapshots(prev, next, now = Date.now()) {
  const out = [];
  if (!prev || !next) return out;
  const pc = byId(prev.containers);
  const nc = byId(next.containers);
  for (const [id, c] of nc) {
    if (!pc.has(id)) out.push({ t: now, icon: '+', kind: 'container', text: `started ${id}` });
    else if ((pc.get(id).status ?? '') !== (c.status ?? '')) {
      out.push({ t: now, icon: '~', kind: 'container', text: `${id}: ${pc.get(id).status || '?'} → ${c.status || '?'}` });
    }
  }
  for (const id of pc.keys()) {
    if (!nc.has(id)) out.push({ t: now, icon: '-', kind: 'container', text: `removed ${id}` });
  }
  const pi = byId(prev.images);
  const ni = byId(next.images);
  for (const id of ni.keys()) {
    if (!pi.has(id)) out.push({ t: now, icon: '+', kind: 'image', text: `pulled ${id}` });
  }
  for (const id of pi.keys()) {
    if (!ni.has(id)) out.push({ t: now, icon: '-', kind: 'image', text: `removed image ${id}` });
  }
  const pd = new Map((prev.deployments ?? []).map((d) => [d?.name, d]));
  for (const d of next.deployments ?? []) {
    if (!d?.name) continue;
    const old = pd.get(d.name);
    if (!old) out.push({ t: now, icon: '+', kind: 'deployment', text: `applied deployment/${d.name}` });
    else if ((old.replicas ?? 0) !== (d.replicas ?? 0)) {
      out.push({ t: now, icon: '~', kind: 'deployment', text: `deployment/${d.name}: replicas ${old.replicas ?? 0} → ${d.replicas ?? 0}` });
    }
  }
  return out;
}

export function pushFeed(feed, events, cap = FEED_CAP) {
  const next = [...(feed ?? []), ...(events ?? [])];
  return next.slice(Math.max(0, next.length - Math.max(1, cap)));
}

export function formatAge(ts, now = Date.now()) {
  const s = Math.max(0, Math.floor(((now ?? Date.now()) - ts) / 1000));
  if (s < 5) return 'now';
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}
