// Plugin system — `pimg <plugin> <command> [args]`.
//
// A plugin is a directory under <home>/plugins/<name>/ containing either:
//   plugin.js  (ESM: `export const commands = { <cmd>: { description, run } }`)
//   package.json with a `pimg.commands` map + `main` entry (npm-style plugins)
//
// The command handler `run(ctx)` receives:
//   { args, flags: Map, store, home, json, pluginName }
// and may return a numeric exit code (default 0). Plugins run in-process with
// full Node privileges: only install plugins you trust (see docs/PLUGINS.md
// and docs/THREAT_MODEL.md).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Store } from './store.js';

export function pluginDir(home) {
  return path.join(Store.resolve(home).home, 'plugins');
}

function loadManifest(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (j?.pimg?.commands && typeof j.pimg.commands === 'object') {
      return { commands: j.pimg.commands, main: j.main ?? 'plugin.js', version: j.version ?? '' };
    }
  } catch { /* not an npm-style plugin */ }
  return null;
}

export function discoverPlugins(home) {
  const dir = pluginDir(home);
  let names = [];
  try {
    names = fs.readdirSync(dir).filter((n) => {
      try {
        return fs.statSync(path.join(dir, n)).isDirectory();
      } catch {
        return false;
      }
    });
  } catch {
    return [];
  }
  const out = [];
  for (const name of names) {
    const pdir = path.join(dir, name);
    const hasJs = fs.existsSync(path.join(pdir, 'plugin.js'));
    const man = loadManifest(pdir);
    if (!hasJs && !man) continue; // not a plugin; ignore
    out.push({ name, path: pdir, version: man?.version ?? '', manifest: !!man });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : 1));
}

export async function loadPlugin(home, name) {
  const pdir = path.join(pluginDir(home), name);
  const man = loadManifest(pdir);
  const entry = path.join(pdir, man?.main ?? 'plugin.js');
  if (!fs.existsSync(entry)) throw new Error(`plugin '${name}' has no ${man?.main ?? 'plugin.js'}`);
  const mod = await import(pathToFileURL(entry).href);
  const commands = mod.commands ?? {};
  const described = man?.commands ?? {};
  // Merge static descriptions from package.json over code-provided ones.
  for (const [cmd, desc] of Object.entries(described)) {
    commands[cmd] = { description: typeof desc === 'string' ? desc : desc.description ?? '', run: commands[cmd]?.run };
  }
  return { name, path: pdir, commands };
}

export function pluginHelp(home) {
  const found = discoverPlugins(home);
  return found.map((p) => ({ name: p.name, version: p.version, path: p.path }));
}

// Dispatch `pimg <name> <cmd> [rest]`. Returns null when name is no plugin.
export async function dispatchPlugin(home, name, cmd, args, flags, json) {
  if (!discoverPlugins(home).some((p) => p.name === name)) return null;
  const plugin = await loadPlugin(home, name);
  const entry = plugin.commands[cmd];
  if (!entry?.run) {
    const avail = Object.keys(plugin.commands);
    throw new Error(
      `plugin '${name}' has no command '${cmd}'` + (avail.length ? ` (available: ${avail.join(', ')})` : ' (no commands)'),
    );
  }
  const store = Store.resolve(home);
  store.init();
  const code = await entry.run({ args, flags, store, home: store.home, json, pluginName: name });
  return typeof code === 'number' ? code : 0;
}
