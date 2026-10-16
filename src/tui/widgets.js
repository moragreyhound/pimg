// Ink widget library — port of src/tui/widgets.cpp, extended.
// No-JSX (React.createElement) so no build step is needed. All widgets take
// plain props and are unit-testable via renderSnapshot-free pure helpers
// exported alongside (sparkCells, barCells, gaugeCells).
import React from 'react';
import { Box, Text } from 'ink';
import stringWidth from 'string-width';
import { roleToColor } from './theme.js';

const h = React.createElement;
const BLOCKS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

// --- pure helpers (tested) ---

export function sparkCells(values, width) {
  const vals = values.slice(Math.max(0, values.length - width));
  while (vals.length < width) vals.unshift(0);
  return vals.map((v) => BLOCKS[Math.min(7, Math.max(0, Math.round(v * 7)))]);
}

export function sparkAscii(values, width) {
  const vals = values.slice(Math.max(0, values.length - width));
  while (vals.length < width) vals.unshift(0);
  return vals.map((v) => (v > 0.66 ? '#' : v > 0.33 ? '-' : '.')).join('');
}

export function gaugeCells(frac, width) {
  const f = Math.min(1, Math.max(0, frac));
  const fill = Math.round(f * width);
  return { fill, empty: width - fill, pct: Math.round(f * 100) };
}

// --- components ---

export function Sparkline({ values = [], width = 12, color, ascii = false }) {
  const text = ascii ? sparkAscii(values, width) : sparkCells(values, width).join('');
  return h(Text, { color }, text);
}

export function Gauge({ frac = 0, width = 20, color, label = '' }) {
  const { fill, empty, pct } = gaugeCells(frac, width);
  return h(Text, null,
    h(Text, { color }, '█'.repeat(fill)),
    h(Text, { dimColor: true }, '░'.repeat(empty)),
    label ? h(Text, { dimColor: true }, ` ${label}`) : null,
    h(Text, { dimColor: true }, ` ${pct}%`));
}

// Horizontal labeled bars: [{ label, frac }].
export function BarChart({ rows = [], width = 16, color }) {
  return h(Box, { flexDirection: 'column' },
    ...rows.map((r, i) => {
      const { fill, empty, pct } = gaugeCells(r.frac, width);
      return h(Text, { key: i },
        h(Text, null, `${String(r.label).padEnd(10)} `),
        h(Text, { color }, '█'.repeat(fill)),
        h(Text, { dimColor: true }, '░'.repeat(empty)),
        h(Text, { dimColor: true }, ` ${pct}%`));
    }));
}

// Parallel progress list: [{ label, done, total }]. Bar per row.
export function ProgressList({ items = [], width = 16, color }) {
  return h(Box, { flexDirection: 'column' },
    ...items.map((it, i) => {
      const frac = it.total > 0 ? it.done / it.total : 0;
      const { fill, empty, pct } = gaugeCells(frac, width);
      return h(Text, { key: it.label + i },
        h(Text, null, `${String(it.label).slice(0, 18).padEnd(18)} `),
        h(Text, { color }, '█'.repeat(fill)),
        h(Text, { dimColor: true }, '░'.repeat(empty)),
        h(Text, { dimColor: true }, ` ${pct}%`));
    }));
}

export function Keybar({ keys = [], tick = 0, ascii = false }) {
  const frames = ascii ? ['-', '\\', '|', '/'] : ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const spin = frames[((tick % frames.length) + frames.length) % frames.length];
  return h(Box, null,
    ...keys.flatMap(([k, label], i) => [
      h(Text, { key: `k${i}`, bold: true }, k),
      h(Text, { key: `l${i}`, dimColor: true }, ` ${label}`),
      h(Text, { key: `s${i}`, dimColor: true }, ' · '),
    ]),
    h(Text, { key: 'spin', dimColor: true }, `${spin} live`));
}

export function Sidebar({ items = [], selected = 0, width = 22, accent }) {
  return h(Box, { flexDirection: 'column', width, borderStyle: 'single', paddingX: 1 },
    ...items.map((it, i) => h(Text, {
      key: it.label,
      color: i === selected ? accent : undefined,
      bold: i === selected,
    }, `${i === selected ? '>' : ' '}${it.icon ? `${it.icon} ` : ''}${it.label}${it.badge != null && it.badge >= 0 ? ` ${it.badge}` : ''}`)));
}

// Modal dialog. confirm=true renders type-to-confirm echo.
export function Dialog({ title = '', lines = [], input = '', confirm = false }) {
  return h(Box, { borderStyle: 'round', flexDirection: 'column', paddingX: 2, width: 52 },
    h(Text, { bold: true }, title),
    ...lines.map((l, i) => h(Text, { key: i }, l)),
    confirm ? h(Text, { key: 'in', dimColor: true }, `type name to confirm: ${input}_`) : null);
}

export function HelpDialog({ rows = [] }) {
  return h(Box, { borderStyle: 'round', flexDirection: 'column', paddingX: 2, width: 44 },
    h(Text, { bold: true }, 'help'),
    ...rows.map((r, i) => h(Text, { key: i }, r)));
}

export function Palette({ query = '', matches = [], selected = 0, accent }) {
  return h(Box, { borderStyle: 'round', flexDirection: 'column', paddingX: 2, width: 56 },
    h(Text, { key: 'prompt', bold: true }, `> ${query}▊`),
    ...matches.slice(0, 8).map((m, i) =>
      h(Text, { key: m, backgroundColor: i === selected ? accent : undefined }, m)));
}

// Color-palette showcase: every theme role as a labeled swatch.
export function Swatches({ theme, columns = 2 }) {
  const names = ['bg', 'fg', 'dim', 'accent', 'green', 'yellow', 'red', 'magenta', 'cyan', 'border', 'header', 'sel-fg', 'sel-bg'];
  const cells = names.map((name, i) => {
    const color = roleToColor(theme, i);
    return h(Text, { key: name }, `${name.padEnd(7)} `, h(Text, { backgroundColor: color }, '   '));
  });
  const rows = [];
  for (let i = 0; i < cells.length; i += columns) rows.push(cells.slice(i, i + columns));
  return h(Box, { flexDirection: 'column' },
    ...rows.map((r, i) => h(Box, { key: i, flexDirection: 'row', gap: 2 }, ...r)));
}

// Tab strip for sub-views.
export function Tabs({ tabs = [], selected = 0, accent }) {
  return h(Box, { flexDirection: 'row' },
    ...tabs.flatMap((t, i) => [
      h(Text, { key: t, color: i === selected ? accent : undefined, bold: i === selected },
        `${i === selected ? '[' : ' '}${t}${i === selected ? ']' : ' '} `),
    ]));
}

// Numeric width helper re-export for layout code.
export { stringWidth };
