# Praefectus OpenCode

Keep track of all your OpenCode sessions directly from the Omarchy bar.

Praefectus shows which OpenCode sessions are **working**, **waiting for your response**, **waiting for permission**, or **idle** — and lets you jump straight to the relevant session, terminal, or tmux pane.

![Praefectus OpenCode example](images/example.png)

## Why?

Running several OpenCode sessions at once gets difficult surprisingly quickly, if you aren't constantly focused on the terminal.

Which one is still working?
Which agent is waiting for permission?
Which terminal needs your response?

Praefectus gives you a small command center in your Omarchy bar:

```text
5:2|1|1|1
```

Where:

* `5` — total OpenCode sessions
* `2` — working
* `1` — waiting for your response
* `1` — waiting for permission
* `1` — idle

Click any counter to see the matching sessions, then click a session to focus its
terminal or tmux pane. On V2, this also selects that exact OpenCode session.

Sessions in the same directory get Roman-numeral suffixes in creation order:
`foo bar`, `foo bar II`, `foo bar III`, and so on. Titles stay stable when another
session closes; numbering resets once all sessions in that directory close.

## Features

* Live status of local full-screen OpenCode V2 sessions
* Working, response, permission and idle states
* Clickable session lists
* Select the exact V2 session when focusing its terminal or tmux pane
* Cycle between individual sessions, including tabs in the same terminal
* Independent attention and completion notifications for each V2 session
* Keep closed working or attention tabs visible until completion
* Count the same V2 session once when open in multiple terminals
* Context-window usage when OpenCode exposes token metadata
* Optional colored counters
* No V2 subagent tracking; nested OpenCode processes are also excluded
* OpenCode V1 process-based tracking remains supported
* Does not scrape terminal output or read OpenCode's private storage

## Installation

### OpenCode version compatibility

**Praefectus release numbers are not OpenCode version numbers.**

