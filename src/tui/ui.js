// Interactive Ink UI — replaces raw ANSI loop (src/tui/app.cpp + term.cpp).
// Lazy-imported by cli.js only for `pimg ui` so other commands stay fast.
// Optimized: single 33ms ticker (~30fps like C++), memo'd panes, diff left to Ink.
import React from 'react';
import { Box, Text, useInput, useApp, useStdout } from 'ink';
import { App, Pane, emptySnapshot, loadSnapshot, paneName } from './model.js';
import { iconSetName, iconsFor, roleToColor } from './theme.js';
import { hostLabel, platformLabel } from './sysicons.js';
import { Mascot } from './mascot.js';
import { diffSnapshots, formatAge, pushFeed } from './feed.js';
import { bp, clampInt, fit, viewport } from './layout.js';
import {
  BarChart, Dialog, Gauge, HelpDialog, Keybar, Palette, Sidebar, Sparkline, Swatches, Tabs,
} from './widgets.js';

export function applyPalette(app) {
  const m = app.paletteMatches();
  const cmd = m[app.paletteSelIdx];
  app.closePalette();
  if (cmd === undefined) return true;
  if (cmd === 'quit') return false;
  if (cmd === 'help') { app.openHelp(); return true; }
  if (cmd.startsWith('theme ')) {
    const want = cmd.slice(6);
    let guard = 0;
    while (app.theme().name !== want && guard++ < 8) app.cycleTheme(1);
    return true;
  }
  if (cmd.startsWith('icons ')) {
    const want = cmd.slice(6);
    let guard = 0;
    while (iconSetName(app.icons) !== want && guard++ < 6) app.cycleIcons(1);
    return true;
  }
  if (cmd.startsWith('pane ')) {
    const want = cmd.slice(5);
    for (let i = 0; i < Pane.Count; i++) {
      if (paneName(i).toLowerCase() === want || (want === 'net-tools' && i === Pane.NetTools)) {
        app.selectPane(i);
        break;
      }
    }
  }
  return true;
}

function StatusText({ status, theme }) {
  const color =
    status === 'running' ? roleToColor(theme, 4) :
    status === 'paused' ? roleToColor(theme, 5) :
    status === 'exited' ? roleToColor(theme, 2) :
    roleToColor(theme, 2);
  return React.createElement(Text, { color }, status || '-');
}

