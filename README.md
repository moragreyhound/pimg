# pimg (Node.js port)

Portable images & containers — no root required. Faithful port of the C++ `pimg`,
with all phases implemented: the registry client even gets TLS for free via
`fetch` (the C++ build deferred that decision).

## Libraries used

| Concern | Library | Why |
|---|---|---|
| Interactive TUI | `ink` + `react` | panes, tabs, palette, help, confirm dialogs |
| TUI widgets | `src/tui/widgets.js` | Sparkline, Gauge, BarChart, ProgressList, Keybar, Sidebar, Dialog, Palette, Tabs |
| System icons | `src/tui/sysicons.js` | OS/platform/arch/distro glyphs (nerd/blocks/ascii, no emoji, no PUA) |
| Colors | `picocolors` | ~2KB ANSI painter |
| Width/tables | `string-width` | CJK/combining/ANSI-aware tables |
| Hashing | `node:crypto` | native SHA-256, streaming file hash |
| Registry/auth | global `fetch` | HTTPS + Docker Hub token flow, no extra deps |
| FS/paths/process | `node:fs`, `path`, `os`, `child_process` | store, runtime supervision, stats |
| Tests | `vitest` | 47 tests incl. live registry/runtime fixtures |

Perf notes:
- `ink`/`react` are **dynamically imported** only for `pimg ui`.
- File hashing and blob downloads stream (constant memory).
- ESM, no transpiler (Ink UI uses `React.createElement`).

## Install / run

```sh
cd pimg-node
npm install
node ./bin/pimg.js --help
npm test
```

Windows: `start.bat --help` (auto-installs deps on first run).

## Standalone binary (no Node required)

`npm run build:binary` (or `build.bat`) compiles `dist/pimg.exe` (~90 MB,
Node runtime embedded) via esbuild + Node.js Single Executable Applications:

- Ink needs ESM (top-level await), but the SEA runtime evaluates `main` as
  CJS — so a tiny CJS loader (`scripts/sea-entry.cjs`) imports the bundled
  ESM app from an embedded asset via a content-hashed temp file.
- The SEA fuse suffix varies by Node release; the script reads it from your
  `node` binary instead of hardcoding it.
- Ink's optional `react-devtools-core` peer is stubbed at bundle time.
- Inside the binary, `process.argv` is `[exe, exe, ...args]` — the entry
  point drops the duplicate (verified on Node 24).
- postject invalidates the copied binary's Authenticode signature
  ("signature seems corrupted" warning) — harmless locally; re-sign before
  distributing.

## Terminal support

`pimg ui` runs fullscreen in the alternate screen. On legacy Windows
conhost it degrades visibly — use Windows Terminal or `pimg ui --snapshot`.
Details: `docs/TERMINAL.md`.

## Commands

- Images: `pull [--platform os/arch] [--plain-http]` (per-layer progress bars),
  `push`, `images`, `tag`, `rmi`, `history`, `save [-o FILE]` / `load` (tar +
  progress, traversal-guarded), `prune`, `inspect <name|layout>`, `digest`
- Runtime (emulated, supervised processes): `run --name N <img> [-- cmd]`,
  `ps [-a]`, `start|stop|kill|rm`, `logs [--tail N]`, `stats`
- Network (no raw sockets): `network create|ls|rm|inspect`,
  `net ping|dns|http|scan`
- Cluster (single-node, file-backed): `cluster init|status|nodes|top`,
  `apply|delete|diff -f FILE`, `get|describe <kind> [name]`, `scale --replicas N`
- Fleet (kubernetes-style): `serve`, `login`, `agent`, `nodes`, `top`,
  `revision list|diff|rollback`, `rbac list|user|token|grant` — see `docs/CLUSTER.md`
- `plugin list|run`, or `pimg <plugin> <cmd>` shorthand — see `docs/PLUGINS.md`
- `doctor`, `ui [--demo] [--snapshot]` (live CPU/MEM; CPU skipped → `n/a` on Android)

Registry auth: `PIMG_REGISTRY_USER` / `PIMG_REGISTRY_PASS` env.

## Layout

`src/registry.js` pull/push · `src/images.js` local ops + tar ·
`src/runtime.js` emulated runtime · `src/nettools.js` probes ·
`src/cluster.js` reconciler · `src/plugins.js` plugin loader ·
`src/stats.js` live stats (Android CPU skip) · `src/tui/` Ink UI +
widgets + system icons · `plugins/hello/` example plugin.
