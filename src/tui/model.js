// TUI model — port of src/tui/model.cpp.
// Pure state (App + Snapshot); no Ink imports so it stays unit-testable.
import fs from 'node:fs';
import { Store, listImages } from '../store.js';
import { aggregateLogs, listContainers } from '../runtime.js';
import { readCluster } from '../cluster.js';
import { sampleLiveStats } from '../stats.js';
import { IconSet, iconSetByName, themeByName, themeNames } from './theme.js';

export const Pane = {
  Containers: 0, Images: 1, Networks: 2, Volumes: 3,
  Cluster: 4, NetTools: 5, Logs: 6, Settings: 7, Count: 8,
};

export function paneName(p) {
  switch (p) {
    case Pane.Containers: return 'Containers';
    case Pane.Images: return 'Images';
    case Pane.Networks: return 'Networks';
    case Pane.Volumes: return 'Volumes';
    case Pane.Cluster: return 'Cluster';
    case Pane.NetTools: return 'Net Tools';
    case Pane.Logs: return 'Logs';
    case Pane.Settings: return 'Settings';
    default: return '?';
  }
}

// Shape-only snapshot for when the store is unreadable — the UI must never
// break, so every render path gets arrays/numbers, never undefined.
export function emptySnapshot() {
  return {
    demo: false,
    node: 'node0',
    cluster: 'single',
    isolation: 'emulated',
    cpuPct: 0,
    memPct: 0,
    cpuAvailable: false,
    cpuHist: [],
    memHist: [],
    netHist: [],
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    pods: [],
    deployments: [],
    logTail: [],
    feed: [],
    home: '',
    clock: new Date().toTimeString().slice(0, 8),
  };
}

