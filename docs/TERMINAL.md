# Terminal support (`pimg ui`)

The interactive TUI needs a terminal that understands ANSI cursor movement
and redraws frames in place. `pimg ui` now runs **fullscreen** in the
alternate screen (like the C++ `TermSession`): lists are sliced and scrolled
to your window height, and your shell contents are restored on exit.

## Recommended terminals

| OS | Use |
|---|---|
| Windows | **Windows Terminal** (`winget install Microsoft.WindowsTerminal`), VS Code terminal, WezTerm |
| macOS / Linux | Terminal.app, GNOME Terminal, Alacritty, WezTerm, tmux/screen |
| Android | Termux (install a Nerd Font for full glyphs, else `pimg ui --icons ascii`) |

## Legacy Windows console (conhost)

`powershell.exe` 5.1 in the old console host repaints frames on top of each
other instead of redrawing in place, so the screen fills with stacked boxes.
`pimg` detects this and prints:

```
warning: legacy Windows console detected — the TUI redraws best in Windows Terminal.
```

Your options, best first:

1. Switch to Windows Terminal (one install, everything works).
2. Stay put and use non-interactive mode: `pimg ui --snapshot [--demo]
   [--cols N] [--rows N] [--theme NAME] [--icons NAME]` prints one frame.
3. Force ASCII glyphs if you see tofu boxes: `--icons ascii`
   (also honors `NO_ICONS=1` and `TERM=dumb`).

## Non-TTY output

Piped or redirected (`pimg ui | cat`, CI logs): interactive mode refuses
with a hint and exit 1 — use `--snapshot`. Colors honor the usual contract:
`--no-color`, `NO_COLOR`, `TERM=dumb`, `CLICOLOR=0` disable; `CLICOLOR_FORCE`
forces.

## Keys

arrows/hjkl move · tab / 1-8 panes · `[` `]` sub-tabs (cluster) ·
`/` filter · `t`/`T` theme · `i` icons · `b` border · `:` or ctrl+p palette ·
`?` help · `d` delete (type name to confirm) · `q` quit.
