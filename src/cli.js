// CLI — port of src/cli.cpp + src/main.cpp.
// Same parsing semantics: global flags anywhere, --key=value / --key value,
// two-word commands (network/net/cluster/rollout), honest stubs exit 2.
import { Store, listImages } from './store.js';
import fs from 'node:fs';
import { digestOfFile, verifyFile } from './digest.js';
import { loadLayout } from './oci.js';
import { cmdDoctor } from './doctor.js';
import {
  outputInit, cyan, dim, green, printError, printSuccess, printWarn, renderTable, ProgressBar,
} from './output.js';
import { App, loadSnapshot } from './tui/model.js';
import { renderSnapshot } from './tui/snapshot.js';
import { iconSetName } from './tui/theme.js';
import { hostLabel, platformLabel } from './tui/sysicons.js';
import {
  imageHistory, loadImage, pruneStore, pullImage, pushImage, removeImage,
  saveImage, tagImage,
} from './images.js';
import {
  aggregateLogs, containerLogs, listContainers, removeContainer, runContainer,
  startContainer, stopContainer,
} from './runtime.js';
import { dnsLookup, httpProbe, pingTcp, scanPorts } from './nettools.js';
import {
  applyManifest, clusterInit, deleteDeployment, diffManifest, readCluster,
  scaleDeployment,
} from './cluster.js';
import { dispatchPlugin, discoverPlugins, loadPlugin } from './plugins.js';
import { memPercent, sampleLiveStats } from './stats.js';
import {
  bootstrapAuth, check as rbacCheck, createUser, grantRole, mintToken, readAuth, userRoles, verifyToken,
} from './auth.js';
import { nodeReady, poolCapacity } from './scheduler.js';
import { diffRevisions, listRevisions, recordRevision, rollbackRevision } from './revisions.js';
import { api as serverApi, loadConfig, resolveServer, saveConfig } from './client.js';
import { runAgent } from './agent.js';
import { serve as serveCluster } from './server.js';

export const VERSION = '0.1.0';

export function printVersion() {
  process.stdout.write(`pimg ${VERSION}\n`);
}

export function printHelp(topic = '') {
  if (topic === 'ui') {
    process.stdout.write(
      'Usage: pimg ui [--demo] [--snapshot [--cols N] [--rows N] [--theme NAME]]\n\nFull terminal UI: views, live stats, themes, palette.\nKeys: arrows/hjkl move, tab panes, / filter, t theme, i icons,\n      : or ctrl+p palette, ? help, d delete (type name), q quit.\n--demo seeds labeled sample rows for screenshots.\n--snapshot prints one frame without entering interactive mode.\n',
    );
    return;
  }
  if (topic === 'doctor') {
    process.stdout.write('Usage: pimg doctor [--json]\n\nProbe capabilities (user namespaces, cgroups, proot, storage, tty, color).\nNever requires sudo.\n');
    return;
  }
  process.stdout.write(
    `pimg ${VERSION} - portable images & containers (no root required)\n\nUsage: pimg [GLOBAL FLAGS] <command> [args]\n\nGlobal flags: --json --no-color --quiet --verbose --home <dir> --context <name> --yes\n\nImages:\n  pull <ref> [--platform OS/ARCH] [--plain-http] | push <ref> | images | rmi <img> | tag SRC DST\n  inspect <name|layout-dir> | history <img> | save <img> [-o FILE] | load FILE | prune\n  digest <file> [--expect sha256:...]   (verify content hash)\n  build                                  (Dockerfile builder: not yet, exit 2)\n\nContainers (emulated backend):\n  run --name N [-e K=V] <image> [-- cmd...]\n  ps [-a] | start/stop/kill/rm <name> | logs <name> [--tail N] | stats\n\nNetworking (TCP/UDP/DNS probes, no raw sockets):\n  network create|ls|rm|inspect\n  net ping <host>[:port] | net dns <name> | net http <url> | net scan <host> [ports]\n\nCluster (single-node, file-backed):\n  cluster init|status|nodes|top\n  apply|delete|diff -f FILE | get|describe <kind> [name] | scale <dep> --replicas N\n\nFleet — server, agents, load distribution, RBAC, revisions:\n  serve [--port N] [--bind ADDR]   API server (prints admin token once)\n  login --server URL [--token T]   save context (or PIMG_SERVER/PIMG_TOKEN)\n  agent --server URL --node NAME [--labels k=v,..]   join + execute units\n  nodes | top                      fleet members | combined cpu/mem pool\n  revision list|diff|rollback <dep> [ids]   git-like manifest history\n  rbac list|user|token|grant      users, tokens, role bindings\n  --server URL | --local          run get/apply/scale/... remotely or locally\n\nPlugins:\n  plugin list | plugin run <plugin> <cmd> [args] | <plugin> <cmd> [args]\n\nOther:\n  doctor [--json]     capability report\n  ui [--demo] [--snapshot]   terminal UI (views, live stats, themes, palette)\n  --version | --help\n\nBackends are honest: containers run supervised (emulated isolation),\nnet tools use user-level probes, plugins run in-process (trust them).\n`,
  );
}

function stub(name, phase) {
  printError(`'${name}' is not implemented yet`, `phase ${phase} has not landed in this build`, 'run `pimg doctor` and `pimg --help` for what works today');
  return 2;
}

function cmdImages(g) {
  const s = Store.resolve(g.home);
  s.init();
  const { images } = listImages(s);
  if (g.out.json) {
    process.stdout.write(`{"version":1,"images":[${images.map((im) => `{"name":"${im.name}","digest":"${im.digest}","os":"${im.os ?? ''}","arch":"${im.arch ?? ''}"}`).join(',')}]}\n`);
    return 0;
  }
  const rows = images.map((im) => [im.name, im.digest || dim('-'), platformLabel(im.os ?? '', im.arch ?? '', 2)]);
  if (!rows.length) {
    process.stdout.write(dim(`no images in ${s.images}\n`));
    return 0;
  }
  process.stdout.write(renderTable(['REPOSITORY:TAG', 'DIGEST', 'PLATFORM'], rows));
  return 0;
}

function resolveImageDir(g, target) {
  // Accept an OCI layout dir OR a stored image name.
  const direct = loadLayout(target);
  if (direct.ok) return { dir: target, loaded: direct };
  const s = Store.resolve(g.home);
  const cand = `${s.images}/${target.replace(/[^A-Za-z0-9_.-]/g, '_')}`;
  const stored = loadLayout(cand);
  if (stored.ok) return { dir: cand, loaded: stored };
  return { dir: target, loaded: direct };
}