export function loadSnapshot(storeHome = '', demo = false) {
  const snap = {
    demo,
    node: 'node0',
    cluster: 'single',
    isolation: 'emulated',
    cpuPct: 0,
    memPct: 0,
    cpuAvailable: true,
    cpuHist: [],
    memHist: [],
    netHist: [],
    containers: [],
    images: [],
    networks: [],
    volumes: [],
    pods: [],
    deployments: [],
    logTail: [],
    feed: [],
    home: '',
    clock: new Date().toTimeString().slice(0, 8),
  };
  const s = Store.resolve(storeHome);
  s.init();
  snap.home = s.home;
  const { images } = listImages(s);
  for (const im of images) {
    snap.images.push({
      cells: [im.name, im.digest ? `${im.digest.slice(0, 19)}...` : '-', [im.os, im.arch].filter(Boolean).join('/') || '-'],
      status: '',
      id: im.name,
      os: im.os ?? '',
      arch: im.arch ?? '',
    });
  }
  // Live containers from the emulated runtime (status/image from config.json).
  for (const c of listContainers(s)) {
    snap.containers.push({ cells: [c.name, c.status, c.image], status: c.status, id: c.name });
  }
  // Networks / volumes: managed as named dirs (drivers land in Phase 4/5).
  for (const [key, dir] of [['networks', s.networks], ['volumes', s.volumes]]) {
    try {
      for (const n of fs.readdirSync(dir, { withFileTypes: true })) {
        if (n.isDirectory()) snap[key].push({ cells: [n.name, key === 'networks' ? 'bridge' : 'local', '-'], status: '', id: n.name });
      }
    } catch { /* none yet */ }
  }
  if (!demo) snap.logTail = aggregateLogs(s.home);
  try {
    const cl = readCluster(s);
    snap.deployments = cl.deployments ?? [];
    // Pods = scheduled units when a server-side fleet exists, else local
    // member containers (name-index). Either way the Cluster tab is live.
    const units = cl.units ?? [];
    if (units.length) {
      for (const u of units) {
        snap.pods.push({
          cells: [u.id, u.status ?? 'Pending', u.node ?? '-'],
          status: u.status ?? 'Pending',
          id: u.id,
        });
      }
    } else {
      for (const ctn of listContainers(s)) {
        if (/-\d+$/.test(ctn.name)) {
          snap.pods.push({ cells: [ctn.name, ctn.status, 'node0'], status: ctn.status, id: ctn.name });
        }
      }
    }
  } catch { /* no cluster yet */ }

  // Live host stats (non-demo only). On Android the CPU probe is skipped by
  // sampleLiveStats (/proc/stat is restricted there) — MEM still reported.
  if (!demo) {
    const live = sampleLiveStats();
    snap.cpuPct = live.cpuPct ?? 0;
    snap.memPct = live.memPct;
    snap.cpuHist = live.cpuHist;
    snap.memHist = live.memHist;
    snap.cpuAvailable = live.cpuAvailable;
  }

  if (demo) {
    snap.containers = [
      { cells: ['web', 'running', 'alpine:3.19'], status: 'running', id: 'web' },
      { cells: ['db', 'paused', 'postgres:16'], status: 'paused', id: 'db' },
      { cells: ['worker', 'exited', 'demo:1'], status: 'exited', id: 'worker' },
    ];
    snap.images = [
      { cells: ['alpine:3.19', 'sha256:demo1', '12MB'], status: '', id: 'alpine:3.19' },
      { cells: ['postgres:16', 'sha256:demo2', '300MB'], status: '', id: 'postgres:16' },
    ];
    snap.networks = [{ cells: ['bridge', 'bridge', '10.0.0.0/24'], status: '', id: 'bridge' }];
    snap.volumes = [{ cells: ['data', 'local', '1.2G'], status: '', id: 'data' }];
    snap.pods = [{ cells: ['web-0', 'running', 'node0'], status: 'running', id: 'web-0' }];
    snap.cpuHist = [0.1, 0.3, 0.2, 0.5, 0.4, 0.7, 0.6, 0.8, 0.5, 0.4, 0.6, 0.7];
    snap.memHist = [0.4, 0.42, 0.41, 0.45, 0.5, 0.48, 0.52, 0.55, 0.53, 0.5, 0.49, 0.51];
    snap.netHist = [0.2, 0.1, 0.3, 0.6, 0.4, 0.2, 0.5, 0.3, 0.4, 0.6, 0.5, 0.3];
    snap.cpuPct = 34;
    snap.memPct = 51;
    snap.cpuAvailable = true;
    snap.logTail = ['[web] listening on :80', '[web] GET / 200 1ms', '[db] checkpoint done'];
    const now = Date.now();
    snap.feed = [
      { t: now - 42000, icon: '+', kind: 'container', text: 'started web' },
      { t: now - 25000, icon: '+', kind: 'image', text: 'pulled alpine:3.19' },
      { t: now - 9000, icon: '~', kind: 'container', text: 'db: running → paused' },
    ];
  }
  return snap;
}

export function defaultIcons() {
  if (process.env.PIMG_ICONS) return iconSetByName(process.env.PIMG_ICONS);
  if (process.env.NO_ICONS) return IconSet.Ascii;
  if (process.env.TERM === 'dumb') return IconSet.Ascii;
  return IconSet.Nerd;
}

const matchInsensitive = (hay, needle) => {
  if (!needle) return true;
  return hay.toLowerCase().includes(needle.toLowerCase());
};

export class App {
  constructor() {
    this.pane = Pane.Containers;
    this.sel = 0;
    this.filter = '';
    this.themeIdx = 0;
    this.icons = defaultIcons();
    this.border = 1; // 0 single, 1 rounded, 2 double
    this.confirmOpen = false;
    this.confirmTarget = '';
    this.confirmInput = '';
    this.paletteIsOpen = false;
    this.paletteQ = '';
    this.paletteSelIdx = 0;
    this.helpOpen = false;
    this.subTab = 0;
  }

  cycleSubTab(dir, count) {
    if (!(count > 1)) { this.subTab = 0; return; }
    this.subTab = (((this.subTab + dir) % count) + count) % count;
  }

  theme() { return themeByName(themeNames()[this.themeIdx]); }
  setTheme(name) {
    const i = themeNames().indexOf(name);
    if (i >= 0) this.themeIdx = i;
  }
  setIcons(s) { this.icons = s; }

