# Praefectus OpenCode

**See which OpenCode sessions are working, need your attention, or are idle — right from the Omarchy bar.** Click to jump to the exact V2 session.

![Praefectus OpenCode example](images/example.png)

```text
5:2|1|1|1
```

**Total : working | response needed | permission needed | idle**

- **One entry per V2 session**, even with several tabs in one terminal.
- **Fresh welcome screens count as idle immediately**, before the first prompt creates a session.
- **No duplicate counting** when a session is open in multiple terminals. Subagents are excluded.
- **Closed working tabs stay visible** until completion, including while awaiting attention.
- **Clickable notifications** for attention and completion. Startup is silent; settings control enablement, colors, and notification timeout (8–30 seconds).

## Compatibility

| OpenCode | Latest tag | What gets tracked |
| --- | --- | --- |
| V1 — legacy build | [v5](https://github.com/jcergolj/praefectus-opencode/releases/tag/v5) | Terminal processes |
| V2 — full-screen TUI | [v6](https://github.com/jcergolj/praefectus-opencode/releases/tag/v6) | Individual top-level sessions |

**v6 also supports V1 1.18.29+.** Praefectus tag numbers are not OpenCode version numbers; **v5 is V1-only**.

V2 supports local TUIs, `--standalone`, and remote-server connections. **Not supported:** Mini, headless `opencode run`, browser/desktop sessions, or saved history. Open idle tabs and the displayed welcome screen count. A welcome-screen entry is replaced by the real session after the first prompt, without double-counting. With tabs disabled, the displayed top-level session or welcome screen is tracked.

## Install

Requires **Omarchy, Hyprland, and Python 3**. tmux is optional.

### 1. Install the widget

```bash
omarchy plugin add https://github.com/jcergolj/praefectus-opencode.git --enable
```

### 2. Connect OpenCode V2

**The V2 bridge is required.** Add this plugin to `~/.config/opencode/cli.json` (or `$XDG_CONFIG_HOME/opencode/cli.json`):

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/home/YOUR_USER/.config/omarchy/plugins/praefectus.opencode/plugin"]
}
```

> **Replace `YOUR_USER` and preserve existing settings/plugins.** Use the absolute **directory** path, not `plugin/index.js`.

### 3. Restart your OpenCode TUIs

**No background-service restart needed.**

<details>
<summary><strong>Using OpenCode V1 instead?</strong></summary>

For V1 **1.18.29+** with the current build:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s "$HOME/.config/omarchy/plugins/praefectus.opencode/plugin/index.js" ~/.config/opencode/plugins/praefectus-opencode.js
```

Restart OpenCode. Without this bridge, V1 terminals appear as idle. V1 status and notifications aggregate hosted sessions; focusing selects the terminal/pane, not an individual tab.

**Upgrading to V2?** Configure `cli.json` above; the V1 symlink alone will not work.

</details>

## Use it

**Click a counter → choose a session → jump to it.** Click the row arrow for details, including context usage when available.

In the panel: **↑/↓** select, **Enter** focus, **Escape** close, **r** clear the filter. Sessions sharing a directory get stable Roman-numeral suffixes.

Closed-session notification clicks reopen the exact V2 session **while an owning TUI is still running**.

<details>
<summary><strong>Optional keyboard shortcuts</strong></summary>

Check conflicts with `omarchy menu keybindings --print`. Choose unused keys, or call `hl.unbind("SUPER + ALT + W")` before replacing an existing binding.

Add to `~/.config/hypr/bindings.lua`:

```lua
local watcher = os.getenv("HOME") .. "/.config/omarchy/plugins/praefectus.opencode/bin/opencode-watch"

o.bind("SUPER + ALT + W", "OpenCode: working", watcher .. " --focus-state working")
o.bind("SUPER + ALT + R", "OpenCode: response", watcher .. " --focus-state response")
o.bind("SUPER + ALT + P", "OpenCode: permission", watcher .. " --focus-state permission")
o.bind("SUPER + ALT + I", "OpenCode: idle", watcher .. " --focus-state idle")
o.bind("SUPER + ALT + TAB", "OpenCode: next", watcher .. " --focus-next")
o.bind("SUPER + ALT + SHIFT + TAB", "OpenCode: previous", watcher .. " --focus-previous")
```

Repeated presses cycle through matching sessions, including V2 tabs in the same terminal.

Validate after saving:

```bash
hyprctl reload
hyprctl configerrors
```

</details>

## Update

```bash
omarchy plugin update praefectus.opencode
```

**Restart your OpenCode TUIs afterward.** The widget reloads automatically; existing bridge configuration stays valid. Preserve any local plugin edits before updating.

## Something wrong?

| Symptom | Check |
| --- | --- |
| **`!` in the bar** | Click it for the warning. Check the bridge path and restart OpenCode. |
| **No V2 sessions** | Use v6+, a full-screen TUI, and the configured V2 bridge. |
| **A click cannot reopen a session** | An owning TUI must still be running. Otherwise, use OpenCode's history. |
| **Widget hasn't refreshed** | Run `omarchy restart shell`. |

Inspect the current snapshot:

```bash
~/.config/omarchy/plugins/praefectus.opencode/bin/opencode-watch --once
```

**Privacy:** uses public OpenCode APIs, not terminal scraping or private storage. Runtime records live in `$XDG_RUNTIME_DIR/praefectus-opencode/` (fallback: `~/.cache/praefectus-opencode/`). Process-lifetime checks prevent stale PID reuse.

## Uninstall

1. **V2:** remove only the Praefectus entry from `cli.json`. **V1:** remove `~/.config/opencode/plugins/praefectus-opencode.js`.
2. Remove the widget:

   ```bash
   omarchy plugin remove praefectus.opencode
   ```

3. Restart OpenCode.

## Tests

Requires Python 3 and Node.js; no desktop needed.

```bash
python3 -m unittest discover -s tests -v
node --test tests/test_*.mjs
```

## License

[MIT](LICENSE)