function cmdInspect(g, c) {
  const fmt = c.opts.get('format') ?? '';
  const target = c.args[0] ?? '';
  if (!target) {
    printError('nothing to inspect', 'missing <layout-dir|name>', 'run `pimg inspect <oci-layout-dir>`');
    return 1;
  }
  const { loaded } = resolveImageDir(g, target);
  if (!loaded.ok) {
    printError(`cannot inspect '${target}'`, loaded.err, 'pass an image name or a directory containing oci-layout + index.json + blobs/sha256/*');
    return 1;
  }
  const mans = loaded.manifests;
  if (g.out.json || fmt === 'json') {
    process.stdout.write(`{"version":1,"layout":"${target}","manifests":[${mans.map((m) => `{"digest":"${m.digest}","layers":${m.layers.length}}`).join(',')}]}\n`);
    return 0;
  }
  process.stdout.write(`layout: ${cyan(target)}\n`);
  process.stdout.write(`manifests: ${mans.length} (all digests ${green('verified')})\n`);
  const rows = mans.map((m) => {
    const plat = !m.config.platformOs ? '-' : `${m.config.platformOs}/${m.config.platformArch}`;
    return [`${m.digest.slice(0, 19)}...`, String(m.layers.length), plat];
  });
  process.stdout.write(renderTable(['MANIFEST', 'LAYERS', 'PLATFORM'], rows));
  process.stdout.write(dim('isolation: n/a (image only; see `pimg doctor` for runtime backends)\n'));
  return 0;
}

function cmdDigest(c) {
  if (!c.args.length) {
    printError('missing file', 'usage: pimg digest <file> [--expect sha256:...]', '');
    return 1;
  }
  const file = c.args[0];
  const d = digestOfFile(file);
  if (!d.ok) {
    printError(`cannot hash '${file}'`, d.err, 'check the path');
    return 1;
  }
  const expect = c.opts.get('expect') ?? '';
  if (expect) {
    const v = verifyFile(file, expect);
    if (!v.ok) {
      printError(`digest mismatch for '${file}'`, v.err, 'refusing to proceed');
      return 1;
    }
    printSuccess(`${d.digest} (verified)`);
    return 0;
  }
  process.stdout.write(`${d.digest}  ${file}\n`);
  return 0;
}

// ---- Phase 2: image distribution ----

async function cmdPull(g, c) {
  const ref = c.args[0] ?? '';
  if (!ref) {
    printError('missing reference', 'usage: pimg pull <ref> [--platform os/arch] [--plain-http]', '');
    return 1;
  }
  const plat = c.opts.get('platform') ?? '';
  const platform = plat.includes('/') ? { os: plat.split('/')[0], arch: plat.split('/')[1] } : null;
  try {
    const e = await pullImage(g.home, ref, { platform, plainHttp: c.hasOpt('plain-http') });
    printSuccess(`pulled ${e.name} (${e.digest.slice(0, 19)}...)`);
    return 0;
  } catch (e) {
    printError(`cannot pull '${ref}'`, e.message, 'check the reference and network; --plain-http for local registries');
    return 1;
  }
}

async function cmdPush(g, c) {
  const name = c.args[0] ?? '';
  if (!name) {
    printError('missing image', 'usage: pimg push <name> [--plain-http]', '');
    return 1;
  }
  try {
    const digest = await pushImage(g.home, name, { plainHttp: c.hasOpt('plain-http') });
    printSuccess(`pushed ${name}${digest ? ` (${digest.slice(0, 19)}...)` : ''}`);
    return 0;
  } catch (e) {
    printError(`cannot push '${name}'`, e.message, 'set PIMG_REGISTRY_USER/PIMG_REGISTRY_PASS for private registries');
    return 1;
  }
}

function cmdTag(g, c) {
  if (c.args.length < 2) {
    printError('missing args', 'usage: pimg tag SRC DST', '');
    return 1;
  }
  try {
    tagImage(g.home, c.args[0], c.args[1]);
    printSuccess(`tagged ${c.args[1]}`);
    return 0;
  } catch (e) {
    printError(`cannot tag`, e.message, '');
    return 1;
  }
}

function cmdRmi(g, c) {
  if (!c.args.length) {
    printError('missing image', 'usage: pimg rmi <image>', '');
    return 1;
  }
  try {
    removeImage(g.home, c.args[0]);
    printSuccess(`removed ${c.args[0]}`);
    return 0;
  } catch (e) {
    printError(`cannot remove`, e.message, '');
    return 1;
  }
}

function cmdHistory(g, c) {
  if (!c.args.length) {
    printError('missing image', 'usage: pimg history <image>', '');
    return 1;
  }
  try {
    const rows = imageHistory(g.home, c.args[0]).map((l) => [
      l.kind, `${l.digest.slice(0, 19)}...`, l.size >= 0 ? String(l.size) : '-',
    ]);
    process.stdout.write(renderTable(['KIND', 'DIGEST', 'SIZE'], rows));
    return 0;
  } catch (e) {
    printError(`cannot show history`, e.message, '');
    return 1;
  }
}

async function cmdSave(g, c) {
  if (c.args.length < 1) {
    printError('missing args', 'usage: pimg save <image> [-o FILE]', '');
    return 1;
  }
  const dest = c.opts.get('o') ?? c.opts.get('output') ?? `${c.args[0].replace(/[^A-Za-z0-9_.-]/g, '_')}.tar`;
  try {
    const r = await saveImage(g.home, c.args[0], dest);
    printSuccess(`saved ${c.args[0]} -> ${dest} (${r.files} files, ${r.bytes} bytes)`);
    return 0;
  } catch (e) {
    printError(`cannot save`, e.message, '');
    return 1;
  }
}

async function cmdLoad(g, c) {
  if (!c.args.length) {
    printError('missing file', 'usage: pimg load <file.tar>', '');
    return 1;
  }
  try {
    const bar = new ProgressBar(`load ${c.args[0]}`, 100);
    const r = await loadImage(g.home, c.args[0], { onProgress: ({ done, total }) => bar.update(Math.floor((done / Math.max(1, total)) * 100)) });
    bar.finish();
    printSuccess(`loaded ${r.name}`);
    return 0;
  } catch (e) {
    printError(`cannot load`, e.message, 'pass a tar produced by `pimg save`');
    return 1;
  }
}

function cmdPrune(g) {
  const r = pruneStore(g.home);
  printSuccess(`pruned ${r.blobs} blobs (${r.bytes} bytes)`);
  return 0;
}

// ---- Phase 3: emulated runtime ----

function cmdRun(g, c) {
  const name = c.opts.get('name') ?? '';
  const image = c.args[0] ?? 'scratch';
  const cmd = c.args.slice(1);
  const env = {};
  const pushEnv = (k) => {
    const v = c.opts.get(k);
    if (v !== undefined && v !== 'true') {
      const eq = v.indexOf('=');
      if (eq !== -1) env[v.slice(0, eq)] = v.slice(eq + 1);
    }
  };
  // -e may repeat; our Map keeps the last — document single -e for now.
  pushEnv('e');
  const vols = [];
  if (c.opts.get('v')) vols.push(c.opts.get('v'));
  try {
    const r = runContainer(g.home, { name, image, command: cmd, env });
    if (vols.length) printWarn(`volume mounts are recorded, not enforced, by the emulated backend: ${vols.join(', ')}`);
    printSuccess(`started ${r.name}${r.pid ? ` (pid ${r.pid})` : ''} [emulated]`);
    return 0;
  } catch (e) {
    printError(`cannot run`, e.message, 'pass --name <container>');
    return 1;
  }
}

