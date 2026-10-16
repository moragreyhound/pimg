// System icons — OS / platform / arch / distro glyphs for the TUI.
// Three sets matching theme.js IconSet order (Nerd=0, Blocks=1, Ascii=2).
// Nerd glyphs are plain Unicode (no private-use codepoints, no emoji) so they
// degrade to tofu — never mojibake — without a Nerd Font.
import fs from 'node:fs';
import os from 'node:os';

// Canonical platform key from anywhere: 'linux', 'windows', 'darwin', ...
export function canonPlatform(p = process.platform) {
  const s = String(p).toLowerCase();
  if (s.startsWith('win')) return 'windows';
  if (s === 'macos' || s === 'darwin') return 'darwin';
  if (s.startsWith('linux') || s.includes('android')) return 'linux';
  if (s.includes('bsd')) return 'bsd';
  return s || 'unknown';
}

export function osIcon(platform = process.platform, set = 0) {
  const c = canonPlatform(platform);
  if (set === 2) {
    return c === 'linux' ? '(lin)' : c === 'windows' ? '(win)' : c === 'darwin' ? '(mac)' : c === 'bsd' ? '(bsd)' : '(os)';
  }
  if (set === 1) {
    return c === 'linux' ? '[L]' : c === 'windows' ? '[W]' : c === 'darwin' ? '[M]' : c === 'bsd' ? '[B]' : '[?]';
  }
  return c === 'linux' ? '⬢' : c === 'windows' ? '◫' : c === 'darwin' ? '⬣' : c === 'bsd' ? '◭' : '○';
}

export function archIcon(arch = process.arch, set = 0) {
  const a = String(arch).toLowerCase();
  const short = a === 'x64' || a === 'amd64' ? 'x64' : a === 'arm64' || a === 'aarch64' ? 'arm64' : a;
  if (set === 2) return `(${short})`;
  if (set === 1) return `[${short}]`;
  return short === 'x64' ? '◇x64' : short === 'arm64' ? '◇arm' : `◇${short}`;
}

// `os/arch` pair with icons, e.g. "⬢ linux/◇arm64".
export function platformLabel(osName = '', arch = '', set = 0) {
  if (!osName && !arch) return '-';
  const o = osName ? `${osIcon(osName, set)} ${osName}` : '';
  const a = arch ? `${archIcon(arch, set)}` : '';
  return [o, a].filter(Boolean).join(' ');
}

// Host distro id from /etc/os-release (ubuntu, alpine, ...), '' if unknown.
export function hostDistro() {
  if (process.platform !== 'linux' && process.platform !== 'android') return '';
  try {
    const text = fs.readFileSync('/etc/os-release', 'utf8');
    const m = /^ID=(.+)$/m.exec(text);
    return (m?.[1] ?? '').trim().replace(/^"|"$/g, '').toLowerCase();
  } catch {
    return '';
  }
}

// One-line host summary for the TUI/logs pane, e.g. "⬢ linux (ubuntu) ◇x64".
export function hostLabel(set = 0) {
  const plat = canonPlatform();
  const distro = hostDistro();
  const parts = [`${osIcon(plat, set)} ${plat}`];
  if (distro) parts.push(`(${distro})`);
  parts.push(archIcon(os.arch(), set));
  return parts.join(' ');
}
