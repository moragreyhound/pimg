// Output helpers — port of src/output.cpp.
// Optimized: picocolors for zero-cost ANSI, string-width for unicode-aware
// table layout. Global init mirrors output_init() so --no-color/--quiet
// propagate everywhere without threading opts through every call.
import pc from 'picocolors';
import stringWidth from 'string-width';

let noColor = false;
let quiet = false;

export function outputInit(o = {}) {
  noColor = !!o.noColor;
  quiet = !!o.quiet;
  if (noColor) pc.isColorSupported = false;
}

function envSet(k) {
  const v = process.env[k];
  return v !== undefined && v !== '';
}

export function colorStdout() {
  if (noColor) return false;
  if (envSet('NO_COLOR')) return false;
  if (envSet('CLICOLOR_FORCE')) return true;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.CLICOLOR === '0') return false;
  return !!process.stdout.isTTY;
}

export function colorStderr() {
  if (noColor) return false;
  if (envSet('NO_COLOR')) return false;
  if (envSet('CLICOLOR_FORCE')) return true;
  if (process.env.TERM === 'dumb') return false;
  if (process.env.CLICOLOR === '0') return false;
  return !!process.stderr.isTTY;
}

const paint = (on, fn) => (s) => (on() ? fn(s) : s);

export const green = (s) => (colorStdout() ? pc.green(s) : s);
export const yellow = (s) => (colorStdout() ? pc.yellow(s) : s);
export const red = (s) => (colorStdout() ? pc.red(s) : s);
export const cyan = (s) => (colorStdout() ? pc.cyan(s) : s);
export const dim = (s) => (colorStdout() ? pc.dim(s) : s);
export const magenta = (s) => (colorStdout() ? pc.magenta(s) : s);
export { paint };

export function badge(status) {
  switch (status) {
    case 'running': return green(status);
    case 'paused': return yellow(status);
    case 'restarting': return magenta(status);
    case 'error':
    case 'failed': return red(status);
    default: return dim(status);
  }
}

export function printError(msg, cause = '', hint = '') {
  if (quiet) return;
  const prefix = colorStderr() ? pc.red('error:') + ' ' : 'error: ';
  process.stderr.write(`${prefix}${msg}\n`);
  if (cause) process.stderr.write(`  cause: ${cause}\n`);
  if (hint) process.stderr.write(`  hint: ${hint}\n`);
}

export function printSuccess(msg) {
  if (quiet) return;
  process.stdout.write(`${green('ok')}: ${msg}\n`);
}

export function printWarn(msg) {
  if (quiet) return;
  const p = colorStderr() ? pc.yellow('warning:') + ' ' : 'warning: ';
  process.stderr.write(`${p}${msg}\n`);
}

export function isQuiet() {
  return quiet;
}

// string-width already strips ANSI and handles CJK/combining.
export const dispWidth = (s) => stringWidth(s);

export function renderTable(headers, rows) {
  const n = headers.length;
  const widths = headers.map((h) => dispWidth(h));
  for (const r of rows) {
    for (let i = 0; i < n; i++) {
      const c = i < r.length ? r[i] : '';
      const w = dispWidth(c);
      if (w > widths[i]) widths[i] = w;
    }
  }
  let out = '';
  for (let i = 0; i < n; i++) {
    if (i) out += '  ';
    out += headers[i] + ' '.repeat(Math.max(0, widths[i] - dispWidth(headers[i])));
  }
  out += '\n';
  for (const r of rows) {
    for (let i = 0; i < n; i++) {
      if (i) out += '  ';
      const c = i < r.length ? r[i] : '';
      out += c + ' '.repeat(Math.max(0, widths[i] - dispWidth(c)));
    }
    out += '\n';
  }
  return out;
}

// Minimal stderr progress bar. Hidden when --quiet, non-TTY, or total=0.
export class ProgressBar {
  constructor(msg, total) {
    this.msg = msg;
    this.total = total;
    this.done = 0;
    this.lastDraw = -1n >= 0 ? -1 : -1;
    this.hidden = quiet || !process.stderr.isTTY || !total;
    this.finished = false;
  }
  update(done) {
    this.done = done;
    if (this.hidden || done === this.lastDraw) return;
    this.lastDraw = done;
    const pct = this.total ? Math.floor((Number(done) * 100) / Number(this.total)) : 0;
    const bars = Math.floor(pct / 5);
    const bar = '='.repeat(bars) + ' '.repeat(20 - bars);
    process.stderr.write(`\r${this.msg} [${bar}] ${done}/${this.total} ${pct}%`);
  }
  finish() {
    if (this.hidden || this.finished) return;
    this.finished = true;
    process.stderr.write('\n');
  }
}
