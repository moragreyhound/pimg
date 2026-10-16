// Live host stats — CPU + memory sampler for the TUI top bar.
// CPU needs /proc/stat deltas (Linux) with an os.cpus() fallback elsewhere.
// Android (Termux) restricts /proc/stat and reports misleading values, so the
// CPU probe is skipped there by design: cpuAvailable=false, CPU renders n/a,
// memory (os.totalmem/freemem, always allowed) is still reported.
import fs from 'node:fs';
import os from 'node:os';

const HIST_LEN = 12;

export function isAndroid() {
  const p = process.env.PREFIX;
  if (p && p.includes('com.termux')) return true;
  return process.env.ANDROID_ROOT !== undefined;
}

// Parse the aggregate `cpu ...` line of /proc/stat into { idle, total }.
// null when unreadable or malformed — caller degrades, never throws.
export function readProcStat() {
  try {
    const text = fs.readFileSync('/proc/stat', 'utf8');
    const line = text.split('\n').find((l) => l.startsWith('cpu '));
    if (!line) return null;
    const parts = line.trim().split(/\s+/).slice(1).map(Number);
    if (parts.length < 4 || parts.some((n) => !Number.isFinite(n))) return null;
    const idle = parts[3] + (parts[4] ?? 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);
    return { idle, total };
  } catch {
    return null;
  }
}

// Aggregate os.cpus() times into the same { idle, total } shape.
export function readCpuTimes() {
  try {
    const cpus = os.cpus();
    if (!cpus.length) return null;
    let idle = 0;
    let total = 0;
    for (const c of cpus) {
      idle += c.times.idle;
      total += c.times.user + c.times.nice + c.times.sys + c.times.idle + c.times.irq;
    }
    return { idle, total };
  } catch {
    return null;
  }
}

// Classic idle/total delta -> 0..100. null when no valid delta (first sample,
// counter wrap, zero elapsed) so callers can hold the previous value.
export function cpuPercentBetween(prev, cur) {
  if (!prev || !cur) return null;
  const totalD = cur.total - prev.total;
  const idleDelta = cur.idle - prev.idle;
  if (!(totalD > 0) || idleDelta < 0 || idleDelta > totalD) return null;
  return ((totalD - idleDelta) / totalD) * 100;
}

let lastCpu = null;
let histCpu = [];
let histMem = [];

export function resetStats() {
  lastCpu = null;
  histCpu = [];
  histMem = [];
}

function pushHist(arr, v) {
  arr.push(v);
  if (arr.length > HIST_LEN) arr.splice(0, arr.length - HIST_LEN);
  return [...arr];
}

export function memPercent() {
  try {
    const total = os.totalmem();
    if (!(total > 0)) return 0;
    return ((total - os.freemem()) / total) * 100;
  } catch {
    return 0;
  }
}

// One sampler tick. Never throws; CPU fields degrade to skipped/unavailable.
export function sampleLiveStats() {
  const mem = memPercent();
  histMem = pushHist(histMem, mem / 100);

  if (isAndroid()) {
    return { cpuPct: null, memPct: mem, cpuHist: [], memHist: [...histMem], cpuAvailable: false };
  }

  const cur = process.platform === 'linux' ? readProcStat() ?? readCpuTimes() : readCpuTimes();
  if (!cur) {
    return { cpuPct: null, memPct: mem, cpuHist: [...histCpu], memHist: [...histMem], cpuAvailable: false };
  }
  const pct = cpuPercentBetween(lastCpu, cur);
  lastCpu = cur;
  if (pct === null) {
    return { cpuPct: 0, memPct: mem, cpuHist: [...histCpu], memHist: [...histMem], cpuAvailable: true };
  }
  histCpu = pushHist(histCpu, Math.min(1, Math.max(0, pct / 100)));
  return { cpuPct: pct, memPct: mem, cpuHist: [...histCpu], memHist: [...histMem], cpuAvailable: true };
}
