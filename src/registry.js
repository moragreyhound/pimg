// OCI registry client — Phase 2 (pull/push).
// Node gets TLS for free via global fetch, so unlike the C++ build (TLS
// decision deferred) the port can talk to real registries: Docker Hub,
// GHCR, localhost plain-HTTP registries. Blobs stream to disk with progress
// callbacks and are digest-verified before use (same invariant as oci.js).
import fs from 'node:fs';
import path from 'node:path';
import { verifyFile } from './digest.js';

const DOCKER_HUB = 'registry-1.docker.io';

// ref -> { registry, repo, tag, digest }. Bare names default to Docker Hub
// library + latest, mirroring docker/podman short-name behavior.
export function parseRef(ref) {
  let registry = DOCKER_HUB;
  let rest = ref;
  const slash = ref.indexOf('/');
  const first = slash === -1 ? ref : ref.slice(0, slash);
  if (slash !== -1 && (first.includes('.') || first.includes(':') || first === 'localhost')) {
    registry = first;
    rest = ref.slice(slash + 1);
  }
  let digest = '';
  let tag = 'latest';
  const at = rest.indexOf('@');
  if (at !== -1) {
    digest = rest.slice(at + 1);
    rest = rest.slice(0, at);
    tag = '';
  } else {
    const colon = rest.lastIndexOf(':');
    if (colon !== -1 && !rest.slice(colon + 1).includes('/')) {
      tag = rest.slice(colon + 1) || 'latest';
      rest = rest.slice(0, colon);
    }
  }
  let repo = rest;
  if (registry === DOCKER_HUB && !repo.includes('/')) repo = `library/${repo}`;
  if (!repo) throw new Error(`invalid reference '${ref}'`);
  return { registry, repo, tag, digest };
}

export function refToName(r) {
  return r.digest ? `${r.repo}@${r.digest}` : `${r.repo}:${r.tag}`;
}

function baseUrl(registry, plainHttp = false) {
  return `${plainHttp ? 'http' : 'https'}://${registry}`;
}

// Minimal WWW-Authenticate Bearer parser for the Docker token flow.
function parseChallenge(header) {
  const m = /Bearer\s+(.*)/i.exec(header ?? '');
  if (!m) return null;
  const params = {};
  for (const mm of m[1].matchAll(/(\w+)="([^"]*)"/g)) params[mm[1]] = mm[2];
  return params.realm ? params : null;
}

async function fetchToken(realm, service, scope, basic) {
  const u = new URL(realm);
  if (service) u.searchParams.set('service', service);
  if (scope) u.searchParams.set('scope', scope);
  const headers = {};
  if (basic) headers.authorization = basic;
  const res = await fetch(u, { headers });
  if (!res.ok) throw new Error(`token endpoint ${res.status}`);
  const j = await res.json();
  const token = j.token ?? j.access_token;
  if (!token) throw new Error('token endpoint returned no token');
  return token;
}

export class Registry {
  constructor(registry, { plainHttp = false, auth = null } = {}) {
    this.registry = registry;
    this.base = baseUrl(registry, plainHttp);
    this.auth = auth; // { username, password } or null (anonymous)
    this.basic = auth ? `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}` : null;
    this.bearer = null;
  }

  async request(p, { method = 'GET', headers = {}, body = null, scope = null } = {}) {
    const h = { ...headers };
    h.authorization = this.bearer ? `Bearer ${this.bearer}` : this.basic ?? undefined;
    if (h.authorization === undefined) delete h.authorization;
    let res = await fetch(this.base + p, { method, headers: h, body, duplex: body ? 'half' : undefined });
    if (res.status === 401 && !this.bearer) {
      const ch = parseChallenge(res.headers.get('www-authenticate'));
      if (ch) {
        this.bearer = await fetchToken(ch.realm, ch.service, scope ?? ch.scope, this.basic);
        h.authorization = `Bearer ${this.bearer}`;
        res = await fetch(this.base + p, { method, headers: h, body, duplex: body ? 'half' : undefined });
      }
    }
    return res;
  }

  async fetchManifest(repo, reference) {
    const accept = [
      'application/vnd.oci.image.index.v1+json',
      'application/vnd.oci.image.manifest.v1+json',
      'application/vnd.docker.distribution.manifest.list.v2+json',
      'application/vnd.docker.distribution.manifest.v2+json',
    ].join(', ');
    const res = await this.request(`/v2/${repo}/manifests/${reference}`, {
      headers: { accept },
      scope: `repository:${repo}:pull`,
    });
    if (res.status === 404) throw new Error(`manifest not found: ${repo}:${reference}`);
    if (!res.ok) throw new Error(`manifest fetch failed: HTTP ${res.status}`);
    return { manifest: await res.json(), digest: res.headers.get('docker-content-digest') ?? '' };
  }