function cmdPs(g, c) {
  const store = Store.resolve(g.home);
  store.init();
  const all = listContainers(store);
  const rows = (c.hasOpt('a') ? all : all.filter((x) => x.status === 'running'))
    .map((x) => [x.name, x.status, x.image, x.pid ? String(x.pid) : '-']);
  if (g.out.json) {
    process.stdout.write(JSON.stringify({ version: 1, containers: all }) + '\n');
    return 0;
  }
  if (!rows.length) {
    process.stdout.write(dim('no containers (use -a for all, `pimg run` to start one)\n'));
    return 0;
  }
  process.stdout.write(renderTable(['NAME', 'STATUS', 'IMAGE', 'PID'], rows));
  return 0;
}

function cmdContainerOp(g, c, op) {
  const name = c.args[0] ?? '';
  if (!name) {
    printError('missing container', `usage: pimg ${op} <name>`, '');
    return 1;
  }
  try {
    if (op === 'start') startContainer(g.home, name);
    else if (op === 'stop' || op === 'kill') stopContainer(g.home, name, { signal: op === 'kill' ? 'SIGKILL' : 'SIGTERM' });
    else if (op === 'rm') removeContainer(g.home, name, { force: c.hasOpt('force') || c.hasOpt('f') });
    printSuccess(`${op} ${name}`);
    return 0;
  } catch (e) {
    printError(`cannot ${op} '${name}'`, e.message, '');
    return 1;
  }
}

function cmdContainerLogs(g, c) {
  const name = c.args[0] ?? '';
  if (!name) {
    printError('missing container', 'usage: pimg logs <name> [--tail N]', '');
    return 1;
  }
  const tail = parseInt(c.opts.get('tail') ?? '100', 10) || 100;
  const lines = containerLogs(g.home, name, { tail });
  if (g.out.json) {
    process.stdout.write(JSON.stringify({ version: 1, container: name, logs: lines }) + '\n');
    return 0;
  }
  for (const l of lines) process.stdout.write(l + '\n');
  return 0;
}

function cmdStats(g) {
  const s = sampleLiveStats();
  if (g.out.json) {
    process.stdout.write(JSON.stringify({
      version: 1,
      cpuPct: s.cpuAvailable ? Math.round(s.cpuPct * 10) / 10 : null,
      cpuAvailable: s.cpuAvailable,
      memPct: Math.round(s.memPct * 10) / 10,
    }) + '\n');
    return 0;
  }
  process.stdout.write(`cpu: ${s.cpuAvailable ? `${s.cpuPct.toFixed(1)}%` : 'n/a (skipped on Android)'}\n`);
  process.stdout.write(`mem: ${s.memPct.toFixed(1)}% (used ${Math.round(memPercent())}% of host)\n`);
  process.stdout.write(`host: ${hostLabel(2)}\n`);
  return 0;
}

// ---- Phase 4: networks + net tools ----

function netFile(store, name) {
  return `${store.networks}/${name.replace(/[^A-Za-z0-9_.-]/g, '_')}.json`;
}

function cmdNetwork(g, c) {
  const store = Store.resolve(g.home);
  store.init();
  const sub = c.sub || c.args[0] || 'ls';
  const arg = c.sub ? c.args[0] : c.args[1];
  try {
    if (sub === 'create') {
      if (!arg) throw new Error('usage: pimg network create <name> [--driver N] [--subnet CIDR]');
      fs.mkdirSync(store.networks, { recursive: true });
      fs.writeFileSync(netFile(store, arg), JSON.stringify({
        name: arg,
        driver: c.opts.get('driver') ?? 'bridge',
        subnet: c.opts.get('subnet') ?? '10.0.0.0/24',
      }, null, 2));
      printSuccess(`created network ${arg}`);
      return 0;
    }
    if (sub === 'rm') {
      fs.rmSync(netFile(store, arg), { force: true });
      printSuccess(`removed network ${arg}`);
      return 0;
    }
    if (sub === 'inspect') {
      const j = JSON.parse(fs.readFileSync(netFile(store, arg), 'utf8'));
      process.stdout.write(JSON.stringify({ version: 1, network: j }, null, g.out.json ? 0 : 2) + '\n');
      return 0;
    }
    // ls
    let files = [];
    try {
      files = fs.readdirSync(store.networks).filter((f) => f.endsWith('.json'));
    } catch { /* none */ }
    const rows = files.map((f) => {
      try {
        const j = JSON.parse(fs.readFileSync(`${store.networks}/${f}`, 'utf8'));
        return [j.name, j.driver ?? 'bridge', j.subnet ?? '-'];
      } catch {
        return [f, '?', '-'];
      }
    });
    if (g.out.json) {
      process.stdout.write(JSON.stringify({ version: 1, networks: rows.map((r) => ({ name: r[0], driver: r[1], subnet: r[2] })) }) + '\n');
      return 0;
    }
    if (!rows.length) process.stdout.write(dim('no networks\n'));
    else process.stdout.write(renderTable(['NAME', 'DRIVER', 'SUBNET'], rows));
    return 0;
  } catch (e) {
    printError(`network ${sub} failed`, e.message, '');
    return 1;
  }
}

async function cmdNet(g, c) {
  const sub = c.sub || c.args[0] || '';
  const rest = c.sub ? c.args : c.args.slice(1);
  try {
    if (sub === 'ping') {
      const [host = '', portStr = '80'] = (rest[0] ?? '').split(':');
      if (!host) throw new Error('usage: pimg net ping <host>[:port]');
      const r = await pingTcp(host, parseInt(portStr, 10) || 80);
      if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, ...r }) + '\n');
      else process.stdout.write(r.ok ? `${r.host}:${r.port} open (${r.ms}ms)\n` : `${r.host}:${r.port} closed (${r.error})\n`);
      return r.ok ? 0 : 1;
    }
    if (sub === 'dns') {
      if (!rest[0]) throw new Error('usage: pimg net dns <name>');
      const r = await dnsLookup(rest[0]);
      if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, ...r }) + '\n');
      else if (r.ok) process.stdout.write(`${r.name} -> ${r.addresses.map((a) => a.address).join(', ')} (${r.ms}ms)\n`);
      else printError(`dns failed`, r.error, '');
      return r.ok ? 0 : 1;
    }
    if (sub === 'http') {
      if (!rest[0]) throw new Error('usage: pimg net http <url>');
      const r = await httpProbe(rest[0]);
      if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, ...r }) + '\n');
      else process.stdout.write(`${r.url} -> ${r.status} (${r.bytes}B, ${r.ms}ms)${r.error ? ` ${r.error}` : ''}\n`);
      return r.ok ? 0 : 1;
    }
    if (sub === 'scan') {
      const [host, portsStr] = [rest[0], rest[1] ?? '80,443'];
      if (!host) throw new Error('usage: pimg net scan <host> [p1,p2,..]');
      const ports = portsStr.split(',').map((p) => parseInt(p, 10)).filter(Boolean);
      const rows = (await scanPorts(host, ports)).map((r) => [`${host}:${r.port}`, r.open ? green('open') : dim('closed'), r.ms >= 0 ? `${r.ms}ms` : '-']);
      process.stdout.write(renderTable(['TARGET', 'STATE', 'RTT'], rows));
      return 0;
    }
    if (sub === 'listen' || sub === 'nc' || sub === 'trace' || sub === 'bandwidth' || sub === 'port-forward') {
      printError(`'net ${sub}' is not implemented yet`, 'phase 4 (networking) has not landed in this build', 'available now: ping, dns, http, scan');
      return 2;
    }
    printError(`unknown net tool '${sub}'`, '', 'try: ping, dns, http, scan');
    return 1;
  } catch (e) {
    printError(`net ${sub} failed`, e.message, '');
    return 1;
  }
}

