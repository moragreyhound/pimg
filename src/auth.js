// Auth + RBAC — users, tokens, roles, bindings (file-backed auth.json).
// Resources: deployments, units, images, containers, networks, nodes,
// revisions, rbac. Verbs: get, list, apply, delete, scale, register,
// heartbeat, report, manage. `*` wildcards both sides. The built-in
// `admin` role is `*/*`; agents get the `node-agent` role.
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { Store } from './store.js';

export function authFile(store) {
  return path.join(store.home, 'auth.json');
}

export function readAuth(store) {
  try {
    const j = JSON.parse(fs.readFileSync(authFile(store), 'utf8'));
    if (j && typeof j === 'object') {
      return {
        users: {}, roles: {}, bindings: [],
        ...j,
      };
    }
  } catch { /* fresh */ }
  return { users: {}, roles: {}, bindings: [] };
}

export function writeAuth(store, a) {
  fs.writeFileSync(authFile(store), JSON.stringify(a, null, 2));
  try {
    fs.chmodSync(authFile(store), 0o600);
  } catch { /* windows */ }
}

const sha = (t) => createHash('sha256').update(t).digest('hex');

export function defaultRoles() {
  return {
    admin: { resources: ['*'], verbs: ['*'] },
    viewer: { resources: ['deployments', 'units', 'images', 'containers', 'networks', 'nodes', 'revisions'], verbs: ['get', 'list'] },
    deployer: {
      resources: ['deployments', 'units', 'revisions'],
      verbs: ['get', 'list', 'apply', 'delete', 'scale'],
    },
    'node-agent': { resources: ['nodes', 'units'], verbs: ['register', 'heartbeat', 'get', 'list', 'report'] },
  };
}

// First-run bootstrap: admin user + roles + printed-once token.
export function bootstrapAuth(home) {
  const store = Store.resolve(home);
  store.init();
  const a = readAuth(store);
  let changed = false;
  for (const [name, rules] of Object.entries(defaultRoles())) {
    if (!a.roles[name]) {
      a.roles[name] = rules;
      changed = true;
    }
  }
  let token = null;
  if (!a.users.admin) {
    token = `pimg-admin-${randomBytes(24).toString('hex')}`;
    a.users.admin = { tokens: [sha(token)], created: new Date().toISOString() };
    a.bindings = a.bindings.filter((b) => !(b.user === 'admin' && b.role === 'admin'));
    a.bindings.push({ user: 'admin', role: 'admin' });
    changed = true;
  }
  if (changed) writeAuth(store, a);
  return { adminToken: token }; // non-null only on first bootstrap
}

export function createUser(home, name) {
  const store = Store.resolve(home);
  const a = readAuth(store);
  if (a.users[name]) throw new Error(`user '${name}' exists`);
  a.users[name] = { tokens: [], created: new Date().toISOString() };
  writeAuth(store, a);
  return name;
}

export function mintToken(home, name) {
  const store = Store.resolve(home);
  const a = readAuth(store);
  const u = a.users[name];
  if (!u) throw new Error(`no such user '${name}'`);
  const token = `pimg-${randomBytes(24).toString('hex')}`;
  u.tokens.push(sha(token));
  writeAuth(store, a);
  return token; // plaintext once — only the hash is stored
}

export function verifyToken(home, token) {
  if (!token) return null;
  const store = Store.resolve(home);
  const a = readAuth(store);
  const h = sha(token);
  for (const [name, u] of Object.entries(a.users)) {
    if ((u.tokens ?? []).includes(h)) return name;
  }
  return null;
}

export function grantRole(home, user, role) {
  const store = Store.resolve(home);
  const a = readAuth(store);
  if (!a.users[user]) throw new Error(`no such user '${user}'`);
  if (!a.roles[role]) throw new Error(`no such role '${role}' (try: ${Object.keys(a.roles).join(', ')})`);
  if (!a.bindings.some((b) => b.user === user && b.role === role)) {
    a.bindings.push({ user, role });
    writeAuth(store, a);
  }
  return { user, role };
}

export function userRoles(home, user) {
  const store = Store.resolve(home);
  const a = readAuth(store);
  return a.bindings.filter((b) => b.user === user).map((b) => b.role);
}

function ruleAllows(rule, resource, verb) {
  const res = rule.resources.includes('*') || rule.resources.includes(resource);
  const vrb = rule.verbs.includes('*') || rule.verbs.includes(verb);
  return res && vrb;
}

export function check(home, user, resource, verb) {
  const store = Store.resolve(home);
  const a = readAuth(store);
  const roles = a.bindings.filter((b) => b.user === user).map((b) => b.role);
  return roles.some((r) => a.roles[r] && ruleAllows(a.roles[r], resource, verb));
}
