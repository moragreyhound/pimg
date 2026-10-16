// API server — `pimg serve`. JSON over HTTP, Bearer-token auth, RBAC on
// every route except /api/healthz and /api/version. State stays file-backed
// (cluster.json + auth.json); the scheduler places units, agents execute.
import http from 'node:http';
import { Store } from './store.js';
import { bootstrapAuth, check, createUser, grantRole, mintToken, readAuth, verifyToken } from './auth.js';
import { normalizeDeployment, readCluster, upsertDeployment, writeCluster } from './cluster.js';
import { recordRevision, listRevisions, rollbackRevision } from './revisions.js';
import { nodeReady, poolCapacity, schedule } from './scheduler.js';

const STALE_MS = 30000;

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let s = '';
    req.on('data', (c) => {
      s += c;
      if (s.length > 4 * 1024 * 1024) reject(new Error('body too large'));
    });
    req.on('end', () => {
      if (!s) return resolve(undefined);
      try {
        resolve(JSON.parse(s));
      } catch {
        reject(new Error('invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

// Recompute unit placements from desired state (deployments + ready nodes),
// preserving status/logs for units that keep their slot.
export function reconcileUnits(home) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  c.units = c.units ?? [];
  c.nodes = c.nodes ?? [];
  const desired = (c.deployments ?? []).map((d) => ({
    deployment: d.name,
    replicas: d.replicas ?? 0,
    nodeSelector: d.nodeSelector ?? {},
  }));
  const plan = schedule(desired, c.nodes, c.units);
  const byId = new Map(c.units.map((u) => [u.id, u]));
  c.units = plan.map((p) => {
    const id = `${p.deployment}-${p.index}`;
    const prev = byId.get(id);
    const dep = c.deployments.find((d) => d.name === p.deployment);
    return {
      id,
      deployment: p.deployment,
      index: p.index,
      node: p.node,
      image: dep?.image ?? prev?.image ?? '',
      command: dep?.command ?? prev?.command ?? [],
      status: p.node === null ? 'Pending' : prev?.status ?? 'Pending',
      logs: prev?.logs ?? [],
      updated: prev?.updated ?? null,
    };
  });
  writeCluster(store, c);
  return c.units;
}

export function nodeCapacity(home, name) {
  const store = Store.resolve(home);
  const c = readCluster(store);
  const n = (c.nodes ?? []).find((x) => x.name === name);
  return n ? { ...n, ready: nodeReady(n) } : null;
}

export function createServer(home) {
  const store = Store.resolve(home);
  store.init();
  const { adminToken } = bootstrapAuth(home);

  const server = http.createServer(async (req, res) => {
    try {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/api/healthz') return send(res, 200, { ok: true });
      if (u.pathname === '/api/version') return send(res, 200, { version: '0.1.0', mode: 'server' });

      const auth = req.headers.authorization ?? '';
      const user = verifyToken(home, auth.startsWith('Bearer ') ? auth.slice(7) : '');
      if (!user) return send(res, 401, { error: 'missing or invalid bearer token' });
      const need = (resource, verb) => {
        if (!check(home, user, resource, verb)) {
          send(res, 403, { error: `forbidden: ${user} lacks ${verb} on ${resource}` });
          return false;
        }
        return true;
      };

      const parts = u.pathname.split('/').filter(Boolean); // ['api', ...]
      const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : undefined;

      // ---- nodes ----
      if (parts[1] === 'nodes' && req.method === 'GET' && parts.length === 2) {
        if (!need('nodes', 'list')) return;
        const c = readCluster(store);
        return send(res, 200, {
          nodes: (c.nodes ?? []).map((n) => ({ ...n, ready: nodeReady(n) })),
        });
      }
      if (parts[1] === 'nodes' && parts[2] === 'register' && req.method === 'POST') {
        if (!need('nodes', 'register')) return;
        const { name, labels, capacity } = body ?? {};
        if (!name) return send(res, 400, { error: 'node name required' });
        const c = readCluster(store);
        c.nodes = c.nodes ?? [];
        let n = c.nodes.find((x) => x.name === name);
        if (!n) {
          n = { name, status: 'Ready', firstSeen: new Date().toISOString() };
          c.nodes.push(n);
        }
        n.labels = labels ?? n.labels ?? {};
        n.capacity = capacity ?? n.capacity ?? {};
        n.status = 'Ready';
        n.lastHeartbeat = Date.now();
        writeCluster(store, c);
        reconcileUnits(home);
        return send(res, 200, { node: n.name });
      }
      if (parts[1] === 'nodes' && parts[2] === 'heartbeat' && req.method === 'POST') {
        if (!need('nodes', 'heartbeat')) return;
        const { name, capacity, used } = body ?? {};
        const c = readCluster(store);
        const n = (c.nodes ?? []).find((x) => x.name === name);
        if (!n) return send(res, 404, { error: `unknown node '${name}' (register first)` });
        if (capacity) n.capacity = capacity;
        if (used) n.used = used;
        n.status = 'Ready';
        n.lastHeartbeat = Date.now();
        writeCluster(store, c);
        return send(res, 200, { ok: true });
      }
      if (parts[1] === 'nodes' && parts.length === 3 && req.method === 'DELETE') {
        if (!need('nodes', 'delete')) return;
        const c = readCluster(store);
        c.nodes = (c.nodes ?? []).filter((x) => x.name !== decodeURIComponent(parts[2]));
        writeCluster(store, c);
        reconcileUnits(home);
        return send(res, 200, { ok: true });
      }

      // ---- cluster status + combined pool ----
      if (parts[1] === 'cluster' && req.method === 'GET') {
        if (!need('deployments', 'list')) return;
        const c = readCluster(store);
        const pool = poolCapacity(c.nodes, c.units);
        return send(res, 200, {
          node: c.node,
          initialized: !!c.initialized,
          deployments: c.deployments ?? [],
          pool,
        });
      }

      // ---- deployments ----
      if (parts[1] === 'deployments' && req.method === 'GET') {
        if (!need('deployments', 'list')) return;
        const c = readCluster(store);
        return send(res, 200, { deployments: c.deployments ?? [] });
      }
      if (parts[1] === 'apply' && req.method === 'POST') {
        if (!need('deployments', 'apply')) return;
        const deps = Array.isArray(body?.deployments) ? body.deployments : [];
        if (!deps.length) return send(res, 400, { error: 'no deployments[]' });
        const out = [];
        for (const raw of deps) {
          const norm = normalizeDeployment(raw);
          upsertDeployment(home, norm);
          const rev = recordRevision(home, norm.name, {
            image: norm.image,
            replicas: norm.replicas,
            command: norm.command,
            nodeSelector: norm.nodeSelector,
          });
          out.push({ name: norm.name, revision: rev });
        }
        const units = reconcileUnits(home);
        return send(res, 200, { applied: out, units: units.length });
      }
      if (parts[1] === 'deployments' && parts.length === 3 && req.method === 'DELETE') {
        if (!need('deployments', 'delete')) return;
        const name = decodeURIComponent(parts[2]);
        const c = readCluster(store);
        if (!(c.deployments ?? []).some((d) => d.name === name)) {
          return send(res, 404, { error: `no such deployment '${name}'` });
        }
        c.deployments = c.deployments.filter((d) => d.name !== name);
        writeCluster(store, c);
        reconcileUnits(home);
        return send(res, 200, { ok: true });
      }
      if (parts[1] === 'deployments' && parts[3] === 'scale' && req.method === 'POST') {
        if (!need('deployments', 'scale')) return;
        const name = decodeURIComponent(parts[2]);
        const store2 = Store.resolve(home);
        const c = readCluster(store2);
        const dep = (c.deployments ?? []).find((d) => d.name === name);
        if (!dep) return send(res, 404, { error: `no such deployment '${name}'` });
        dep.replicas = Math.max(0, Number(body?.replicas) | 0);
        writeCluster(store2, c);
        recordRevision(home, name, {
          image: dep.image,
          replicas: dep.replicas,
          command: dep.command ?? [],
          nodeSelector: dep.nodeSelector ?? {},
        });
        const units = reconcileUnits(home);
        return send(res, 200, { name, replicas: dep.replicas, units: units.filter((x) => x.deployment === name).length });
      }

      // ---- units (agents poll + report) ----
      if (parts[1] === 'units' && req.method === 'GET') {
        if (!need('units', 'list')) return;
        const c = readCluster(store);
        const only = u.searchParams.get('node');
        const units = (c.units ?? []).filter((x) => !only || x.node === only);
        return send(res, 200, { units });
      }
      if (parts[1] === 'units' && parts[3] === 'status' && req.method === 'POST') {
        if (!need('units', 'report')) return;
        const id = decodeURIComponent(parts[2]);
        const c = readCluster(store);
        const unit = (c.units ?? []).find((x) => x.id === id);
        if (!unit) return send(res, 404, { error: `no such unit '${id}'` });
        if (typeof body?.status === 'string') unit.status = body.status;
        if (Array.isArray(body?.logs)) unit.logs = body.logs.slice(-50);
        unit.updated = new Date().toISOString();
        writeCluster(store, c);
        return send(res, 200, { ok: true });
      }

      // ---- revisions (git-like) ----
      if (parts[1] === 'revisions' && parts.length === 3 && req.method === 'GET') {
        if (!need('revisions', 'list')) return;
        try {
          return send(res, 200, { revisions: listRevisions(home, decodeURIComponent(parts[2])) });
        } catch (e) {
          return send(res, 404, { error: e.message });
        }
      }
      if (parts[1] === 'revisions' && parts[3] === 'rollback' && req.method === 'POST') {
        if (!need('deployments', 'apply')) return;
        try {
          const r = rollbackRevision(home, decodeURIComponent(parts[2]), parts[4]);
          reconcileUnits(home);
          return send(res, 200, r);
        } catch (e) {
          return send(res, 404, { error: e.message });
        }
      }

      // ---- rbac ----
      if (parts[1] === 'rbac' && req.method === 'GET') {
        if (!need('rbac', 'list')) return;
        const a = readAuth(store);
        return send(res, 200, { users: Object.keys(a.users), roles: a.roles, bindings: a.bindings });
      }
      if (parts[1] === 'rbac' && parts[2] === 'users' && req.method === 'POST') {
        if (!need('rbac', 'manage')) return;
        try {
          return send(res, 200, { user: createUser(home, body?.name) });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (parts[1] === 'rbac' && parts[2] === 'tokens' && req.method === 'POST') {
        if (!need('rbac', 'manage')) return;
        try {
          return send(res, 200, { user: body?.user, token: mintToken(home, body?.user) });
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }
      if (parts[1] === 'rbac' && parts[2] === 'grants' && req.method === 'POST') {
        if (!need('rbac', 'manage')) return;
        try {
          return send(res, 200, grantRole(home, body?.user, body?.role));
        } catch (e) {
          return send(res, 400, { error: e.message });
        }
      }

      return send(res, 404, { error: `unknown route ${req.method} ${u.pathname}` });
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  });

  return { server, adminToken };
}

export function serve(home, { port = 8443, bind = '127.0.0.1' } = {}) {
  const store = Store.resolve(home);
  store.init();
  const c = readCluster(store);
  c.initialized = true;
  c.node = c.node ?? 'node0';
  writeCluster(store, c);
  const { server, adminToken } = createServer(home);
  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, bind, () => resolve({ server, adminToken, port, bind }));
  });
}