// ---- Phase 6: cluster ----

function cmdCluster(g, c) {
  const store = Store.resolve(g.home);
  store.init();
  const sub = c.sub || c.args[0] || 'status';
  try {
    if (sub === 'init') {
      clusterInit(g.home);
      printSuccess('cluster initialized (single node: node0)');
      return 0;
    }
    const cl = readCluster(store);
    if (!cl.initialized) throw new Error('no cluster (run `pimg cluster init`)');
    if (sub === 'status' || sub === 'nodes') {
      if (g.out.json) {
        process.stdout.write(JSON.stringify({ version: 1, node: cl.node, deployments: cl.deployments }) + '\n');
        return 0;
      }
      process.stdout.write(`node: ${cyan(cl.node)} (single-node, file-backed)\n`);
      const rows = cl.deployments.map((d) => [d.name, d.image, String(d.replicas ?? 0)]);
      if (!rows.length) process.stdout.write(dim('no deployments\n'));
      else process.stdout.write(renderTable(['DEPLOYMENT', 'IMAGE', 'REPLICAS'], rows));
      return 0;
    }
    if (sub === 'join' || sub === 'leave') {
      printError(`'cluster ${sub}' moved`, 'nodes join with `pimg agent --server URL --node NAME`', 'see `pimg nodes` and docs/CLUSTER.md');
      return 2;
    }
    printError(`unknown cluster subcommand '${sub}'`, '', 'try: init, status, nodes');
    return 1;
  } catch (e) {
    printError(`cluster ${sub} failed`, e.message, '');
    return 1;
  }
}

function cmdApplyDeleteDiff(g, c, op) {
  const file = c.opts.get('f') ?? c.opts.get('file') ?? c.args[0] ?? '';
  if (!file && op !== 'delete-by-name') {
    printError('missing file', `usage: pimg ${op} -f FILE`, '');
    return 1;
  }
  try {
    if (op === 'apply') {
      const r = applyManifest(g.home, file);
      for (const d of r) {
        // git-like commit: every apply is a recorded revision.
        try {
          recordRevision(g.home, d.name, {
            image: d.image,
            replicas: d.replicas,
            command: d.command ?? [],
            nodeSelector: d.nodeSelector ?? {},
          });
        } catch { /* already recorded */ }
        printSuccess(`applied deployment/${d.name} (replicas=${d.replicas})`);
      }
      return 0;
    }
    if (op === 'delete') {
      if (file) {
        const m = JSON.parse(fs.readFileSync(file, 'utf8'));
        for (const d of m?.deployments ?? []) {
          const r = deleteDeployment(g.home, d.name);
          printSuccess(`deleted deployment/${d.name} (${r.removed} members)`);
        }
        return 0;
      }
      const name = c.args[0] ?? '';
      if (!name) throw new Error('usage: pimg delete -f FILE | pimg delete <deployment>');
      const r = deleteDeployment(g.home, name);
      printSuccess(`deleted deployment/${name} (${r.removed} members)`);
      return 0;
    }
    for (const l of diffManifest(g.home, file)) process.stdout.write(l + '\n');
    return 0;
  } catch (e) {
    printError(`${op} failed`, e.message, '');
    return 1;
  }
}

function cmdGetDescribe(g, c, op) {
  const store = Store.resolve(g.home);
  store.init();
  const kind = (c.args[0] ?? '').toLowerCase();
  const name = c.args[1] ?? '';
  const singular = kind.replace(/s$/, '');
  try {
    const collect = () => {
      if (['deployment', 'deploy'].includes(singular)) {
        return readCluster(store).deployments.map((d) => ({ kind: 'deployment', name: d.name, detail: `image=${d.image} replicas=${d.replicas ?? 0}`, raw: d }));
      }
      if (['container'].includes(singular)) {
        return listContainers(store).map((x) => ({ kind: 'container', name: x.name, detail: `${x.status} ${x.image}`, raw: x }));
      }
      if (['image'].includes(singular)) {
        return listImages(store).images.map((e) => ({ kind: 'image', name: e.name, detail: e.digest, raw: e }));
      }
      if (['network'].includes(singular)) {
        let files = [];
        try {
          files = fs.readdirSync(store.networks).filter((f) => f.endsWith('.json'));
        } catch { /* none */ }
        return files.map((f) => {
          const j = JSON.parse(fs.readFileSync(`${store.networks}/${f}`, 'utf8'));
          return { kind: 'network', name: j.name, detail: `${j.driver} ${j.subnet}`, raw: j };
        });
      }
      throw new Error(`unknown kind '${kind}' (try: deployments, containers, images, networks)`);
    };
    const items = collect().filter((e) => !name || e.name === name);
    if (name && !items.length) throw new Error(`${singular} '${name}' not found`);
    if (g.out.json || op === 'describe') {
      process.stdout.write(JSON.stringify({ version: 1, items: items.map((e) => ({ kind: e.kind, name: e.name, ...e.raw })) }, null, g.out.json ? 0 : 2) + '\n');
      return 0;
    }
    process.stdout.write(renderTable(['KIND', 'NAME', 'DETAIL'], items.map((e) => [e.kind, e.name, e.detail])));
    return 0;
  } catch (e) {
    printError(`${op} failed`, e.message, '');
    return 1;
  }
}

function cmdScale(g, c) {
  const name = c.args[0] ?? '';
  const replicas = parseInt(c.opts.get('replicas') ?? c.opts.get('r') ?? '', 10);
  if (!name || !Number.isInteger(replicas)) {
    printError('missing args', 'usage: pimg scale <deployment> --replicas N', '');
    return 1;
  }
  try {
    const d = scaleDeployment(g.home, name, replicas);
    try {
      recordRevision(g.home, d.name, {
        image: d.image,
        replicas: d.replicas,
        command: d.command ?? [],
        nodeSelector: d.nodeSelector ?? {},
      });
    } catch { /* already recorded */ }
    printSuccess(`scaled deployment/${d.name} to ${d.replicas}`);
    return 0;
  } catch (e) {
    printError(`scale failed`, e.message, '');
    return 1;
  }
}

// ---- server / client (kubernetes-style) ----

async function cmdServe(g, c) {
  const port = parseInt(c.opts.get('port') ?? c.opts.get('p') ?? '8443', 10) || 8443;
  const bind = c.opts.get('bind') ?? c.opts.get('host') ?? '127.0.0.1';
  try {
    const { adminToken } = await serveCluster(g.home, { port, bind });
    process.stdout.write(`pimg api server on http://${bind}:${port} (home: ${Store.resolve(g.home).home})\n`);
    if (adminToken) {
      process.stdout.write(`admin token (shown once — save it):\n  ${adminToken}\n`);
      process.stdout.write(`hint: pimg login --server http://${bind}:${port} --token <above>\n`);
    }
    process.stdout.write('press Ctrl+C to stop.\n');
    await new Promise(() => {});
    return 0;
  } catch (e) {
    printError('cannot serve', e.message, 'is the port already in use?');
    return 1;
  }
}