  selectPane(p) { this.pane = p; this.sel = 0; this.subTab = 0; }
  nextPane(dir) {
    const n = Pane.Count;
    this.pane = (((this.pane + dir) % n) + n) % n;
    this.sel = 0;
    this.subTab = 0;
  }
  moveSel(dir) { this.sel = Math.max(0, this.sel + dir); }
  clampSel(n) { this.sel = n <= 0 ? 0 : Math.min(this.sel, n - 1); }
  scrollPage(dir) { this.sel = Math.max(0, this.sel + dir * 10); }
  setFilter(f) { this.filter = f; this.sel = 0; }
  cycleTheme(dir) {
    const n = themeNames().length;
    this.themeIdx = (((this.themeIdx + dir) % n) + n) % n;
  }
  cycleIcons(dir) { this.icons = (((this.icons + dir) % 3) + 3) % 3; }
  cycleBorder(dir) { this.border = (((this.border + dir) % 3) + 3) % 3; }

  openConfirm(t) { this.confirmOpen = true; this.confirmTarget = t; this.confirmInput = ''; }
  closeDialog() { this.confirmOpen = false; this.confirmInput = ''; }
  dialogInput(c) {
    if (c === null) this.confirmInput = this.confirmInput.slice(0, -1);
    else if (this.confirmInput.length < 64) this.confirmInput += c;
  }
  dialogConfirmed() {
    return this.confirmOpen && this.confirmInput === this.confirmTarget && !!this.confirmTarget;
  }

  openPalette() { this.paletteIsOpen = true; this.paletteQ = ''; this.paletteSelIdx = 0; }
  closePalette() { this.paletteIsOpen = false; }
  paletteInput(c) { if (this.paletteQ.length < 48) this.paletteQ += c; this.paletteSelIdx = 0; }
  paletteErase() { this.paletteQ = this.paletteQ.slice(0, -1); this.paletteSelIdx = 0; }
  paletteMove(dir) {
    const m = this.paletteMatches().length;
    if (m <= 0) { this.paletteSelIdx = 0; return; }
    this.paletteSelIdx = Math.min(m - 1, Math.max(0, this.paletteSelIdx + dir));
  }
  openHelp() { this.helpOpen = true; }
  closeHelp() { this.helpOpen = false; }

  visibleRows(snap) {
    let src = snap.containers;
    switch (this.pane) {
      case Pane.Containers: src = snap.containers; break;
      case Pane.Images: src = snap.images; break;
      case Pane.Networks: src = snap.networks; break;
      case Pane.Volumes: src = snap.volumes; break;
      case Pane.Cluster: src = snap.pods; break;
      default: src = snap.containers;
    }
    if (!this.filter) return src;
    return src.filter((r) => r.cells.some((c) => matchInsensitive(c, this.filter)));
  }

  static paletteAll() {
    return [
      { name: 'quit', hint: 'exit the TUI' },
      { name: 'theme neon', hint: 'switch theme' }, { name: 'theme solarized', hint: 'switch theme' },
      { name: 'theme nord', hint: 'switch theme' }, { name: 'theme high-contrast', hint: 'switch theme' },
      { name: 'icons nerd', hint: 'glyph set' }, { name: 'icons blocks', hint: 'glyph set' }, { name: 'icons ascii', hint: 'glyph set' },
      { name: 'pane containers', hint: 'go to' }, { name: 'pane images', hint: 'go to' },
      { name: 'pane networks', hint: 'go to' }, { name: 'pane volumes', hint: 'go to' },
      { name: 'pane cluster', hint: 'go to' }, { name: 'pane net-tools', hint: 'go to' },
      { name: 'pane logs', hint: 'go to' }, { name: 'pane settings', hint: 'go to' },
      { name: 'help', hint: 'keybindings' },
    ];
  }

  paletteMatches() {
    return App.paletteAll().filter((e) => matchInsensitive(e.name, this.paletteQ)).map((e) => e.name);
  }
}
