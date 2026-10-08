import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { spawnSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import bridge, { OpenCodeStatusReporter, StatusRecordBuilder } from "../plugin/index.js";
import terminalPlugin, { TerminalStatusBridge } from "../plugin/tui.js";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

function fixture(pid = 101, server = "shared") {
  const records = [];
  let removed = 0;
  let route = { type: "session", sessionID: "A" };
  let tabsEnabled = true;
  let tabs = ["A"];
  let now = 20;
  const sessions = new Map([
    ["A", { location: { directory: "/work/a" } }],
    ["child", { parentID: "A", location: { directory: "/work/a" } }],
    ["B", { location: { directory: "/work/b" } }],
  ]);
  const states = new Map(), permissions = new Map(), forms = new Map(), messages = new Map();
  const syncs = [], navigation = [];
  const model = { id: "demo", providerID: "acme", limit: { context: 1000 } };
  const context = {
    client: { server: { info: async () => ({ urls: ["http://localhost:4096"], pid: 999, paths: { tmp: server } }) } },
    data: {
      session: {
        root: (id) => sessions.get(id)?.parentID ?? id,
        get: (id) => sessions.get(id), status: (id) => states.get(id) ?? "idle",
        sync: async (id) => { syncs.push(id); },
        permission: { sync: async () => {}, list: (id) => permissions.get(id) ?? [] },
        form: { sync: async () => {}, list: (id) => forms.get(id) ?? [] },
        message: { sync: async () => {}, list: (id) => messages.get(id) ?? [] },
      },
      location: { model: { sync: async () => {}, list: (location) => location?.directory === "/work/a" ? [model] : [] } },
    },
    ui: {
      router: { current: () => route, navigate: (value) => { navigation.push(value.type === "home" ? "home" : value.sessionID); route = value; } },
      tabs: { enabled: () => tabsEnabled, list: () => tabs.map((sessionID) => ({ sessionID })),
        focus: (id) => { navigation.push(id); if (!tabs.includes(id)) tabs.push(id); route = { type: "session", sessionID: id }; } },
    },
  };
  const reporter = new OpenCodeStatusReporter({
    recordBuilder: new StatusRecordBuilder({
      directory: "/work/a", processId: pid, environment: { TMUX_PANE: "%1" },
      processStartedAt: 10, processStartTicks: 12345, clock: () => now++,
    }),
    recordWriter: { write: (record) => records.push(record), remove: () => { removed++; } },
  });
  const adapter = new TerminalStatusBridge(context, reporter);
  return {
    adapter, reporter, records, context, states, permissions, forms, messages, syncs, navigation,
    setRoute: (value) => { route = value; }, setTabs: (value) => { tabs = value; },
    disableTabs: () => { tabsEnabled = false; }, removed: () => removed,
    latest: () => records.at(-1), session: (id) => records.at(-1).sessions.find((r) => r.session_id === id),
  };
}

test("one package retains V1 server and V2 terminal entrypoints", async () => {
  assert.equal(typeof bridge.server, "function");
  assert.equal(typeof bridge.setup, "function");
  assert.equal(typeof terminalPlugin.setup, "function");
  const manifest = JSON.parse(await readFile(new URL("../plugin/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.exports["./tui"], "./tui.js");
});

test("V2 publishes independent top-level tabs including restored attention and idle", async () => {
  const f = fixture();
  f.setTabs(["A", "B"]);
  f.states.set("A", "running");
  f.permissions.set("A", [{ id: "per_1", sessionID: "A", action: "edit", resources: ["app.js"] }]);
  await f.adapter.refresh();
  assert.equal(f.latest().sessions.length, 2);
  assert.equal(f.session("A").state, "NEEDS_APPROVAL");
  assert.equal(f.session("A").preview, "edit: app.js");
  assert.equal(f.session("B").state, "IDLE");
  for (const r of f.latest().sessions) {
    assert.equal(r.source_pid, 101);
    assert.equal(r.process_start_ticks, 12345);
    assert.equal(r.tmux_pane, "%1");
    assert.ok(r.server_id);
  }
  f.permissions.delete("A");
  f.forms.set("B", [{ id: "frm_B", title: "Which branch?" }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "WORKING");
  assert.equal(f.session("B").state, "WAITING");
  assert.deepEqual(f.syncs, ["A", "B"]);
});

test("a fresh welcome screen counts as idle before its first prompt", async () => {
  const existing = fixture(), fresh = fixture(102);
  existing.states.set("A", "running");
  fresh.setTabs([]); fresh.setRoute({ type: "home" });
  await existing.adapter.refresh(); await fresh.adapter.refresh();
  const frames = [[structuredClone(existing.latest()), structuredClone(fresh.latest())]];
  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(frames), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  const snapshot = JSON.parse(watcher.stdout)[0];
  assert.equal(snapshot.counts.sessions, 2, "working conversation plus fresh idle terminal");
  assert.equal(snapshot.counts.idle, 1);
  assert.deepEqual(fresh.syncs, [], "no saved conversation is synced for a welcome screen");
  const placeholder = fresh.latest().sessions[0];
  assert.equal(placeholder.state, "IDLE");
  const policy = (await loadQmlScript("../NotificationPolicy.js")).create();
  assert.deepEqual(plain(policy.accept(JSON.stringify(snapshot), true).decisions), []);
  fresh.setTabs(["B"]); fresh.setRoute({ type: "session", sessionID: "B" });
  fresh.states.set("B", "running");
  await fresh.adapter.refresh();
  assert.deepEqual(fresh.latest().sessions.map((r) => r.session_id), ["B"]);
  assert.deepEqual(fresh.latest().completed_sessions, [], "replacing a welcome screen is not completion");
  const after = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify([[existing.latest(), fresh.latest()]]), encoding: "utf8",
  });
  assert.equal(after.status, 0, after.stderr);
  const afterSnapshot = JSON.parse(after.stdout)[0];
  assert.equal(afterSnapshot.counts.sessions, 2);
  assert.equal(afterSnapshot.counts.working, 2);
  assert.deepEqual(plain(policy.accept(JSON.stringify(afterSnapshot), true).decisions), []);
});

test("welcome entries are process-specific, stable, and navigate without a server session", async () => {
  const first = fixture(), second = fixture(102);
  first.setTabs([]); first.setRoute({ type: "home" });
  second.disableTabs(); second.setRoute({ type: "home" });
  await first.adapter.refresh(); await second.adapter.refresh();
  const home = first.latest().sessions[0];
  assert.notEqual(home.session_id, second.latest().sessions[0].session_id);
  await first.adapter.refresh();
  assert.equal(first.latest().sessions[0].session_id, home.session_id);
  assert.equal(first.latest().sessions[0].last_transition_ts, home.last_transition_ts);
  assert.equal(first.adapter.navigate({ server_id: "wrong", session_id: home.session_id }), false);
  assert.equal(first.adapter.navigate({ server_id: first.adapter.serverID, session_id: home.session_id }), true);
  assert.deepEqual(first.navigation, ["home"]);
  first.setRoute({ type: "plugin", name: "dashboard" });
  await first.adapter.refresh();
  assert.deepEqual(first.latest().sessions, [], "only an actual welcome screen gets a placeholder");
  assert.deepEqual(first.latest().completed_sessions, []);
  assert.equal(first.adapter.navigate({ server_id: first.adapter.serverID, session_id: home.session_id }), false);
});

test("a welcome screen counts alongside existing tabs but is not retained after navigation", async () => {
  const f = fixture();
  f.setRoute({ type: "home" });
  await f.adapter.refresh();
  assert.equal(f.latest().sessions.length, 2);
  assert.equal(f.session("A").state, "IDLE");
  f.setRoute({ type: "session", sessionID: "A" });
  await f.adapter.refresh();
  assert.deepEqual(f.latest().sessions.map((r) => r.session_id), ["A"]);
  assert.deepEqual(f.latest().completed_sessions, []);
});

test("subagent activity, attention, and completion have no effect on parent records", async () => {
  const f = fixture();
  await f.adapter.refresh();
  const original = f.session("A");
  f.states.set("child", "running");
  f.permissions.set("child", [{ id: "child_permission", action: "edit" }]);
  f.forms.set("child", [{ id: "child_form", title: "Ignored" }]);
  f.setRoute({ type: "session", sessionID: "child" });
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "IDLE");
  assert.equal(f.session("A").last_transition_ts, original.last_transition_ts);
  assert.equal(f.latest().sessions.length, 1);
  f.states.delete("child"); f.permissions.delete("child"); f.forms.delete("child");
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "IDLE");
  assert.deepEqual(f.syncs, ["A"]);
});

test("unrelated history is excluded and tabs-disabled membership follows the displayed root", async () => {
  const f = fixture();
  f.states.set("B", "running");
  await f.adapter.refresh();
  assert.deepEqual(f.latest().sessions.map((r) => r.session_id), ["A"]);
  f.disableTabs(); f.setRoute({ type: "session", sessionID: "B" });
  await f.adapter.refresh();
  assert.deepEqual(f.latest().sessions.map((r) => r.session_id), ["B"]);
  f.setRoute({ type: "home" });
  await f.adapter.refresh();
  assert.equal(f.session("B").tab_open, false, "closed running session is retained");
  f.states.delete("B");
  await f.adapter.refresh();
  assert.deepEqual(f.latest().sessions.map((r) => [r.session_id, r.state]), [[f.adapter.homeID, "IDLE"]]);
  assert.equal(f.latest().completed_sessions[0].session_id, "B");
});

test("closed running and attention tabs remain navigable, completion survives watcher gaps", async () => {
  const f = fixture();
  f.states.set("A", "running");
  await f.adapter.refresh();
  f.setTabs([]); f.setRoute({ type: "home" });
  await f.adapter.refresh();
  assert.equal(f.session("A").tab_open, false);
  f.forms.set("A", [{ id: "question", title: "Choose" }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "WAITING");
  assert.equal(f.adapter.navigate({ server_id: f.adapter.serverID, session_id: "A" }), true);
  await f.adapter.refresh();
  assert.equal(f.session("A").tab_open, true);
  f.setTabs([]); f.forms.delete("A"); f.states.delete("A");
  await f.adapter.refresh();
  assert.equal(f.latest().sessions.length, 0);
  const completion = f.latest().completed_sessions[0];
  await f.adapter.refresh(); await f.adapter.refresh();
  assert.deepEqual(f.latest().completed_sessions[0], completion);
  assert.equal(f.adapter.navigate({ server_id: "wrong", session_id: "A" }), false);
  assert.equal(f.adapter.navigate({ server_id: f.adapter.serverID, session_id: "history" }), false);
  assert.equal(f.adapter.navigate({ server_id: f.adapter.serverID, session_id: "A" }), true);
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "IDLE");
  assert.deepEqual(f.latest().completed_sessions, []);
});

test("requests preserve age and precedence within their own top-level session", async () => {
  const f = fixture();
  f.forms.set("A", [{ id: "first", title: "First" }, { id: "second", title: "Second" }]);
  await f.adapter.refresh();
  f.forms.set("A", [{ id: "second", title: "Second" }, { id: "first", title: "Updated" }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").preview, "Updated");
  f.permissions.set("A", [{ id: "per", action: "shell" }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "NEEDS_APPROVAL");
  f.permissions.delete("A"); f.forms.set("A", [{ id: "second", title: "Second" }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").preview, "Second");
});

test("context metadata stays session-specific", async () => {
  const f = fixture(); f.setTabs(["A", "B"]);
  f.messages.set("A", [{ type: "assistant", model: { providerID: "acme", id: "demo" }, tokens: { input: 500 } }]);
  await f.adapter.refresh();
  assert.equal(f.session("A").context_percentage, 50);
  assert.equal(Object.hasOwn(f.session("B"), "context_percentage"), false);
});

test("failed syncs retry without replacing the last reliable envelope", async () => {
  const f = fixture(); f.states.set("A", "running");
  await f.adapter.refresh(); const original = f.latest();
  f.context.data.session.sync = async () => { throw new Error("disconnected"); };
  f.setTabs(["A", "B"]); await f.adapter.refresh();
  assert.equal(f.latest(), original);
  f.context.data.session.sync = async () => {};
  await f.adapter.refresh();
  assert.equal(f.latest().sessions.length, 2);
});

test("unknown status is signaled without inventing an idle session", async () => {
  const f = fixture(); f.states.set("A", "unknown");
  await f.adapter.refresh();
  assert.deepEqual(f.latest().sessions, []);
  assert.match(f.latest().warnings[0], /awaiting status bridge data/);
  f.states.set("A", "running"); await f.adapter.refresh();
  assert.equal(f.session("A").state, "WORKING");
  assert.deepEqual(f.latest().warnings, []);
});

test("closing a running tab during initial metadata sync retains the session", async () => {
  const f = fixture();
  f.states.set("A", "running");
  f.context.data.session.sync = async () => { f.setTabs([]); f.setRoute({ type: "home" }); };
  await f.adapter.refresh();
  assert.equal(f.session("A").state, "WORKING");
  assert.equal(f.session("A").tab_open, false);
});

test("cleanup waits for in-flight sync and does not write after disposal", async () => {
  const f = fixture();
  // Resolve server identity before the controlled session sync.
  await f.adapter.refresh(); f.records.length = 0;
  let release;
  f.context.data.session.sync = () => new Promise((resolve) => { release = resolve; });
  f.setTabs(["B"]);
  const refreshing = f.adapter.refresh(); const disposing = f.adapter.dispose();
  release(); await Promise.all([refreshing, disposing]);
  await f.adapter.refresh();
  assert.equal(f.records.length, 0); assert.equal(f.removed(), 1);
});

test("composed V2 trace independently notifies, deduplicates, and retains exact click targets", async () => {
  const f = fixture(), duplicate = fixture(102);
  f.setTabs(["A", "B"]);
  const frames = [];
  async function capture() {
    await f.adapter.refresh();
    duplicate.states.clear(); for (const [id, state] of f.states) duplicate.states.set(id, state);
    duplicate.permissions.clear(); for (const [id, requests] of f.permissions) duplicate.permissions.set(id, requests);
    await duplicate.adapter.refresh();
    frames.push([structuredClone(f.latest()), structuredClone(duplicate.latest())]);
  }
  await capture();
  f.states.set("A", "running"); f.states.set("B", "running"); await capture();
  f.states.set("child", "running"); f.permissions.set("child", [{ id: "ignored", action: "edit" }]); await capture();
  f.states.delete("A"); await capture(); // B still working; A independently finishes.
  f.permissions.set("B", [{ id: "per_B", action: "shell" }]); await capture();
  f.permissions.delete("B"); await capture();
  f.setTabs(["A"]); await capture(); // retain closed B
  f.states.delete("B"); await capture(); // completion is not counted
  await capture();
  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(frames), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  const snapshots = JSON.parse(watcher.stdout);
  assert.equal(snapshots[0].counts.sessions, 2);
  assert.equal(snapshots[1].counts.working, 2);
  assert.equal(snapshots[2].counts.permission, 0);
  assert.equal(snapshots[3].counts.working, 1);
  assert.equal(snapshots[7].counts.sessions, 1);
  const policy = (await loadQmlScript("../NotificationPolicy.js")).create();
  const delivery = await loadQmlScript("../NotificationDelivery.js");
  const decisions = snapshots.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions));
  assert.deepEqual(decisions.map((ds) => ds.map((d) => [d.eventType, d.sessionId])), [
    [], [], [], [["finished", "A"]], [["attention", "B"]], [], [], [["finished", "B"]], [],
  ]);
  for (const d of decisions.flat()) {
    const target = JSON.parse(d.focusTarget.slice("session:".length));
    assert.equal(target.session_id, d.sessionId);
    assert.equal(plain(delivery.command(d, "/watcher", 10)).at(-1), d.focusTarget);
    if (d.sessionId === "A") assert.equal(target.owners.length, 2);
  }
  const completed = decisions[7][0];
  assert.equal(f.adapter.navigate(JSON.parse(completed.focusTarget.slice(8))), true);
  assert.equal(f.navigation.at(-1), "B");
});

test("real Unix channel accepts watcher navigation and cleans up with the bridge", async () => {
  const f = fixture(process.pid);
  f.setTabs(["A", "B"]);
  await f.adapter.startNavigation();
  const socketPath = f.adapter.channel.path;
  try {
    assert.equal((await stat(socketPath)).mode & 0o777, 0o600);
    await f.adapter.refresh();
    const frames = [[structuredClone(f.latest())]];
    f.states.set("B", "running"); await f.adapter.refresh();
    frames.push([structuredClone(f.latest())]);
    f.setTabs(["A"]); await f.adapter.refresh();
    frames.push([structuredClone(f.latest())]);
    f.states.delete("B"); await f.adapter.refresh();
    frames.push([structuredClone(f.latest())]);
    const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
      input: JSON.stringify(frames), encoding: "utf8",
    });
    assert.equal(watcher.status, 0, watcher.stderr);
    const policy = (await loadQmlScript("../NotificationPolicy.js")).create();
    const decisions = JSON.parse(watcher.stdout).map((s) => plain(policy.accept(JSON.stringify(s), true).decisions));
    assert.equal(decisions.at(-1)[0].sessionId, "B");
    const delivery = await loadQmlScript("../NotificationDelivery.js");
    const target = plain(delivery.command(decisions.at(-1)[0], "/watcher", 10)).at(-1);
    const script = `import sys; sys.path.insert(0, 'bin')
from opencode_watch.focus import FocusService
from opencode_watch.domain import ProcessInfo
class Processes:
 def inspect(self, pid): return ProcessInfo(pid, '/work/a', 10, 12345)
 def ancestors(self, pid): return [pid]
class Desktop:
 def focus(self, ancestors): return True
sys.exit(0 if FocusService(Processes(), [Desktop()]).focus(sys.argv[1]) else 1)`;
    const child = spawn("python3", ["-c", script, target]);
    const code = await new Promise((resolve) => child.on("exit", resolve));
    assert.equal(code, 0);
    assert.deepEqual(f.navigation, ["B"], "notification click reopens the completed session, not selected A");
    f.disableTabs(); f.setTabs([]); f.setRoute({ type: "home" });
    await f.adapter.refresh();
    assert.equal(f.adapter.navigate({ server_id: f.adapter.serverID, session_id: "A" }), true);
    assert.equal(f.navigation.at(-1), "A", "router reopens formerly idle closed session");
  } finally { await f.adapter.dispose(); }
  await assert.rejects(stat(socketPath), { code: "ENOENT" });
});

test("V2 fresh terminal publishes idle immediately and V1 remains process-based", async () => {
  const directory = await mkdtemp("/tmp/opencode/praefectus-v2-test-");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict"; import fs from "node:fs";
      import server from ${JSON.stringify(new URL("../plugin/index.js", import.meta.url).href)};
      import terminal from ${JSON.stringify(new URL("../plugin/tui.js", import.meta.url).href)};
      const recordPath = process.env.XDG_RUNTIME_DIR + "/praefectus-opencode/" + process.pid + ".json";
      server.setup(); assert.equal(fs.existsSync(recordPath), false);
      const dispose = await terminal.setup({ location: { directory: "/work/demo" },
        client: { server: { info: async () => ({ urls: ["local"], pid: 1, paths: { tmp: "server" } }) } },
        data: { session: { root: (id) => id }, location: { model: { list: () => [] } } },
        ui: { router: { current: () => ({ type: "home" }) }, tabs: { enabled: () => false } } });
      const record = JSON.parse(fs.readFileSync(recordPath));
      assert.equal(record.source_pid, process.pid); assert.equal(record.sessions.length, 1);
      assert.equal(record.sessions[0].state, "IDLE");
      assert.match(record.sessions[0].session_id, /^home:/);
      assert.ok(Number.isSafeInteger(record.process_start_ticks));
      await dispose(); assert.equal(fs.existsSync(recordPath), false);
      assert.equal(fs.readdirSync(process.env.XDG_RUNTIME_DIR + "/praefectus-opencode").length, 0);
      const legacy = await server.server({ directory: "/work/demo" });
      await legacy.event({ event: { type: "session.status", properties: { sessionID: "legacy", status: "busy" } } });
      assert.equal(JSON.parse(fs.readFileSync(recordPath)).state, "WORKING");
      await legacy.dispose(); assert.equal(fs.existsSync(recordPath), false);
    `], { env: { ...process.env, XDG_RUNTIME_DIR: directory }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally { await rm(directory, { recursive: true }); }
});