function cmdLogin(g, c) {
  const server = c.opts.get('server') ?? c.args[0] ?? '';
  const token = c.opts.get('token') ?? '';
  if (!server) {
    printError('missing server', 'usage: pimg login --server URL [--token TOKEN]', '');
    return 1;
  }
  const cfg = loadConfig(g.home);
  saveConfig(g.home, { server: server.replace(/\/$/, ''), token: token || cfg.token || '' });
  printSuccess(`context saved (server: ${server})${token ? '' : ' — no token stored'}`);
  return 0;
}

async function cmdAgent(g, c) {
  const { server, token } = resolveServer(g.home, c.opts);
  const node = c.opts.get('node') ?? c.opts.get('name') ?? c.args[0] ?? '';
  const labels = {};
  for (const kv of (c.opts.get('labels') ?? '').split(',').filter(Boolean)) {
    const eq = kv.indexOf('=');
    if (eq !== -1) labels[kv.slice(0, eq)] = kv.slice(eq + 1);
  }
  const interval = parseInt(c.opts.get('interval') ?? '5000', 10) || 5000;
  if (!server || !node) {
    printError('missing args', 'usage: pimg agent --server URL --node NAME [--labels k=v,..]', 'join with a node-agent token (see `pimg rbac token`)');
    return 1;
  }
  process.stdout.write(`agent ${node} -> ${server} (every ${interval}ms, Ctrl+C to leave)\n`);
  try {
    await runAgent({
      server, token, home: g.home, node, labels, interval,
      onTick: (e, st) => {
        if (e) process.stderr.write(`agent: ${e.message}\n`);
        else if (process.env.PIMG_AGENT_VERBOSE) process.stdout.write(`agent: ${st.units} assigned, ${st.running} running\n`);
      },
    });
    return 0;
  } catch (e) {
    printError('agent failed', e.message, 'is the server reachable and the token valid?');
    return 1;
  }
}

function cmdNodes(g, c) {
  const remote = useRemote(g, c);
  if (remote) {
    return (async () => {
      try {
        return showNodes(g, (await serverApi(remote.server, remote.token, 'GET', '/api/nodes')).nodes);
      } catch (e) {
        printError('nodes failed', e.message, '');
        return 1;
      }
    })();
  }
  const store = Store.resolve(g.home);
  store.init();
  return showNodes(g, readCluster(store).nodes ?? []);
}

function showNodes(g, nodes) {
  if (g.out.json) {
    process.stdout.write(JSON.stringify({ version: 1, nodes }) + '\n');
    return 0;
  }
  const rows = nodes.map((n) => [
    n.name,
    nodeReady(n) ? green('Ready') : dim('NotReady'),
    String(n.capacity?.cpu ?? '?'),
    n.capacity?.mem ? `${Math.round(n.capacity.mem / 1024 / 1024)}M` : '?',
    Object.entries(n.labels ?? {}).map(([k, v]) => `${k}=${v}`).join(',') || '-',
  ]);
  if (!rows.length) {
    process.stdout.write(dim('no nodes (run `pimg agent --server URL --node NAME` to join)\n'));
    return 0;
  }
  process.stdout.write(renderTable(['NAME', 'STATUS', 'CPU', 'MEM', 'LABELS'], rows));
  return 0;
}

async function cmdTop(g, c) {
  const remote = useRemote(g, c);
  const show = (nodes, units) => {
    const pool = poolCapacity(nodes, units);
    if (g.out.json) {
      process.stdout.write(JSON.stringify({ version: 1, pool, nodes }) + '\n');
      return 0;
    }
    const pct = (u, t) => (t > 0 ? `${Math.round((u / t) * 100)}%` : '-');
    process.stdout.write(`nodes: ${pool.total.nodes} ready, units: ${pool.used.units} assigned\n`);
    process.stdout.write(`cpu: ${pool.used.cpu}/${pool.total.cpu} (${pct(pool.used.cpu, pool.total.cpu)})\n`);
    process.stdout.write(`mem: ${Math.round(pool.used.mem / 1024 / 1024)}M/${Math.round(pool.total.mem / 1024 / 1024)}M (${pct(pool.used.mem, pool.total.mem)})\n`);
    const rows = (nodes ?? []).map((n) => [
      n.name,
      nodeReady(n) ? green('Ready') : dim('NotReady'),
      `${n.used?.cpu ?? 0}/${n.capacity?.cpu ?? '?'}`,
      `${Math.round(((n.used?.mem ?? 0) / 1024 / 1024))}M/${n.capacity?.mem ? `${Math.round(n.capacity.mem / 1024 / 1024)}M` : '?'}`,
      String((units ?? []).filter((x) => x.node === n.name).length),
    ]);
    if (rows.length) process.stdout.write(renderTable(['NODE', 'STATUS', 'CPU', 'MEM', 'UNITS'], rows));
    return 0;
  };
  if (remote) {
    try {
      const [n, u] = await Promise.all([
        serverApi(remote.server, remote.token, 'GET', '/api/nodes'),
        serverApi(remote.server, remote.token, 'GET', '/api/units'),
      ]);
      return show(n.nodes, u.units);
    } catch (e) {
      printError('cluster top failed', e.message, '');
      return 1;
    }
  }
  const store = Store.resolve(g.home);
  store.init();
  const cl = readCluster(store);
  return show(cl.nodes ?? [], cl.units ?? []);
}

function cmdRevision(g, c) {
  const remote = useRemote(g, c);
  const sub = c.sub || c.args[0] || 'list';
  const rest = c.sub ? c.args : c.args.slice(1);
  const run = async () => {
    if (remote) {
      const { server, token } = remote;
      if (sub === 'list') {
        const r = await serverApi(server, token, 'GET', `/api/revisions/${encodeURIComponent(rest[0] ?? '')}`);
        if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, ...r }) + '\n');
        else {
          process.stdout.write(renderTable(['ID', 'TIME', 'IMAGE', 'REPLICAS'],
            r.revisions.map((x) => [String(x.id), x.ts ?? '', x.manifest?.image ?? '', String(x.manifest?.replicas ?? '')])));
        }
        return 0;
      }
      if (sub === 'rollback') {
        const r = await serverApi(server, token, 'POST', `/api/revisions/${encodeURIComponent(rest[0] ?? '')}/rollback/${encodeURIComponent(rest[1] ?? '')}`);
        printSuccess(`rolled back ${r.deployment} to revision ${r.from} (new revision ${r.to})`);
        return 0;
      }
      printError(`unknown revision subcommand '${sub}'`, '', 'try: list, rollback');
      return 1;
    }
    const [name, id] = rest;
    if (!name && sub !== 'list') throw new Error('usage: pimg revision list <dep> | pimg revision rollback <dep> <id>');
    if (sub === 'list') {
      const revs = listRevisions(g.home, name ?? rest[0]);
      if (g.out.json) {
        process.stdout.write(JSON.stringify({ version: 1, revisions: revs }) + '\n');
        return 0;
      }
      process.stdout.write(renderTable(['ID', 'TIME', 'IMAGE', 'REPLICAS'],
        revs.map((x) => [String(x.id), x.ts ?? '', x.manifest?.image ?? '', String(x.manifest?.replicas ?? '')])));
      return 0;
    }
    if (sub === 'rollback') {
      const r = rollbackRevision(g.home, name, id);
      // Reconcile local members to the restored replica count.
      const { scaleDeployment: sd } = await import('./cluster.js');
      sd(g.home, r.deployment, r.manifest.replicas ?? 0);
      printSuccess(`rolled back ${r.deployment} to revision ${r.from} (new revision ${r.to})`);
      return 0;
    }
    if (sub === 'diff') {
      const { diffRevisions: dr } = await import('./revisions.js');
      const lines = dr(g.home, name, rest[1], rest[2]);
      if (!lines.length) process.stdout.write(dim('no differences\n'));
      else for (const l of lines) process.stdout.write(l + '\n');
      return 0;
    }
    printError(`unknown revision subcommand '${sub}'`, '', 'try: list, diff, rollback');
    return 1;
  };
  return run().catch((e) => {
    printError('revision failed', e.message, '');
    return 1;
  });
}

