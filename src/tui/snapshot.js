// Text snapshot renderer — port of render_snapshot()/render_frame().
// Pure string output for `pimg ui --snapshot` (no Ink, no TTY needed).
// Keeps the C++ layout contract: top bar / sidebar / main / keybar + overlays.
import stringWidth from 'string-width';
import { Pane, paneName } from './model.js';
import { borderGlyphs, iconSetName, iconsFor } from './theme.js';
import { mascotLines } from './mascot.js';
import { formatAge } from './feed.js';

const trunc = (s, w) => {
  if (stringWidth(s) <= w) return s + ' '.repeat(Math.max(0, w - stringWidth(s)));
  let out = '';
  for (const ch of s) {
    if (stringWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return out + '…'.slice(0, Math.max(0, w - stringWidth(out)));
};

function boxTop(w, g, title = '') {
  if (title) return g.tl + g.h + ` ${title} ` + g.h.repeat(Math.max(0, w - title.length - 4)) + g.tr;
  return g.tl + g.h.repeat(Math.max(0, w - 2)) + g.tr;
}
const boxBot = (w, g) => g.bl + g.h.repeat(Math.max(0, w - 2)) + g.br;

export function renderSnapshot(app, snap, cols, rows, tick = 4) {
  cols = Math.min(300, Math.max(20, cols));
  rows = Math.min(100, Math.max(10, rows));
  const g = borderGlyphs(app.border === 2 ? 2 : app.border === 0 ? 0 : 1, app.icons);
  const ic = iconsFor(app.icons);
  const compact = cols < 100;
  const tiny = cols < 60;
  const sideW = tiny ? 0 : compact ? 14 : 22;
  const lines = [];

  // Top bar (3 rows). Mascot face rides in the title when room allows.
  const face = tiny ? '' : `(${mascotLines('idle', tick)[1].trim()}) `;
  lines.push(boxTop(cols, g, `${face}pimg`));
  const cpuStr = snap.cpuAvailable === false ? 'n/a' : `${String(Math.round(snap.cpuPct)).padStart(2)}%`;
  let mid = `CPU ${cpuStr} MEM ${String(Math.round(snap.memPct)).padStart(2)}%`;
  let left = `node ${snap.node}  iso:${snap.isolation}${snap.demo ? '  DEMO' : ''}`;
  let right = `${snap.clock}`;
  let top = `  ${left}`;
  if (!tiny) {
    const pad = Math.max(1, Math.floor(cols / 2 - 10) - stringWidth(top));
    top += ' '.repeat(pad) + mid;
    const rp = cols - stringWidth(right) - 3 - stringWidth(top);
    top += ' '.repeat(Math.max(1, rp)) + right;
  }
  lines.push(g.v + trunc(top, cols - 2) + g.v);
  lines.push(boxBot(cols, g));

  // Body
  const bodyH = rows - 3 - 2;
  const mainX = sideW ? sideW + 1 : 0;
  const mw = cols - mainX;
  const body = [];

  const sidebarItems = [
    [ic.containers, 'Containers', snap.containers.length],
    [ic.images, 'Images', snap.images.length],
    [ic.networks, 'Networks', -1], [ic.volumes, 'Volumes', -1],
    [ic.cluster, 'Cluster', -1], [ic.nettools, 'Net Tools', -1],
    [ic.logs, 'Logs', -1], [ic.settings, 'Settings', -1],
  ];
  const mainTitle = paneName(app.pane);
  const rowsData = app.visibleRows(snap);

  for (let r = 0; r < bodyH; r++) {
    let leftCell = '';
    if (sideW) {
      if (r === 0) leftCell = boxTop(sideW, g, 'views');
      else if (r === bodyH - 1) leftCell = boxBot(sideW, g);
      else {
        const idx = r - 1;
        const it = sidebarItems[idx];
        if (it) {
          const sel = idx === app.pane ? '>' : ' ';
          const badge = it[2] >= 0 ? ` ${it[2]}` : '';
          leftCell = g.v + trunc(`${sel} ${it[0]} ${it[1]}${badge}`, sideW - 2) + g.v;
        } else {
          leftCell = g.v + ' '.repeat(sideW - 2) + g.v;
        }
      }
    }
    let main = '';
    if (r === 0) main = boxTop(mw, g, mainTitle);
    else if (r === bodyH - 1) main = boxBot(mw, g);
    else {
      const inner = r - 1;
      let text = '';
      if (app.pane === Pane.Logs) {
        const feed = snap.feed ?? [];
        if (inner < feed.length) {
          const e = feed[inner];
          text = `${e.icon} ${e.text} ${formatAge(e.t)}`;
        } else {
          const li = inner - feed.length;
          text = snap.logTail[li] ?? (li === 0 && !snap.logTail.length && !feed.length ? 'no logs yet — run a container to generate output' : '');
        }
      } else if (app.pane === Pane.Settings) {
        text = [
          `theme : ${app.theme().name}  (t to cycle)`,
          `icons : ${iconSetName(app.icons)}  (i to cycle)`,
          `border: ${app.border}  (b to cycle)`,
          `filter: ${app.filter || '-'}  (/ to set)`,
          '', 'mouse: click selects, wheel scrolls',
        ][inner] ?? '';
      } else if (app.pane === Pane.NetTools) {
        text = inner === 0 ? 'TCP/UDP/DNS probes (no raw sockets)' : ['ping <host> [port]', 'dns <name>', 'http <url>', 'scan <host> [ports]', 'listen <port>'][inner - 2] ?? '';
      } else if (app.pane === Pane.Cluster) {
        if (app.subTab === 1) {
          const runningOf = (name) => (snap.containers ?? []).filter((c) => c.id?.startsWith(`${name}-`) && c.status === 'running').length;
          const repBar = (have, want, w = 10) => {
            const f = want > 0 ? Math.min(1, have / want) : 1;
            const n = Math.round(f * w);
            return `[${'#'.repeat(n)}${'-'.repeat(w - n)}] ${have}/${want}`;
          };
          text = inner === 0 ? 'Deployments  ([ ] switch tabs)' : ((d) => d ? `${d.name} ${repBar(runningOf(d.name), d.replicas ?? 0)} ${d.image}` : '')(snap.deployments[inner - 1]) ?? '';
        } else {
          text = inner === 0 ? 'Pods — single-node reconciler ([ ] for Deployments)' : (rowsData[inner - 1]?.cells.join('  ') ?? '');
        }
      } else {
        const row = rowsData[inner - 1];
        if (inner === 0) text = 'NAME  STATUS  DETAIL';
        else if (row) text = `${inner === app.sel + 1 ? '>' : ' '}${row.cells.join('  ')}`;
        else if (inner === 1) text = 'nothing here yet';
      }
      main = g.v + trunc(` ${text}`, mw - 2) + g.v;
    }
    body.push(sideW ? leftCell + ' ' + main : main);
  }
  lines.push(...body);

  // Keybar
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spinner = frames[tick % frames.length];
  const keys = tiny ? 'q quit · : pal · ? ?' : `q quit · / filter · t theme · i icons · : palette · ? help · ${spinner} live`;
  lines.push(trunc(keys, cols));

  let out = lines.slice(0, rows).join('\n') + '\n';
  if (app.paletteIsOpen) {
    out += `palette: ${app.paletteQ}\n`;
    for (const m of app.paletteMatches().slice(0, 8)) out += `  ${m}\n`;
  }
  if (app.helpOpen) out += 'j/k move  tab panes  / filter  t/i/b theme  q quit\n';
  if (app.confirmOpen) out += `confirm delete '${app.confirmTarget}'? type name + Enter\n`;
  return out;
}

export function spinnerFrame(tick, iconSet) {
  if (iconSet === 2) return ['-', '\\', '|', '/'][tick % 4];
  return ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'][tick % 10];
}
