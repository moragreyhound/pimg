// Doctor checks — port of src/doctor.cpp.
// Never requires sudo; every probe degrades gracefully.
import fs from 'node:fs';
import path from 'node:path';
import { Store, fileExists } from './store.js';
import { badge, colorStderr, colorStdout, green, dim, printError, renderTable } from './output.js';

function envIsTermux() {
  const p = process.env.PREFIX;
  return !!p && p.includes('com.termux');
}

export function runDoctorChecks() {
  const isWin = process.platform === 'win32';
  const isApple = process.platform === 'darwin';
  const isLinux = process.platform === 'linux' && !envIsTermux();
  const isAndroid = envIsTermux() || process.env.ANDROID_ROOT !== undefined;
  const out = [];

  // 1. user namespaces
  {
    const c = { name: 'user-namespaces', ok: false, required: false, detail: '', fix: '' };
    if (isLinux) {
      try {
        const t = fs.readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8');
        c.ok = t.includes('1');
        c.detail = c.ok ? 'unprivileged userns enabled' : 'unprivileged_userns_clone=0';
        c.fix = c.ok ? '' : 'ask distro admin to enable unprivileged user namespaces';
      } catch {
        if (fileExists('/proc/self/uid_map')) {
          c.ok = true;
          c.detail = 'uid_map present';
        } else {
          c.detail = 'no /proc uid_map info';
          c.fix = 'pimg will use emulated isolation';
        }
      }
    } else if (isAndroid) {
      c.detail = 'not available on Android';
      c.fix = 'pimg uses proot on Termux (partial isolation)';
    } else if (isApple) {
      c.detail = 'not applicable on macOS';
      c.fix = 'pimg uses process-group sandbox (partial isolation)';
    } else if (isWin) {
      c.detail = 'not applicable on Windows';
      c.fix = 'pimg uses Job Objects + directory tree (partial isolation)';
    }
    out.push(c);
  }

  // 2. cgroup v2
  {
    const c = { name: 'cgroup-v2', ok: false, required: false, detail: '', fix: '' };
    if (isLinux) {
      try {
        const t = fs.readFileSync('/sys/fs/cgroup/cgroup.controllers', 'utf8');
        c.ok = t.length > 0;
        c.detail = c.ok ? 'cgroup v2 controllers present' : 'empty cgroup.controllers';
        c.fix = c.ok ? '' : 'resource limits will be best-effort';
      } catch {
        c.detail = 'cgroup fs not visible (rootless or restricted)';
        c.fix = 'resource limits will be best-effort';
      }
    } else {
      c.detail = isAndroid ? 'not available on Android' : 'not applicable on this OS';
      c.fix = 'resource limits are best-effort';
    }
    out.push(c);
  }

  // 3. proot
  {
    const c = { name: 'proot', ok: false, required: false, detail: '', fix: '' };
    if (isWin) {
      c.detail = 'not applicable on Windows';
    } else {
      const pathv = process.env.PATH ?? '';
      const found = pathv.split(path.delimiter).some((dir) => {
        try {
          return fs.statSync(path.join(dir, 'proot')).isFile();
        } catch {
          return false;
        }
      });
      c.ok = found;
      c.detail = found ? 'proot found in PATH' : 'proot not in PATH';
      c.fix = found ? '' : 'pkg install proot (Termux) for filesystem isolation fallback';
    }
    out.push(c);
  }

  // 4. storage (required)
  {
    const c = { name: 'storage', ok: false, required: true, detail: '', fix: '' };
    const s = Store.resolve('');
    const init = s.init();
    if (init.ok) {
      const w = s.writable();
      if (w.ok) {
        c.ok = true;
        c.detail = `writable: ${s.home}`;
      } else {
        c.detail = `not writable: ${s.home} (${w.err})`;
        c.fix = 'set --home <dir> or $PIMG_HOME to a writable directory';
      }
    } else {
      c.detail = `not writable: ${s.home} (${init.err})`;
      c.fix = 'set --home <dir> or $PIMG_HOME to a writable directory';
    }
    out.push(c);
  }

  // 5. raw sockets (report only)
  out.push({ name: 'raw-sockets', ok: false, required: false, detail: 'report only; pimg falls back to TCP/UDP probes', fix: '' });

  // 6. tty
  {
    const tty = !!process.stdout.isTTY;
    out.push({ name: 'tty', ok: tty, required: false, detail: tty ? 'interactive terminal' : 'non-TTY (plain output, no animations)', fix: '' });
  }

  // 7. color
  {
    const ok = colorStdout() || colorStderr();
    let detail;
    if (process.env.NO_COLOR) detail = 'disabled via NO_COLOR';
    else if (process.env.TERM) detail = process.env.TERM === 'dumb' ? 'disabled (TERM=dumb)' : `TERM=${process.env.TERM}`;
    else detail = ok ? 'ANSI color available' : 'no color (piped?)';
    out.push({ name: 'color', ok, required: false, detail, fix: '' });
  }

  return out;
}

export function cmdDoctor(jsonOut) {
  const checks = runDoctorChecks();
  if (jsonOut) {
    process.stdout.write(
      `{"version":1,"checks":[${checks.map((c) => `{"name":"${c.name}","ok":${c.ok},"required":${c.required}}`).join(',')}]}\n`,
    );
    return 0;
  }
  const rows = checks.map((c) => [c.name, c.ok ? green('ok') : dim('missing'), c.detail, c.fix]);
  process.stdout.write(renderTable(['CHECK', 'STATUS', 'DETAIL', 'FIX'], rows));
  if (checks.some((c) => c.required && !c.ok)) {
    printError('required capability missing', '', 'see FIX column above');
    return 1;
  }
  return 0;
}
