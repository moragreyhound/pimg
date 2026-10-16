// TUI theme — port of src/tui/theme.cpp.
// Plain objects; Ink maps roles to chalk/picocolors at render time.
export const Role = {
  Bg: 0, Fg: 1, Dim: 2, Accent: 3, Green: 4, Yellow: 5, Red: 6,
  Magenta: 7, Cyan: 8, Border: 9, Header: 10, SelectedFg: 11, SelectedBg: 12,
};

const C = (r, g, b, c16) => ({ r, g, b, c16 });

export const THEMES = [
  {
    name: 'neon',
    roles: [C(10, 10, 18, 40), C(235, 235, 245, 37), C(120, 120, 140, 90), C(0, 255, 209, 36), C(57, 255, 20, 32), C(255, 233, 0, 33), C(255, 45, 85, 31), C(255, 46, 210, 35), C(0, 255, 209, 36), C(80, 80, 110, 90), C(0, 255, 209, 96), C(0, 0, 0, 30), C(0, 255, 209, 46)],
  },
  {
    name: 'solarized',
    roles: [C(0, 43, 54, 40), C(131, 148, 150, 37), C(88, 110, 117, 90), C(38, 139, 210, 34), C(133, 153, 0, 32), C(181, 137, 0, 33), C(220, 50, 47, 31), C(211, 54, 130, 35), C(42, 161, 152, 36), C(88, 110, 117, 90), C(38, 139, 210, 94), C(0, 43, 54, 30), C(131, 148, 150, 47)],
  },
  {
    name: 'nord',
    roles: [C(46, 52, 64, 40), C(236, 239, 244, 37), C(136, 145, 162, 90), C(136, 192, 208, 36), C(163, 190, 140, 32), C(235, 203, 139, 33), C(191, 97, 106, 31), C(180, 142, 173, 35), C(136, 192, 208, 36), C(76, 86, 106, 90), C(136, 192, 208, 96), C(46, 52, 64, 30), C(136, 192, 208, 47)],
  },
  {
    name: 'high-contrast',
    roles: [C(0, 0, 0, 40), C(255, 255, 255, 37), C(170, 170, 170, 90), C(255, 255, 0, 93), C(0, 255, 0, 92), C(255, 255, 0, 93), C(255, 0, 0, 91), C(255, 0, 255, 95), C(0, 255, 255, 96), C(255, 255, 255, 97), C(255, 255, 0, 93), C(0, 0, 0, 30), C(255, 255, 0, 103)],
  },
];

export function themeByName(name) {
  return THEMES.find((t) => t.name === name) ?? THEMES[0];
}

export function themeNames() {
  return THEMES.map((t) => t.name);
}

export const IconSet = { Nerd: 0, Blocks: 1, Ascii: 2 };

export function iconSetByName(s) {
  if (s === 'ascii') return IconSet.Ascii;
  if (s === 'blocks') return IconSet.Blocks;
  return IconSet.Nerd;
}

export function iconSetName(s) {
  if (s === IconSet.Ascii) return 'ascii';
  if (s === IconSet.Blocks) return 'blocks';
  return 'nerd';
}

export function iconsFor(s) {
  if (s === IconSet.Ascii) {
    return { containers: '[C]', images: '[I]', networks: '[N]', volumes: '[V]', cluster: '[K]', nettools: '[T]', logs: '[L]', settings: '[S]', running: '*', paused: '!', exited: '-', error: 'x', restarting: '~', node: '#', pod: 'o', check: 'v', cross: 'x', arrow: '>', dot: '.', search: '?', gear: '@' };
  }
  if (s === IconSet.Blocks) {
    return { containers: '[#]', images: '[=]', networks: '[~]', volumes: '[%]', cluster: '[*]', nettools: '[?]', logs: '[:=]', settings: '[@]', running: '#', paused: '!', exited: '-', error: 'X', restarting: '%', node: '#', pod: 'o', check: '+', cross: 'x', arrow: '>', dot: '.', search: '?', gear: '*' };
  }
  return { containers: '▣', images: '◉', networks: '⇌', volumes: '▤', cluster: '⬢', nettools: '⚘', logs: '☰', settings: '⚙', running: '●', paused: '◐', exited: '○', error: '●', restarting: '◌', node: '◆', pod: '◇', check: '✓', cross: '✗', arrow: '▶', dot: '·', search: '?', gear: '⚙' };
}

export function borderGlyphs(style, iconSet) {
  const ascii = iconSet === IconSet.Ascii;
  if (style === 2) return ascii ? { tl: '#', tr: '#', bl: '#', br: '#', h: '=', v: '!' } : { tl: '╔', tr: '╗', bl: '╚', br: '╝', h: '═', v: '║' };
  if (style === 0) return ascii ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } : { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' };
  return ascii ? { tl: '+', tr: '+', bl: '+', br: '+', h: '-', v: '|' } : { tl: '╭', tr: '╮', bl: '╰', br: '╯', h: '─', v: '│' };
}

// Map a theme role to an Ink/chalk color string.
export function roleToColor(theme, role) {
  const c = theme.roles[role];
  if (!c) return undefined;
  // High-fidelity truecolor when supported; Ink handles hex strings.
  return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}