function cmdRbac(g, c) {
  const remote = useRemote(g, c);
  const sub = c.args[0] ?? 'list';
  const run = async () => {
    if (remote) {
      const { server, token } = remote;
      if (sub === 'list') {
        const r = await serverApi(server, token, 'GET', '/api/rbac');
        if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, ...r }) + '\n');
        else {
          process.stdout.write(renderTable(['USER', 'ROLES'], r.bindings.reduce((acc, b) => {
            const row = acc.find((x) => x[0] === b.user);
            if (row) row[1] += `,${b.role}`;
            else acc.push([b.user, b.role]);
            return acc;
          }, [])));
        }
        return 0;
      }
      if (sub === 'user') {
        const r = await serverApi(server, token, 'POST', '/api/rbac/users', { name: c.args[1] });
        printSuccess(`user ${r.user} created`);
        return 0;
      }
      if (sub === 'token') {
        const r = await serverApi(server, token, 'POST', '/api/rbac/tokens', { user: c.args[1] });
        process.stdout.write(`token for ${r.user} (shown once):\n  ${r.token}\n`);
        return 0;
      }
      if (sub === 'grant') {
        const r = await serverApi(server, token, 'POST', '/api/rbac/grants', { user: c.args[1], role: c.args[2] });
        printSuccess(`granted ${r.role} to ${r.user}`);
        return 0;
      }
      printError(`unknown rbac subcommand '${sub}'`, '', 'try: list, user, token, grant');
      return 1;
    }
    // Local file mode (pre-seed auth.json before first `serve`).
    bootstrapAuth(g.home);
    if (sub === 'list') {
      const a = readAuth(Store.resolve(g.home));
      if (g.out.json) {
        process.stdout.write(JSON.stringify({ version: 1, users: Object.keys(a.users), roles: a.roles, bindings: a.bindings }) + '\n');
        return 0;
      }
      process.stdout.write(renderTable(['USER', 'ROLES'],
        Object.keys(a.users).map((u) => [u, userRoles(g.home, u).join(',') || '-'])));
      return 0;
    }
    if (sub === 'user') {
      printSuccess(`user ${createUser(g.home, c.args[1])} created`);
      return 0;
    }
    if (sub === 'token') {
      const t = mintToken(g.home, c.args[1]);
      process.stdout.write(`token for ${c.args[1]} (shown once):\n  ${t}\n`);
      return 0;
    }
    if (sub === 'grant') {
      const r = grantRole(g.home, c.args[1], c.args[2]);
      printSuccess(`granted ${r.role} to ${r.user}`);
      return 0;
    }
    printError(`unknown rbac subcommand '${sub}'`, '', 'try: list, user, token, grant');
    return 1;
  };
  return run().catch((e) => {
    printError('rbac failed', e.message, '');
    return 1;
  });
}

// Remote mode: --server flag > PIMG_SERVER env > saved login, unless --local.
function useRemote(g, c) {
  if (c.hasOpt('local')) return null;
  const { server, token } = resolveServer(g.home, c.opts);
  return server ? { server, token } : null;
}

async function remoteGet(g, remote, kind, name) {
  const { server, token } = remote;
  const k = (kind ?? '').toLowerCase();
  if (k === 'deployments' || k === 'deployment' || k === 'deploy' || !k) {
    const r = await serverApi(server, token, 'GET', '/api/deployments');
    const items = r.deployments.filter((d) => !name || d.name === name);
    if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, items }) + '\n');
    else {
      process.stdout.write(renderTable(['NAME', 'IMAGE', 'REPLICAS'],
        items.map((d) => [d.name, d.image, String(d.replicas ?? 0)])));
    }
    return 0;
  }
  if (k === 'units' || k === 'unit' || k === 'pods' || k === 'pod') {
    const r = await serverApi(server, token, 'GET', '/api/units');
    const items = r.units.filter((x) => !name || x.id === name);
    if (g.out.json) process.stdout.write(JSON.stringify({ version: 1, items }) + '\n');
    else {
      process.stdout.write(renderTable(['UNIT', 'STATUS', 'NODE', 'IMAGE'],
        items.map((x) => [x.id, x.status ?? 'Pending', x.node ?? '-', x.image])));
    }
    return 0;
  }
  if (k === 'nodes' || k === 'node') {
    const r = await serverApi(server, token, 'GET', '/api/nodes');
    return showNodes(g, r.nodes);
  }
  throw new Error(`unknown kind '${kind}' (try: deployments, units, nodes)`);
}

async function remoteApply(g, remote, c) {
  const file = c.opts.get('f') ?? c.opts.get('file') ?? c.args[0] ?? '';
  if (!file) throw new Error('usage: pimg apply -f FILE');
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  const r = await serverApi(remote.server, remote.token, 'POST', '/api/apply', { deployments: m.deployments });
  for (const d of r.applied) printSuccess(`applied deployment/${d.name} (revision ${d.revision}, ${r.units} units scheduled)`);
  return 0;
}

async function remoteDelete(g, remote, c) {
  const name = c.opts.get('f') ? null : c.args[0];
  if (c.opts.get('f') ?? c.opts.get('file')) {
    const m = JSON.parse(fs.readFileSync(c.opts.get('f') ?? c.opts.get('file'), 'utf8'));
    for (const d of m?.deployments ?? []) {
      await serverApi(remote.server, remote.token, 'DELETE', `/api/deployments/${encodeURIComponent(d.name)}`);
      printSuccess(`deleted deployment/${d.name}`);
    }
    return 0;
  }
  if (!name) throw new Error('usage: pimg delete -f FILE | pimg delete <deployment>');
  await serverApi(remote.server, remote.token, 'DELETE', `/api/deployments/${encodeURIComponent(name)}`);
  printSuccess(`deleted deployment/${name}`);
  return 0;
}