  // Resolve manifest lists to a single image manifest (platform match).
  async resolveManifest(repo, reference, platform = null) {
    const first = await this.fetchManifest(repo, reference);
    const mt = first.manifest.mediaType ?? '';
    const isList = mt.includes('manifest.list') || Array.isArray(first.manifest.manifests);
    if (!isList) return first;
    const wantOs = platform?.os ?? (process.platform === 'win32' ? 'windows' : 'linux');
    const wantArch = platform?.arch ?? (process.arch === 'arm64' ? 'arm64' : 'amd64');
    const cands = first.manifest.manifests ?? [];
    const pick =
      cands.find((m) => m?.platform?.os === wantOs && m?.platform?.architecture === wantArch) ??
      cands.find((m) => m?.platform?.os === wantOs) ??
      cands[0];
    if (!pick?.digest) throw new Error('empty manifest list');
    return this.fetchManifest(repo, pick.digest);
  }

  // Stream a blob to dest with progress. Verifies digest before resolving.
  async downloadBlob(repo, digest, dest, onProgress = null) {
    const hex = digest.slice(7);
    const res = await this.request(`/v2/${repo}/blobs/${digest}`, { scope: `repository:${repo}:pull` });
    if (!res.ok || !res.body) throw new Error(`blob fetch failed: ${digest} (HTTP ${res.status})`);
    const total = Number(res.headers.get('content-length') ?? 0);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    const tmp = `${dest}.${process.pid}.part`;
    const out = fs.createWriteStream(tmp);
    let done = 0;
    try {
      for await (const chunk of res.body) {
        out.write(chunk);
        done += chunk.length;
        onProgress?.({ digest, done, total });
      }
    } finally {
      await new Promise((r) => out.end(r));
    }
    const v = verifyFile(tmp, digest);
    if (!v.ok) {
      await fs.promises.rm(tmp, { force: true });
      throw new Error(`downloaded blob failed verification: ${v.err}`);
    }
    await fs.promises.rename(tmp, dest);
    // eslint-disable-next-line no-unused-vars
    void hex;
    return { done, total };
  }

  async blobExists(repo, digest) {
    const res = await this.request(`/v2/${repo}/blobs/${digest}`, {
      method: 'HEAD',
      scope: `repository:${repo}:pull,push`,
    });
    return res.status === 200;
  }

  // Chunked monolithic upload (single PUT). Reports progress from the file.
  async uploadBlob(repo, file, digest, onProgress = null) {
    const total = fs.statSync(file).size;
    if (await this.blobExists(repo, digest)) {
      onProgress?.({ digest, done: total, total });
      return { skipped: true };
    }
    const post = await this.request(`/v2/${repo}/blobs/uploads/`, {
      method: 'POST',
      scope: `repository:${repo}:pull,push`,
    });
    if (post.status !== 202) throw new Error(`upload init failed: HTTP ${post.status}`);
    let loc = post.headers.get('location');
    if (!loc) throw new Error('upload init returned no location');
    if (loc.startsWith('/')) loc = this.base + loc;
    const data = fs.readFileSync(file);
    onProgress?.({ digest, done: 0, total });
    const sep = loc.includes('?') ? '&' : '?';
    const put = await fetch(`${loc}${sep}digest=${encodeURIComponent(digest)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        'content-length': String(data.length),
        authorization: this.bearer ? `Bearer ${this.bearer}` : this.basic ?? '',
      },
      body: data,
      duplex: 'half',
    });
    if (put.status !== 201 && put.status !== 202) throw new Error(`blob upload failed: HTTP ${put.status}`);
    onProgress?.({ digest, done: total, total });
    return { skipped: false };
  }

  async putManifest(repo, reference, manifest) {
    const mt = manifest.mediaType ?? 'application/vnd.oci.image.manifest.v1+json';
    const res = await this.request(`/v2/${repo}/manifests/${reference}`, {
      method: 'PUT',
      headers: { 'content-type': mt },
      body: JSON.stringify(manifest),
      scope: `repository:${repo}:pull,push`,
    });
    if (res.status !== 201 && res.status !== 202) throw new Error(`manifest push failed: HTTP ${res.status}`);
    return res.headers.get('docker-content-digest') ?? '';
  }
}