function MainPane({ app, snap, theme, maxRows = 30, colsAvail = 80 }) {
  const rows = app.visibleRows(snap);
  const h = React.createElement;
  const accent = roleToColor(theme, 3);
  const green = roleToColor(theme, 4);
  const ascii = app.icons === 2;
  // Scroll window so the selection is always visible in fullscreen mode.
  const windowed = (list) => {
    const n = Math.max(1, maxRows);
    const start = Math.max(0, Math.min(app.sel - n + 1, list.length - n));
    return { items: list.slice(start, start + n), offset: start };
  };
  const statStrip = (snap.cpuHist?.length || snap.memHist?.length)
    ? h(Box, { key: '__strip', marginTop: 1 },
      h(Text, { dimColor: true }, 'cpu '),
      h(Sparkline, { values: snap.cpuHist ?? [], width: 20, color: green, ascii }),
      h(Text, { dimColor: true }, '  mem '),
      h(Sparkline, { values: snap.memHist ?? [], width: 20, color: accent, ascii }))
    : null;
  const withStrip = (...children) => (statStrip ? [...children, statStrip] : children);

  if (app.pane === Pane.Logs) {
    const feed = (snap.feed ?? []).slice(Math.max(0, (snap.feed ?? []).length - Math.max(1, maxRows - 2)));
    const tail = snap.logTail.slice(Math.max(0, snap.logTail.length - Math.max(1, maxRows - feed.length - 3)));
    const evColor = (e) => (e.icon === '+' ? green : e.icon === '-' ? roleToColor(theme, 6) : roleToColor(theme, 5));
    return h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, 'Activity'),
      ...(feed.length ? feed.map((e, i) => h(Text, { key: `e${i}`, wrap: 'truncate' },
        h(Text, { color: evColor(e) }, `${e.icon} `),
        h(Text, null, fit(e.text, 60)),
        h(Text, { dimColor: true }, ` ${formatAge(e.t)}`)))
        : [h(Text, { key: 'e0', dimColor: true }, 'quiet — start a container or pull an image')]),
      h(Text, { key: 'div', dimColor: true }, 'Container logs'),
      ...(tail.length ? tail.map((l, i) => h(Text, { key: `l${i}`, wrap: 'truncate' }, fit(l, 200)))
        : [h(Text, { key: 'e', dimColor: true }, 'no logs yet — run a container to generate output')]));
  }
  if (app.pane === Pane.Settings) {
    const swCols = colsAvail >= 60 ? 3 : colsAvail >= 40 ? 2 : 1;
    const lines = [
      `theme : ${app.theme().name}  (t to cycle)`,
      `icons : ${iconSetName(app.icons)}  (i to cycle)`,
      `border: ${app.border}  (b to cycle)`,
      `filter: ${app.filter || '-'}  (/ to set)`,
      `host  : ${hostLabel(app.icons)}`,
      '',
      'keys: [ ] switch tabs, mouse not captured by Ink (keyboard only)',
      '',
      `palette: ${app.theme().name}`,
    ];
    return h(Box, { flexDirection: 'column' },
      ...lines.map((l, i) => h(Text, { key: i, wrap: 'truncate' }, l)),
      h(Box, { key: 'sw', marginTop: 0 }, h(Swatches, { theme, columns: swCols })),
      h(Box, { key: 'gauges', flexDirection: 'column', marginTop: 1 },
        h(BarChart, {
          rows: [
            { label: 'cpu', frac: (snap.cpuPct ?? 0) / 100 },
            { label: 'mem', frac: (snap.memPct ?? 0) / 100 },
          ],
          width: 16,
          color: green,
        })));
  }
  if (app.pane === Pane.NetTools) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, 'TCP/UDP/DNS probes (no raw sockets) — `pimg net --help`'),
      ...['ping <host> [port]', 'dns <name>', 'http <url>', 'scan <host> <ports>', 'listen <port>'].map((t, i) =>
        h(Text, { key: i, color: roleToColor(theme, 8) }, `> ${t}`)));
  }
  if (app.pane === Pane.Cluster) {
    const tabs = ['Pods', 'Deployments'];
    const pods = windowed(snap.pods);
    const deps = snap.deployments.slice(0, Math.max(1, maxRows - 1));
    const gaugeW = clampInt(colsAvail - 46, 8, 24);
    const runningOf = (name) => (snap.containers ?? []).filter((c) => c.id?.startsWith(`${name}-`) && c.status === 'running').length;
    const body = app.subTab === 1
      ? (deps.length
        ? deps.map((d, i) => {
          const want = Math.max(0, d.replicas ?? 0);
          const have = runningOf(d.name);
          return h(Text, { key: d.name + i, wrap: 'truncate' },
            h(Text, { bold: true }, fit(d.name, 18).padEnd(18)),
            ' ',
            h(Gauge, { frac: want > 0 ? have / want : 1, width: gaugeW, color: have >= want && want > 0 ? green : roleToColor(theme, 5) }),
            h(Text, { dimColor: true }, ` ${have}/${want} ${fit(d.image ?? '', 24)}`));
        })
        : [h(Text, { key: 'e', dimColor: true }, 'no deployments — `pimg apply -f app.json`')])
      : [h(Text, { key: 'note', dimColor: true }, 'single-node reconciler (file-backed)'),
        ...pods.items.map((r, i) => h(Text, {
          key: r.id + i,
          wrap: 'truncate',
          backgroundColor: (pods.offset + i) === app.sel ? roleToColor(theme, 12) : undefined,
        }, `${r.cells.join('  ')}`))];
    return h(Box, { flexDirection: 'column' },
      h(Tabs, { tabs, selected: app.subTab, accent }),
      ...body);
  }
  if (app.pane === Pane.Images && rows.length) {
    const w = windowed(rows);
    return h(Box, { flexDirection: 'column' },
      h(Text, { bold: true, color: roleToColor(theme, 10) }, 'NAME  DIGEST  PLATFORM'),
      ...withStrip(...w.items.map((r, i) =>
        h(Text, {
          key: r.id + i,
          wrap: 'truncate',
          backgroundColor: (w.offset + i) === app.sel ? roleToColor(theme, 12) : undefined,
          color: (w.offset + i) === app.sel ? roleToColor(theme, 11) : undefined,
        }, `${(w.offset + i) === app.sel ? '>' : ' '}${r.cells[0]}  ${r.cells[1]}  ${platformLabel(r.os ?? '', r.arch ?? '', app.icons)}`))));
  }
  if (!rows.length) {
    return h(Box, { flexDirection: 'column' },
      h(Text, { dimColor: true }, 'nothing here yet'),
      h(Text, { dimColor: true }, `filter: ${app.filter || '(none, / to set)'}`));
  }
  const wDef = windowed(rows);
  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true, color: roleToColor(theme, 10) }, 'NAME  STATUS  DETAIL'),
    ...withStrip(...wDef.items.map((r, i) => {
      const isSel = (wDef.offset + i) === app.sel;
      return h(Text, {
        key: r.id + i,
        wrap: 'truncate',
        backgroundColor: isSel ? roleToColor(theme, 12) : undefined,
        color: isSel ? roleToColor(theme, 11) : undefined,
      }, `${isSel ? '>' : ' '}${r.cells[0]}  `,
        h(StatusText, { status: r.cells[1], theme }),
        `  ${r.cells[2] ?? ''}`);
    })));
}