async function remoteScale(g, remote, c) {
  const name = c.args[0] ?? '';
  const replicas = parseInt(c.opts.get('replicas') ?? c.opts.get('r') ?? '', 10);
  if (!name || !Number.isInteger(replicas)) throw new Error('usage: pimg scale <deployment> --replicas N');
  const r = await serverApi(remote.server, remote.token, 'POST', `/api/deployments/${encodeURIComponent(name)}/scale`, { replicas });
  printSuccess(`scaled deployment/${r.name} to ${r.replicas} (${r.units} units)`);
  return 0;
}

async function remoteCluster(g, remote, c) {
  const sub = c.sub || 'status';
  if (sub === 'status' || sub === 'nodes' || sub === 'top') return cmdTop(g, c);
  throw new Error(`unknown cluster subcommand '${sub}'`);
}

function remoteDiff(g, remote, c) {
  const file = c.opts.get('f') ?? c.opts.get('file') ?? c.args[0] ?? '';
  if (!file) throw new Error('usage: pimg diff -f FILE');
  return (async () => {
    const m = JSON.parse(fs.readFileSync(file, 'utf8'));
    const r = await serverApi(remote.server, remote.token, 'GET', '/api/deployments');
    const lines = [];
    for (const d of m?.deployments ?? []) {
      const cur = r.deployments.find((x) => x.name === d.name);
      if (!cur) lines.push(`+ deployment/${d.name} image=${d.image} replicas=${d.replicas ?? 1} (new)`);
      else {
        if (cur.image !== d.image) lines.push(`~ deployment/${d.name} image: ${cur.image} -> ${d.image}`);
        if (d.replicas !== undefined && cur.replicas !== d.replicas) {
          lines.push(`~ deployment/${d.name} replicas: ${cur.replicas} -> ${d.replicas}`);
        }
        if (!lines.some((l) => l.includes(d.name))) lines.push(`= deployment/${d.name} up to date`);
      }
    }
    for (const l of lines) process.stdout.write(l + '\n');
    return 0;
  })();
}

// ---- plugins ----

async function cmdPlugin(g, c) {
  const sub = c.args[0] ?? 'list';
  try {
    if (sub === 'list') {
      const found = discoverPlugins(g.home);
      if (g.out.json) {
        process.stdout.write(JSON.stringify({ version: 1, plugins: found }) + '\n');
        return 0;
      }
      if (!found.length) {
        process.stdout.write(dim(`no plugins in ${Store.resolve(g.home).home}/plugins\n`));
        return 0;
      }
      const rows = [];
      for (const p of found) {
        const mod = await loadPlugin(g.home, p.name).catch(() => null);
        const cmds = mod ? Object.keys(mod.commands).join(', ') : dim('(failed to load)');
        rows.push([p.name, p.version || '-', cmds]);
      }
      process.stdout.write(renderTable(['PLUGIN', 'VERSION', 'COMMANDS'], rows));
      return 0;
    }
    if (sub === 'run') {
      const [pname, pcmd, ...rest] = c.args.slice(1);
      if (!pname || !pcmd) throw new Error('usage: pimg plugin run <plugin> <command> [args]');
      const code = await dispatchPlugin(g.home, pname, pcmd, rest, c.opts, g.out.json);
      if (code === null) throw new Error(`no such plugin '${pname}'`);
      return code;
    }
    printError(`unknown plugin subcommand '${sub}'`, '', 'try: list, run');
    return 1;
  } catch (e) {
    printError(`plugin ${sub} failed`, e.message, 'see docs/PLUGINS.md');
    return 1;
  }
}

// Parse argv (without node/bin) into { global, cmd, sub, args, opts }.
export function parseArgs(rest) {
  const g = { out: { json: false, noColor: false, quiet: false, verbose: false }, yes: false, home: '', context: '' };
  const filtered = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--json') g.out.json = true;
    else if (a === '--no-color') g.out.noColor = true;
    else if (a === '--quiet' || a === '-q') g.out.quiet = true;
    else if (a === '--verbose' || a === '-v') g.out.verbose = true;
    else if (a === '--yes' || a === '-y') g.yes = true;
    else if (a === '--home' && i + 1 < rest.length) g.home = rest[++i];
    else if (a.startsWith('--home=')) g.home = a.slice(7);
    else if (a === '--context' && i + 1 < rest.length) g.context = rest[++i];
    else if (a === '--version' || a === '-V') return { early: 'version', g };
    else if (a === '--help' || a === '-h' || a === 'help') {
      return { early: 'help', topic: rest[i + 1] ?? '', g };
    } else filtered.push(a);
  }
  if (!filtered.length) return { early: 'help', topic: '', g };
  const cmd = filtered[0];
  let k = 1;
  let sub = '';
  if ((cmd === 'network' || cmd === 'net' || cmd === 'cluster' || cmd === 'rollout') && k < filtered.length) {
    sub = filtered[k++];
  }
  const args = [];
  const opts = new Map();
  // Long flags that never take a value (never consume the next token).
  const BOOLEAN_LONGS = new Set(['force', 'demo', 'snapshot', 'plain-http', 'all', 'a']);
  for (; k < filtered.length; k++) {
    const a = filtered[k];
    if (a === '--') {
      // Everything after `--` is a positional arg (e.g. container commands
      // starting with `-`, which would otherwise parse as flags).
      args.push(...filtered.slice(k + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq !== -1) opts.set(a.slice(2, eq), a.slice(eq + 1));
      else if (BOOLEAN_LONGS.has(a.slice(2))) opts.set(a.slice(2), 'true');
      else if (k + 1 < filtered.length && !filtered[k + 1].startsWith('-')) opts.set(a.slice(2), filtered[++k]);
      else opts.set(a.slice(2), 'true');
    } else if (a.startsWith('-') && a.length === 2) {
      const key = a[1];
      if (k + 1 < filtered.length && !filtered[k + 1].startsWith('-')) opts.set(key, filtered[++k]);
      else opts.set(key, 'true');
    } else args.push(a);
  }
  return { g, cmd, sub, args, opts };
}

