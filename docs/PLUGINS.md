# Plugin development

`pimg` loads plugins from `<home>/plugins/<name>/` (`$PIMG_HOME` or the
`--home` dir). No registry, no install step: copy a directory and it works.
List them with `pimg plugin list`, run explicitly with
`pimg plugin run <plugin> <command> [args]`, or use the shorthand
`pimg <plugin> <command> [args]`.

## Minimal plugin

```
my-plugin/
  plugin.js        # ESM, exports `commands`
  package.json     # optional, adds version + descriptions
```

```js
// plugin.js
export const commands = {
  greet: {
    description: 'greet someone',
    async run({ args, flags, store, home, json, pluginName }) {
      const name = flags.get('name') ?? args[0] ?? 'world';
      if (json) console.log(JSON.stringify({ hello: name }));
      else console.log(`hello, ${name}`);
      return 0; // numeric exit code (default 0)
    },
  },
};
```

```jsonc
// package.json (optional)
{
  "name": "pimg-plugin-greet",
  "version": "0.1.0",
  "main": "plugin.js",
  "pimg": {
    "commands": { "greet": "greet someone" }
  }
}
```

See `plugins/hello/` for a runnable example.

## Context reference

`run(ctx)` receives:

| Field | Type | Notes |
|---|---|---|
| `args` | `string[]` | positional args after `<plugin> <command>` |
| `flags` | `Map` | parsed `--key value` / `--key=value` / booleans |
| `store` | `Store` | resolved store (`.home`, `.blobs`, …); call `store.init()` first if writing |
| `home` | `string` | resolved home dir |
| `json` | `boolean` | global `--json` was passed — emit machine JSON |
| `pluginName` | `string` | your plugin's directory name |

Throw to fail: the CLI prints `error: plugin '<name>' failed / cause: …` and
exits 1. Unknown commands fail at dispatch with the available list.

## Reusing pimg internals

Plugins can import sibling modules by relative path, e.g.
`./store.js`, `./tui/widgets.js` (Sparkline, Gauge, ProgressList, Keybar,
Dialog, …), `./tui/sysicons.js` (OS/arch glyphs). These are semver-unstable
across `pimg` releases — pin what you rely on.

## Trust model

Plugins run **in-process with your full user privileges** — no sandbox.
Only install plugin directories you trust, same as running any script.
A malicious plugin can read/write your home, network, and store.
(`docs/THREAT_MODEL.md` in the C++ tree covers the base threat model.)
