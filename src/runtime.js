// Emulated rootless runtime — Phase 3 (lite).
// Backend honesty: without userns/proot/container snapshotting on every OS,
// `run` supervises a detached host process per container and records it under
// <home>/containers/<name>/{config.json,logs/output.log,pid}. ps/logs/stop/rm
// operate on those records, so the TUI containers pane is live. Isolation is
// reported as "emulated" everywhere (see doctor + TUI top bar).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { Store } from './store.js';

export function containerDir(store, name) {
  return path.join(store.containers, name);
}

export function readConfig(store, name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(containerDir(store, name), 'config.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeConfig(store, name, cfg) {
  const dir = containerDir(store, name);
  fs.mkdirSync(path.join(dir, 'logs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(cfg, null, 2));
}

export function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Effective status: stored state, but a dead pid means exited.
export function containerStatus(store, name) {
  const cfg = readConfig(store, name);
  if (!cfg) return 'unknown';
  if (cfg.state === 'running' && !pidAlive(cfg.pid)) return 'exited';
  return cfg.state ?? 'unknown';
}

export function listContainers(store) {
  let names = [];
  try {
    names = fs.readdirSync(store.containers).filter((n) => {
      try {
        return fs.statSync(path.join(store.containers, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  return names.map((name) => {
    const cfg = readConfig(store, name) ?? {};
    return {
      name,
      image: cfg.image ?? '-',
      command: cfg.command ?? [],
      status: containerStatus(store, name),
      pid: cfg.pid ?? null,
    };
  });
}

export function runContainer(home, { name, image = 'scratch', command = [], env = {} }) {
  const store = Store.resolve(home);
  store.init();
  if (!name) throw new Error('container name is required (--name)');
  if (containerDir(store, name) && fs.existsSync(containerDir(store, name))) {
    throw new Error(`container '${name}' already exists`);
  }
  const cmd = command.length ? command : defaultCommand();
  const logPath = path.join(containerDir(store, name), 'logs', 'output.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, 'a');
  const child = spawn(cmd[0], cmd.slice(1), {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...env },
  });
  fs.closeSync(logFd);
  child.unref();
  writeConfig(store, name, {
    name,
    image,
    command: cmd,
    env,
    pid: child.pid ?? null,
    state: 'running',
    created: new Date().toISOString(),
    backend: 'emulated',
  });
  return { name, pid: child.pid ?? null };
}

function defaultCommand() {
  // Keep the container "running" cross-platform without extra deps.
  return process.platform === 'win32'
    ? ['powershell', '-NoProfile', '-Command', 'while ($true) { Start-Sleep 60 }']
    : ['sleep', 'infinity'];
}

export function stopContainer(home, name, { signal = 'SIGTERM' } = {}) {
  const store = Store.resolve(home);
  const cfg = readConfig(store, name);
  if (!cfg) throw new Error(`no such container '${name}'`);
  if (cfg.pid && pidAlive(cfg.pid)) {
    try {
      process.kill(cfg.pid, signal);
    } catch (e) {
      throw new Error(`cannot stop '${name}': ${e.message}`);
    }
  }
  writeConfig(store, name, { ...cfg, state: 'exited', pid: null });
  return name;
}

export function startContainer(home, name) {
  const store = Store.resolve(home);
  const cfg = readConfig(store, name);
  if (!cfg) throw new Error(`no such container '${name}'`);
  if (cfg.state === 'running' && pidAlive(cfg.pid)) throw new Error(`'${name}' is already running`);
  fs.rmSync(containerDir(store, name), { recursive: true, force: true });
  return runContainer(home, { name, image: cfg.image, command: cfg.command, env: cfg.env ?? {} });
}

export function removeContainer(home, name, { force = false } = {}) {
  const store = Store.resolve(home);
  const cfg = readConfig(store, name);
  if (!cfg) throw new Error(`no such container '${name}'`);
  if (cfg.state === 'running' && pidAlive(cfg.pid)) {
    if (!force) throw new Error(`'${name}' is running (use --force)`);
    stopContainer(home, name, { signal: 'SIGKILL' });
  }
  fs.rmSync(containerDir(store, name), { recursive: true, force: true });
  return name;
}

// Last N lines of the container log (no -f streaming here; TUI polls).
export function containerLogs(home, name, { tail = 100 } = {}) {
  const store = Store.resolve(home);
  const logPath = path.join(containerDir(store, name), 'logs', 'output.log');
  let text = '';
  try {
    text = fs.readFileSync(logPath, 'utf8');
  } catch {
    return [];
  }
  const lines = text.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  return lines.slice(Math.max(0, lines.length - tail));
}

// Live log tail for the TUI: newest entries across running containers.
export function aggregateLogs(home, limit = 50) {
  const store = Store.resolve(home);
  const out = [];
  for (const c of listContainers(store)) {
    for (const line of containerLogs(home, c.name, { tail: 20 })) {
      out.push(`[${c.name}] ${line}`);
    }
  }
  return out.slice(Math.max(0, out.length - limit));
}