export function PimgUI({ storeHome, demo, themeName, iconsName }) {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [, force] = React.useReducer((x) => x + 1, 0);
  const ref = React.useRef(null);
  if (!ref.current) {
    const app = new App();
    if (themeName) app.setTheme(themeName);
    if (iconsName === 'ascii') app.setIcons(2);
    else if (iconsName === 'blocks') app.setIcons(1);
    else if (iconsName === 'nerd') app.setIcons(0);
    let snap;
    try {
      snap = loadSnapshot(storeHome, demo);
    } catch {
      snap = emptySnapshot();
    }
    snap.feed = Array.isArray(snap.feed) ? snap.feed : [];
    ref.current = { app, snap, prev: null, feed: [...snap.feed], tick: 0, filterMode: false, filterBuf: '' };
  }
  const st = ref.current;
  const app = st.app;

  React.useEffect(() => {
    const t = setInterval(() => {
      st.tick++;
      let snap;
      try {
        snap = loadSnapshot(storeHome, demo);
        snap.isolation = 'emulated';
      } catch {
        snap = emptySnapshot();
      }
      // Claude-style activity transcript: diff the previous poll.
      try {
        st.feed = pushFeed(st.feed, diffSnapshots(st.prev ?? st.snap, snap));
      } catch {
        /* feed must never break the frame */
      }
      snap.feed = st.feed;
      st.prev = st.snap;
      st.snap = snap;
      try {
        app.clampSel(app.visibleRows(snap).length);
      } catch { /* keep selection */ }
      force();
    }, 1000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useInput((input, key) => {
    const snap = st.snap;
    if (app.paletteIsOpen) {
      if (key.escape) app.closePalette();
      else if (key.return) { if (!applyPalette(app)) exit(); }
      else if (key.upArrow) app.paletteMove(-1);
      else if (key.downArrow) app.paletteMove(1);
      else if (key.backspace || key.delete) app.paletteErase();
      else if (input && !key.ctrl && !key.meta) app.paletteInput(input);
      force();
      return;
    }
    if (app.confirmOpen) {
      if (key.escape || key.return) app.closeDialog();
      else if (key.backspace || key.delete) app.dialogInput(null);
      else if (input && !key.ctrl && !key.meta) app.dialogInput(input);
      force();
      return;
    }
    if (st.filterMode) {
      if (key.escape || key.return) st.filterMode = false;
      else if (key.backspace || key.delete) {
        st.filterBuf = st.filterBuf.slice(0, -1);
        app.setFilter(st.filterBuf);
      } else if (input && !key.ctrl && !key.meta) {
        st.filterBuf += input;
        app.setFilter(st.filterBuf);
      }
      force();
      return;
    }
    if (key.upArrow) app.moveSel(-1);
    else if (key.downArrow) app.moveSel(1);
    else if (key.pageUp) app.scrollPage(-1);
    else if (key.pageDown) app.scrollPage(1);
    else if (key.tab) app.nextPane(1);
    else if (key.escape) { app.setFilter(''); st.filterBuf = ''; app.closeHelp(); }
    else if ((key.ctrl && input === 'p') || input === ':') app.openPalette();
    else if ((key.ctrl && input === 'c') || input === 'q') exit();
    else if (input === 'j') app.moveSel(1);
    else if (input === 'k') app.moveSel(-1);
    else if (input === 'h') app.nextPane(-1);
    else if (input === 'l') app.nextPane(1);
    else if (input === 't') app.cycleTheme(1);
    else if (input === 'T') app.cycleTheme(-1);
    else if (input === 'i') app.cycleIcons(1);
    else if (input === 'b') app.cycleBorder(1);
    else if (input === '[') app.cycleSubTab(-1, subTabCount(app));
    else if (input === ']') app.cycleSubTab(1, subTabCount(app));
    else if (input === '?') app.helpOpen ? app.closeHelp() : app.openHelp();
    else if (input === '/') { st.filterMode = true; st.filterBuf = app.filter; }
    else if (input >= '1' && input <= '8') app.selectPane(Number(input) - 1);
    else if (input === 'd') {
      const vr = app.visibleRows(snap);
      if (app.sel < vr.length) app.openConfirm(vr[app.sel].id);
    }
    force();
  });

  const h = React.createElement;
  const theme = app.theme();
  const ic = iconsFor(app.icons);
  const accent = roleToColor(theme, 3);
  const green = roleToColor(theme, 4);
  const { cols, rows: termRows } = viewport(stdout);
  const mode = bp(cols);
  const tiny = mode === 'tiny';
  // Rows for list content: header(5) + keybar(1) + pane chrome(3).
  const maxRows = Math.max(3, termRows - 9);
  const lastEv = st.feed.length ? st.feed[st.feed.length - 1] : null;
  const mood = (app.paletteIsOpen || app.confirmOpen || st.filterMode ||
    (lastEv && Date.now() - lastEv.t < 15000)) ? 'working' : 'idle';
  // Main-pane inner width for adaptive widgets (sidebar + borders + padding).
  const sideW = tiny ? 0 : mode === 'compact' ? 16 : 24;
  const colsAvail = Math.max(20, cols - sideW - (sideW ? 1 : 0) - 6);
  const gaugeW = clampInt(Math.min(24, colsAvail - 40), 8, 24);
  const items = [
    [ic.containers, 'Containers', snapCount(st.snap.containers)],
    [ic.images, 'Images', snapCount(st.snap.images)],
    [ic.networks, 'Networks', -1], [ic.volumes, 'Volumes', -1],
    [ic.cluster, 'Cluster', -1], [ic.nettools, 'Net Tools', -1],
    [ic.logs, 'Logs', -1], [ic.settings, 'Settings', -1],
  ];
  const cpuTxt = st.snap.cpuAvailable === false ? 'n/a' : `${Math.round(st.snap.cpuPct ?? 0)}%`;
  return h(Box, { flexDirection: 'column', height: termRows },
    // Claude-style header: mascot + wordmark + context, no box chrome.
    h(Box, { key: 'head', flexDirection: 'row', height: 4 },
      tiny ? null : h(Box, { key: 'mas', width: 11 },
        h(Mascot, { mood, tick: st.tick, bodyColor: accent, eyeColor: green })),
      h(Box, { key: 'ttl', flexDirection: 'column', flexGrow: 1 },
        h(Box, { key: 'r1', flexDirection: 'row' },
          h(Text, { bold: true, color: accent }, 'pimg'),
          h(Text, { dimColor: true }, ` v0.1.0  ${st.snap.demo ? 'DEMO · ' : ''}node ${st.snap.node ?? 'node0'} · iso:${st.snap.isolation ?? 'emulated'}`)),
        h(Text, { key: 'r2', dimColor: true, wrap: 'truncate' },
          fit(st.snap.home || '~/.pimg', Math.max(10, cols - (tiny ? 2 : 13)))),
        h(Box, { key: 'r3', flexDirection: 'row' },
          h(Text, { dimColor: true }, `CPU ${cpuTxt} `),
          h(Sparkline, { values: st.snap.cpuHist ?? [], width: gaugeW, color: green, ascii: app.icons === 2 }),
          h(Text, { dimColor: true }, `  MEM ${Math.round(st.snap.memPct ?? 0)}% `),
          h(Sparkline, { values: st.snap.memHist ?? [], width: gaugeW, color: accent, ascii: app.icons === 2 }),
          h(Text, { dimColor: true }, `  ${st.snap.clock ?? ''}`)))),
    h(Text, { key: 'ctx', dimColor: true, wrap: 'truncate' },
      `${hostLabel(app.icons)} · ${st.snap.demo ? 'demo data · ' : ''}${lastEv ? `last: ${fit(lastEv.text, 40)} ${formatAge(lastEv.t)}` : 'idle'}`),
    h(Box, { key: 'body', flexDirection: 'row', flexGrow: 1 },
      tiny ? null : h(Sidebar, {
        items: items.map(([icon, label, badge]) => ({ icon, label, badge })),
        selected: app.pane,
        width: mode === 'compact' ? 16 : 24,
        accent,
      }),
      h(Box, { key: 'main', flexDirection: 'column', flexGrow: 1, borderStyle: 'single', borderColor: roleToColor(theme, 9), paddingX: 1 },
        h(Box, { key: 'pt', flexDirection: 'row' },
          h(Text, { bold: true, color: roleToColor(theme, 10) }, paneName(app.pane)),
          tiny ? h(Text, { dimColor: true }, `  ${app.pane + 1}/8 · tab`) : null),
        tiny ? h(Tabs, {
          tabs: ['Con', 'Img', 'Net', 'Vol', 'Clu', 'Tls', 'Log', 'Set'],
          selected: app.pane,
          accent,
        }) : null,
        h(MainPane, { app, snap: st.snap, theme, maxRows: tiny ? maxRows - 1 : maxRows, colsAvail }))),
    h(Keybar, {
      keys: [
        ['q', 'quit'], ['/', st.filterMode ? `filter: ${st.filterBuf}▊` : 'filter'],
        ['t', 'theme'], ['i', 'icons'], [':', 'palette'], ['?', 'help'],
      ],
      tick: st.tick,
      ascii: app.icons === 2,
    }),
    app.helpOpen ? h(HelpDialog, {
      rows: ['j/k or arrows : move', 'tab / 1-8      : panes', '[ ]            : sub-tabs (cluster)',
        '/              : filter', 't/i/b          : theme/icons/border',
        'ctrl+p or :     : palette', 'd              : delete (type name)',
        'mouse           : n/a in Ink (keyboard only)', 'q              : quit'],
    }) : null,
    app.paletteIsOpen ? h(Palette, {
      query: app.paletteQ,
      matches: app.paletteMatches(),
      selected: app.paletteSelIdx,
      accent,
    }) : null,
    app.confirmOpen ? h(Dialog, {
      title: 'confirm delete',
      lines: [`delete '${fit(app.confirmTarget, 40)}'?`, 'this cannot be undone.'],
      input: app.confirmInput,
      confirm: true,
    }) : null,
  );
}

function subTabCount(app) {
  return app.pane === Pane.Cluster ? 2 : 1;
}

function snapCount(a) {
  return Array.isArray(a) ? a.length : -1;
}

// Legacy Windows console (conhost) without a modern terminal host renders
// Ink frames on top of each other instead of redrawing in place.
export function isLegacyConsole() {
  if (process.platform !== 'win32') return false;
  if (process.env.WT_SESSION) return false; // Windows Terminal
  if (process.env.TERM_PROGRAM || process.env.WEZTERM_EXECUTABLE) return false;
  if (process.env.VSCODE_INJECTION) return false; // VS Code terminal
  return true;
}

export async function runUI(storeHome, demo, theme, icons) {
  if (!process.stdout.isTTY) {
    process.stderr.write('pimg ui: needs an interactive terminal.\n');
    process.stderr.write('hint: use `pimg ui --snapshot [--demo]` for a non-interactive frame.\n');
    return 1;
  }
  if (isLegacyConsole()) {
    process.stderr.write('warning: legacy Windows console detected — the TUI redraws best in Windows Terminal.\n');
    process.stderr.write('hint: `winget install Microsoft.WindowsTerminal`, or use `pimg ui --snapshot`.\n');
  }
  // Fullscreen alternate screen (like the C++ TermSession): frames redraw in
  // place and the previous shell contents are restored on exit.
  const out = process.stdout;
  out.write('\x1b[?1049h\x1b[?25l');
  try {
    const { render } = await import('ink');
    const app = render(React.createElement(PimgUI, { storeHome, demo, themeName: theme, iconsName: icons }), { stdout: out });
    await app.waitUntilExit();
    return 0;
  } finally {
    out.write('\x1b[?25h\x1b[?1049l');
  }
}
