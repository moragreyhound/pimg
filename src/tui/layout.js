// Responsive layout helpers — the "never break" contract.
// Every size read from stdout is clamped; every user/store string is fitted
// to its column with width-aware truncation (CJK-safe via string-width).
import stringWidth from 'string-width';

export const MIN_COLS = 20;
export const MIN_ROWS = 8;
export const DEFAULT_COLS = 100;
export const DEFAULT_ROWS = 24;

export function clampInt(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, Math.floor(n)));
}

// Viewport from an Ink stdout handle (or anything with columns/rows).
// Missing sizes default to 100x24; present ones are clamped to hard floors.
export function viewport(stdout) {
  const cols = stdout?.columns ?? DEFAULT_COLS;
  const rows = stdout?.rows ?? DEFAULT_ROWS;
  return {
    cols: clampInt(cols, MIN_COLS, 500),
    rows: clampInt(rows, MIN_ROWS, 200),
  };
}

export function bp(cols) {
  if (cols < 60) return 'tiny';
  if (cols < 100) return 'compact';
  return 'wide';
}

// Fit text into exactly <= width columns; '…' when truncated, '' when hopeless.
export function fit(text, width) {
  const w = Math.floor(width);
  if (!(w > 0)) return '';
  const s = String(text ?? '');
  if (stringWidth(s) <= w) return s;
  if (w === 1) return '…'.slice(0, 1);
  let out = '';
  for (const ch of s) {
    if (stringWidth(out + ch) > w - 1) break;
    out += ch;
  }
  return out + '…';
}