| OpenCode version | Latest recommended tag | Tracking |
| --- | --- | --- |
| V1 — legacy V1-only build | [v5](https://github.com/jcergolj/praefectus-opencode/releases/tag/v5) | One entry per terminal process |
| V2 — full-screen TUI | [v6](https://github.com/jcergolj/praefectus-opencode/releases/tag/v6) | One entry per unique top-level session; exact-session navigation |

**v6 also supports OpenCode V1 1.18.29+.** You do not need separate builds when
using both OpenCode versions. V2's original terminal bridge was smoke-tested on
OpenCode **2.0.24**; individual-session tracking has automated regression coverage.

**Compatibility note:** `v5` originally advertised V2 support, but contains
V1-only code. Its release notes have been corrected without changing the tag.
Use **v6** for V2 support.

The same bundled source supports both versions; you do not need separate
Praefectus builds. OpenCode selects the V1 server adapter or V2 terminal adapter.
The watcher, focus commands, and notification policy support both record formats.
Installation differs because V2 runs a shared background server and
uses a separate terminal plugin API. Older V1 versions are not supported by
the current object entrypoint.

For a pinned checkout, select `v5` for the legacy V1-only build or `v6` for V2
support in a clean clone. The installation commands below use the current build;
the V2 bridge is not available in `v5`.

### Omarchy widget

Requires Omarchy with Hyprland and Python 3. tmux is optional; when present,
Praefectus can focus the pane hosting a session.

Install the Omarchy plugin:

```bash
omarchy plugin add https://github.com/jcergolj/praefectus-opencode.git --enable
```

The widget and OpenCode's status bridge are separate integrations. V1 can detect
terminal processes without the bridge (as idle); its bridge adds live states.
**V2 requires the TUI bridge** to discover individual open sessions. A V2 terminal
without valid bridge data produces a `!` warning in the bar (details in the
session panel), not an invented idle entry.

### OpenCode V2 status bridge

Merge this entry into the `plugins` array in `~/.config/opencode/cli.json`
(`$XDG_CONFIG_HOME/opencode/cli.json` if set), preserving other settings/plugins:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["/path/to/praefectus-opencode/plugin"]
}
```

Use the absolute path to the bundled **directory**, not `plugin/index.js`.
For a standard Omarchy installation this is
`/home/YOUR_USER/.config/omarchy/plugins/praefectus.opencode/plugin`.
Restart the OpenCode TUI after adding it. No background-service restart is needed.

The V2 bridge runs in each local terminal and reads OpenCode's public CLI data
every 500 ms. Each open top-level tab is counted separately, including idle tabs.
With tabs disabled, it tracks the displayed top-level session. Saved history and
unrelated sessions on the shared server are excluded; empty terminals count as
zero. Subagents are never tracked or aggregated into the parent's status.
Restored busy sessions and their own permissions/response forms are included.
The background service is not counted as another terminal.

The same session open in several terminals counts once, with those terminals
retained as focus alternatives. Identity is scoped to the connected server's
public server-info fingerprint, not to the terminal PID.

Closing a working tab keeps its session visible until it finishes, including
while it awaits permission or a response. Clicking it reopens the exact session.
Closed-tab completion is delivered separately from the counted entries, so its
notification remains clickable after the entry disappears. Reopening is possible
while at least one of its owning TUIs is still running; notifications never attach
to a replacement process that reused an old PID.

V2 live status currently covers the **full-screen TUI**, including
`--standalone` and connections to remote servers. `opencode mini`, headless
`opencode run`, and the browser/desktop UI do not load this TUI adapter.
Each counter entry represents a unique top-level session. Entry clicks,
notification clicks, and keyboard cycling switch to that exact session through
a user-private local Unix socket into the owning TUI. Tabs are focused/reopened
using OpenCode's public tabs API, or its router when tabs are disabled.

### OpenCode V1 status bridge

For OpenCode **1.18.29+**, explicitly link the bundled V1 entrypoint:

```bash
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/praefectus-opencode/plugin/index.js ~/.config/opencode/plugins/praefectus-opencode.js
```

Replace `/path/to/praefectus-opencode` with the local directory containing this
plugin. The link points to the Marketplace plugin's bundled source; removing
the Omarchy plugin removes that source, so OpenCode can no longer load the
bridge. Restart OpenCode sessions after installing the bridge.

When upgrading from OpenCode V1 to V2, add the V2 `cli.json` entry above.
The old file symlink alone does **not** load the V2 terminal adapter; you can
remove it with the command below. Both integrations remain opt-in.

## Updating

Update the installed widget and bundled bridge:

```bash
omarchy plugin update praefectus.opencode
```

The widget reloads after an update. **Restart each running OpenCode TUI** to load
the updated bridge; you do not need to restart the V2 background service. Existing
`cli.json` entries or V1 symlinks can stay unchanged when the installation path
has not changed.

If you customized the installed plugin, preserve those changes before updating;
the updater requires a fast-forwardable Git checkout. Avoid deleting the plugin
or resetting local edits just to update it.

## Uninstall

For the V2 bridge, remove only the Praefectus entry from `cli.json`'s `plugins`
array, leaving other plugins and settings intact.

For the V1 bridge, remove its link:

```bash
rm ~/.config/opencode/plugins/praefectus-opencode.js
```

If you previously used a version that automatically created a symlink, remove
that link with the same command. This does not remove any other OpenCode plugin.

Remove the Omarchy plugin:

```bash
omarchy plugin remove praefectus.opencode
```

Restart OpenCode after removing the bridge. The Omarchy plugin never creates or
removes entries in OpenCode's plugin directory; opt-in and cleanup are explicit
user actions.

## Keyboard Shortcuts

Praefectus can focus sessions directly from Hyprland.

These shortcuts are optional, not installed automatically. Check existing
bindings with `omarchy menu keybindings --print` before adding them. If a key is
already assigned, choose another key or explicitly remove the old binding with
`hl.unbind("SUPER + ALT + W")` (using the key you intend to replace).

Add the following **Lua** to `~/.config/hypr/bindings.lua`:

```lua
local watcher = os.getenv("HOME") .. "/.config/omarchy/plugins/praefectus.opencode/bin/opencode-watch"

o.bind("SUPER + ALT + W", "OpenCode: working session", watcher .. " --focus-state working")
o.bind("SUPER + ALT + R", "OpenCode: response needed", watcher .. " --focus-state response")
o.bind("SUPER + ALT + P", "OpenCode: permission needed", watcher .. " --focus-state permission")
o.bind("SUPER + ALT + I", "OpenCode: idle session", watcher .. " --focus-state idle")

o.bind("SUPER + ALT + TAB", "OpenCode: next session", watcher .. " --focus-next")
o.bind("SUPER + ALT + SHIFT + TAB", "OpenCode: previous session", watcher .. " --focus-previous")
```

Reload Hyprland and check for configuration errors:

```bash
hyprctl reload
hyprctl configerrors
```

### Suggested shortcuts

| Shortcut                    | Action                                 |
| --------------------------- | -------------------------------------- |
| `SUPER + ALT + W`           | Focus a working session                |
| `SUPER + ALT + R`           | Focus a session waiting for a response |
| `SUPER + ALT + P`           | Focus a session waiting for permission |
| `SUPER + ALT + I`           | Focus an idle session                  |
| `SUPER + ALT + TAB`         | Focus the next session                 |
| `SUPER + ALT + SHIFT + TAB` | Focus the previous session             |

Repeated presses cycle through matching sessions and wrap around.
On V2, cycling can select different sessions in the same terminal. On V1,
it cycles between tracked terminal processes.

Inside the session panel, use the arrow keys to move, Enter to focus, Escape to
close, and `r` to clear the filter. Click a row's arrow to expand its preview.

## Notifications

Praefectus can notify you when an OpenCode session:

* needs your response
* needs permission
* finishes working

Notifications are enabled by default.

The first valid watcher snapshot establishes a silent baseline. Repeated states
do not notify again. While notifications are disabled, snapshots still advance
transition memory, so re-enabling them does not replay old changes. Sessions
that disappear are removed from that memory.

On V2, each top-level session notifies independently: another session working
in the same terminal cannot suppress its completion or attention notification.
Subagent events never affect parent status, counters, or notifications. Duplicate
terminal views of the same session do not produce duplicate notifications.

On V1, a process finishes only after all of its busy sessions become idle.
When one V1 OpenCode process hosts multiple sessions, outstanding requests take
precedence over busy or idle events from any session. Permission requests take
precedence over response requests; within each kind, the oldest outstanding
request supplies the displayed session and preview. Updating a request keeps its
place in that order. Answering it reveals the next outstanding request, or the
aggregate activity state if none remain. Replies that resume work count as busy
until that session becomes idle, even if no separate busy event arrives.
Rejecting another request does not finish that resumed work.

Clicking a notification focuses the corresponding session.
On V2, it also selects or reopens the exact session. On V1, it focuses the
corresponding terminal or tmux pane.

The notification timeout can be configured between 8 and 30 seconds from the widget settings.

## Troubleshooting

### The bar shows `!` or no V2 sessions

Click `!` to read the warning in the session panel. Check that:

1. The installed revision includes the V2 bridge (see the compatibility table).
2. `cli.json` points to the absolute **plugin directory**, not `plugin/index.js`.
3. You restarted the OpenCode TUI after installing or updating the bridge.
4. You have a session open in a full-screen TUI. An empty terminal counts as zero;
   Mini, headless commands, and browser/desktop sessions are not tracked.

Inspect the watcher's current snapshot without changing anything:

```bash
~/.config/omarchy/plugins/praefectus.opencode/bin/opencode-watch --once
```

The `warnings` field identifies missing, invalid, or stale bridge data. If the
widget itself has not reloaded after an update, run `omarchy restart shell`.

### A click cannot reopen a session

Exact-session navigation requires an owning V2 TUI to remain running and its
local command socket to be available. Once all owning terminals exit, old
notifications cannot reopen the session; open it from OpenCode's session history.
Praefectus will not reuse a stale PID to focus an unrelated replacement process.

## How It Works

Praefectus watches top-level `opencode` / `opencode.exe` terminal processes
running on the machine, excluding background server/service and API processes.

The bundled bridge publishes lightweight runtime status information: V1
uses process-wide server event hooks, while V2 publishes independent session
records in a per-terminal envelope using public data from the local TUI. V2 never
associates the shared server's PID with a terminal. Status files are stored under
`$XDG_RUNTIME_DIR/praefectus-opencode/`, falling back to
`~/.cache/praefectus-opencode/` when necessary. V2 navigation sockets live in the
same user-private directory.

Praefectus does **not** scrape terminal output and does **not** access OpenCode's private storage.

Processes are matched using Linux process start ticks, which prevents stale status information from being associated with newly created processes reusing the same PID.
When start ticks are unavailable, matching falls back to the process start timestamp.
Tracking also ties retained state and navigation ownership to that process
lifetime. A V1 replacement starts idle without a valid record; a V2 replacement
shows a bridge warning until valid membership is available. A continuing process
keeps its last observed state during a temporary gap in bridge records (with a
warning on V2).
If a listed process temporarily cannot be inspected, tracking keeps its last
reliable observation until inspection succeeds or the PID disappears.

## Why "Praefectus"?

*Praefectus fabrum* was a Roman officer responsible for craftsmen, engineers and other technical workers.

OpenCode agents are today's technical workers.

Praefectus keeps an eye on them and tells you which one needs your attention.

## Tests

The test suite requires Python 3 and Node.js; no running desktop is needed.

Run the watcher tests:

```bash
python3 -m unittest discover -s tests -v
```

Run the OpenCode bridge and notification tests (Node.js and Python 3 required):

```bash
node --test tests/test_*.mjs
```

Verify the complete suite without running the desktop:

```bash
python3 -m unittest discover -s tests -v && node --test tests/test_*.mjs
```

`NotificationPolicy.js` owns the silent baseline, successive-snapshot memory,
and enablement rules. Each widget creates a policy with `create()` and calls
`accept(jsonLine, notificationsEnabled)`, which returns `{ snapshot, decisions }`.
Each decision contains an `eventType` (`attention` or `finished`), `sessionId`,
and `sourcePid`. V2 decisions additionally carry a self-contained `focusTarget`
with session/server identity and lifetime-checked owning TUIs; snapshots expose
this as `focus_target`. V2 `tracking_id` is server/session scoped, whereas V1
retains its process-lifetime identity even when the latest hosted-session ID
changes. `completed_sessions` carries durable closed-tab completion records
outside the counters, ensuring a slower watcher cannot miss a completion.
Older snapshots without tracking IDs retain their existing identity
fallbacks (PID then session ID for notifications, session ID then PID for cycling).
Malformed JSON, invalid counts or session fields, missing identities, and
duplicate identities throw without advancing the last accepted baseline.

The tests execute the same JavaScript imported by QML. They cover policy traces,
the desktop command builder in `NotificationDelivery.js` (generic text, bounded
timeout, and focus target), and a composed trace through bridge-produced runtime
records, watcher snapshots, and notification decisions, including independent
V2 tabs, deduplication, subagent exclusion, closed-tab completion, and a real
watcher-to-TUI Unix socket navigation test. QML owns rendering and
notification process execution.

## License
MIT