export async function cliMain(argv) {
  const parsed = parseArgs(argv);
  outputInit(parsed.g.out);
  if (parsed.early === 'version') { printVersion(); return 0; }
  if (parsed.early === 'help') { printHelp(parsed.topic); return 0; }

  const { g, cmd, sub, args, opts } = parsed;
  const c = { args, opts, sub: sub ?? '', hasOpt: (k) => opts.has(k), optVal: (k, d = '') => opts.get(k) ?? d };

  if (cmd === 'doctor') return cmdDoctor(g.out.json);
  if (cmd === 'images' || cmd === 'image' || cmd === 'ls') return cmdImages(g);
  if (cmd === 'inspect') return cmdInspect(g, c);
  if (cmd === 'digest') return cmdDigest(c);
  if (cmd === 'version' || cmd === '--version') { printVersion(); return 0; }
  if (cmd === 'ui') {
    if (c.hasOpt('snapshot')) {
      const app = new App();
      const want = c.optVal('theme', '');
      if (want) { let guard = 0; while (app.theme().name !== want && guard++ < 8) app.cycleTheme(1); }
      const iset = c.optVal('icons', '');
      if (iset) { let guard = 0; while (iconSetName(app.icons) !== iset && guard++ < 6) app.cycleIcons(1); }
      let cols = parseInt(c.optVal('cols', '100'), 10) || 100;
      let rows = parseInt(c.optVal('rows', '30'), 10) || 30;
      cols = Math.min(300, Math.max(20, cols));
      rows = Math.min(100, Math.max(10, rows));
      const snap = loadSnapshot(g.home, c.hasOpt('demo'));
      snap.isolation = 'emulated';
      process.stdout.write(renderSnapshot(app, snap, cols, rows, 4));
      return 0;
    }
    // Dynamic import: Ink/React load only for interactive mode.
    const { runUI } = await import('./tui/ui.js');
    return runUI(g.home, c.hasOpt('demo'), c.optVal('theme', ''), c.optVal('icons', ''));
  }

  // Phase 2: distribution (real).
  if (cmd === 'pull') return cmdPull(g, c);
  if (cmd === 'push') return cmdPush(g, c);
  if (cmd === 'tag') return cmdTag(g, c);
  if (cmd === 'rmi') return cmdRmi(g, c);
  if (cmd === 'history') return cmdHistory(g, c);
  if (cmd === 'save') return cmdSave(g, c);
  if (cmd === 'load') return cmdLoad(g, c);
  if (cmd === 'prune') return cmdPrune(g);

  // Phase 3: runtime (emulated backend; exec needs a TTY backend).
  if (cmd === 'run') return cmdRun(g, c);
  if (cmd === 'ps') return cmdPs(g, c);
  if (cmd === 'start' || cmd === 'stop' || cmd === 'kill' || cmd === 'rm') return cmdContainerOp(g, c, cmd);
  if (cmd === 'logs') {
    // Container logs win when the name exists; otherwise treat as cluster `get`.
    const store = Store.resolve(g.home);
    let isContainer = false;
    try {
      isContainer = !!c.args[0] && fs.statSync(`${store.containers}/${c.args[0]}`).isDirectory();
    } catch { /* not a container */ }
    if (isContainer || !c.args[0]) return cmdContainerLogs(g, c);
    return cmdGetDescribe(g, c, 'get');
  }
  if (cmd === 'stats') return cmdStats(g);
  if (cmd === 'exec') {
    printError(`'pimg exec' is not implemented yet`, 'attaching a TTY to a supervised process is phase 3 follow-up', 'use `pimg logs <name>` for output today');
    return 2;
  }
  if (cmd === 'pause' || cmd === 'unpause' || cmd === 'restart') {
    printError(`'pimg ${cmd}' is not implemented yet`, 'cgroup freeze + restart policy are phase 3 follow-up', 'use `pimg stop/start` today');
    return 2;
  }

  // Phase 4: networking (real TCP/UDP/DNS probes; no raw sockets).
  if (cmd === 'network') return cmdNetwork(g, c);
  if (cmd === 'net') return cmdNet(g, c);

  // Fleet: server / agent / nodes / roles / revisions (local or remote).
  if (cmd === 'serve') return cmdServe(g, c);
  if (cmd === 'login') return cmdLogin(g, c);
  if (cmd === 'agent') return cmdAgent(g, c);
  if (cmd === 'nodes' || cmd === 'node') return cmdNodes(g, c);
  if (cmd === 'top') return cmdTop(g, c);
  if (cmd === 'revision' || cmd === 'revisions' || cmd === 'rollback') {
    return cmdRevision(g, c.cmd === 'rollback' ? { ...c, sub: 'rollback' } : c);
  }
  if (cmd === 'rbac' || cmd === 'auth') return cmdRbac(g, c);

  // Remote mode: these commands run against the API server when one is
  // configured (--server flag > PIMG_SERVER env > saved login; --local forces local).
  const remote = (['get', 'describe', 'apply', 'delete', 'diff', 'scale', 'cluster'].includes(cmd))
    ? useRemote(g, c)
    : null;
  const guardRemote = (fn) => (remote
    ? fn(g, remote, c).catch((e) => {
      printError('server request failed', e.message, 'is the server up? try `pimg login`');
      return 1;
    })
    : null);

  // Phase 6: single-node cluster (real, file-backed).
  if (cmd === 'cluster') {
    if (c.sub === 'top') return cmdTop(g, c);
    const r = guardRemote(remoteCluster);
    if (r) return r;
    return cmdCluster(g, c);
  }
  if (cmd === 'apply' || cmd === 'diff') {
    const r = guardRemote(cmd === 'apply' ? remoteApply : remoteDiff);
    if (r) return r;
    return cmdApplyDeleteDiff(g, c, cmd);
  }
  if (cmd === 'delete') {
    const r = guardRemote(remoteDelete);
    if (r) return r;
    return cmdApplyDeleteDiff(g, c, 'delete');
  }
  if (cmd === 'get' || cmd === 'describe') {
    const r = guardRemote(async (gg, rr, cc) => {
      const kind = cc.args[0] ?? '';
      const name = cc.args[1] ?? '';
      if (cmd === 'describe' || gg.out.json) {
        const code = await remoteGet(gg, rr, kind || 'deployments', name);
        return code;
      }
      return remoteGet(gg, rr, kind || 'deployments', name);
    });
    if (r) return r;
    return cmdGetDescribe(g, c, cmd);
  }
  if (cmd === 'scale') {
    const r = guardRemote(remoteScale);
    if (r) return r;
    return cmdScale(g, c);
  }
  if (cmd === 'rollout') {
    if (c.sub === 'status') {
      const r = guardRemote(async (gg, rr) => {
        const d = await serverApi(rr.server, rr.token, 'GET', '/api/deployments');
        process.stdout.write(renderTable(['NAME', 'IMAGE', 'REPLICAS'],
          d.deployments.map((x) => [x.name, x.image, String(x.replicas ?? 0)])));
        return 0;
      });
      if (r) return r;
      return cmdCluster(g, { ...c, sub: 'status' });
    }
    if (c.sub === 'history' || c.sub === 'undo') {
      printError(`'pimg rollout ${c.sub}' moved`, 'use `pimg revision list <dep>` and `pimg revision rollback <dep> <id>`', 'revisions are the git-like history now');
      return 2;
    }
    printError(`unknown rollout subcommand '${c.sub}'`, '', 'try: status');
    return 1;
  }

  // Plugins: explicit `pimg plugin …` or `<plugin> <command>` shorthand.
  if (cmd === 'plugin') return cmdPlugin(g, c);
  if (discoverPlugins(g.home).some((p) => p.name === cmd)) {
    try {
      const code = await dispatchPlugin(g.home, cmd, c.args[0] ?? 'help', c.args.slice(1), c.opts, g.out.json);
      if (code !== null) return code;
    } catch (e) {
      printError(`plugin '${cmd}' failed`, e.message, 'see docs/PLUGINS.md');
      return 1;
    }
  }

  // Remaining honest stubs.
  if (cmd === 'build') return stub(`pimg ${cmd}`, '2 (images and build)');
  if (cmd === 'port-forward' || cmd === 'listen' || cmd === 'nc') {
    return stub(`pimg ${cmd}`, '4 (networking)');
  }

  printError(`unknown command '${cmd}'`, '', 'run `pimg --help`');
  return 1;
}
