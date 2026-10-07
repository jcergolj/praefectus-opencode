import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import bridge, { OpenCodeStatusReporter, StatusRecordBuilder } from "../plugin/index.js";
import terminalPlugin, { TerminalStatusBridge } from "../plugin/tui.js";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

function fixture() {
  const records = [];
  let removed = 0;
  let route = { type: "session", sessionID: "A" };
  let tabsEnabled = true;
  let tabs = ["A"];
  const sessions = new Map([
    ["A", { location: { directory: "/work/a" } }],
    ["child", { parentID: "A", location: { directory: "/work/a" } }],
    ["B", { location: { directory: "/work/b" } }],
  ]);
  const states = new Map();
  const permissions = new Map();
  const forms = new Map();
  const messages = new Map();
  const syncs = [];
  const model = { id: "demo", providerID: "acme", limit: { context: 1000 } };
  const context = {
    data: {
      session: {
        root: (id) => sessions.get(id)?.parentID ?? id,
        family: (id) => id === "A" ? ["A", "child"] : [id],
        get: (id) => sessions.get(id),
        status: (id) => states.get(id) ?? "idle",
        sync: async (id) => { syncs.push(id); },
        permission: { sync: async () => {}, list: (id) => permissions.get(id) ?? [] },
        form: { sync: async () => {}, list: (id) => forms.get(id) ?? [] },
        message: { sync: async () => {}, list: (id) => messages.get(id) ?? [] },
      },
      location: { model: { sync: async () => {}, list: (location) => location?.directory === "/work/a" ? [model] : [] } },
    },
    ui: {
      router: { current: () => route },
      tabs: { enabled: () => tabsEnabled, list: () => tabs.map((sessionID) => ({ sessionID })) },
    },
  };
  const reporter = new OpenCodeStatusReporter({
    recordBuilder: new StatusRecordBuilder({
      directory: "/work/a", processId: 101, environment: { TMUX_PANE: "%1" },
      processStartedAt: 10, processStartTicks: 12345, clock: () => 20,
    }),
    recordWriter: { write: (record) => records.push(record), remove: () => { removed++; } },
  });
  const adapter = new TerminalStatusBridge(context, reporter);
  return {
    adapter, reporter, records, context, states, permissions, forms, messages, syncs,
    setRoute: (value) => { route = value; },
    setTabs: (value) => { tabs = value; },
    disableTabs: () => { tabsEnabled = false; },
    removed: () => removed,
  };
}

test("one package exposes V1 server and V2 terminal entrypoints", async () => {
  assert.equal(typeof bridge.server, "function");
  assert.equal(typeof bridge.setup, "function");
  assert.equal(typeof terminalPlugin.setup, "function");
  const manifest = JSON.parse(await readFile(new URL("../plugin/package.json", import.meta.url), "utf8"));
  assert.equal(manifest.exports["./tui"], "./tui.js");
});

test("V2 restores busy sessions and pending permissions before its first record", async () => {
  const f = fixture();
  f.states.set("A", "running");
  f.permissions.set("child", [{ id: "per_1", sessionID: "child", action: "edit", resources: ["app.js"] }]);
  await f.adapter.refresh();
  assert.equal(f.records.length, 1);
  assert.equal(f.records[0].state, "NEEDS_APPROVAL");
  assert.equal(f.records[0].session_id, "child");
  assert.equal(f.records[0].preview, "edit: app.js");
  assert.equal(f.records[0].source_pid, 101);
  assert.equal(f.records[0].process_start_ticks, 12345);
  assert.equal(f.records[0].tmux_pane, "%1");
  f.permissions.delete("child");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WORKING");
  f.states.delete("A");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "IDLE");
  assert.deepEqual(f.syncs, ["A", "child"], "cached data is not refetched every tick");
});

test("V2 forms request a response and permissions retain precedence", async () => {
  const f = fixture();
  await f.adapter.refresh();
  f.forms.set("A", [{ id: "frm_1", sessionID: "A", title: "Which branch?", fields: [] }]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WAITING");
  assert.equal(f.records.at(-1).preview, "Which branch?");
  f.permissions.set("child", [{ id: "per_1", action: "shell", resources: ["git push"] }]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "NEEDS_APPROVAL");
  f.states.set("child", "running");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "NEEDS_APPROVAL");
  f.permissions.delete("child");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WAITING");
  f.forms.delete("A");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WORKING");
});

test("V2 tracks open tab families only, not unrelated sessions on the shared server", async () => {
  const f = fixture();
  f.states.set("B", "running");
  f.forms.set("B", [{ id: "frm_B", title: "Other terminal" }]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "IDLE");
  f.setTabs(["A", "B"]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WAITING");
  f.setTabs(["A"]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "IDLE");
  f.setRoute({ type: "session", sessionID: "B" });
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WAITING");
  f.disableTabs();
  f.setRoute({ type: "home" });
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "IDLE");
  assert.equal(f.records.at(-1).session_id, "pid:101");
});

test("V2 subagent completion cannot finish its busy parent", async () => {
  const f = fixture();
  f.states.set("A", "running");
  f.states.set("child", "running");
  f.setRoute({ type: "session", sessionID: "child" });
  await f.adapter.refresh();
  f.states.delete("child");
  await f.adapter.refresh();
  assert.deepEqual(f.records.map((record) => record.state), ["WORKING"]);
  f.states.delete("A");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "IDLE");
});

test("V2 preserves request age across snapshots and preview updates", async () => {
  const f = fixture();
  f.forms.set("child", [{ id: "first", title: "First question" }]);
  await f.adapter.refresh();
  f.forms.set("A", [{ id: "second", title: "Second question" }]);
  f.forms.set("child", [{ id: "first", title: "Updated question" }]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).preview, "Updated question");
  f.forms.delete("child");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).preview, "Second question");
});

test("V2 uses assistant model metadata and clears context when switching sessions", async () => {
  const f = fixture();
  f.messages.set("A", [{ type: "assistant", model: { providerID: "acme", id: "demo" }, tokens: { input: 500 } }]);
  // Keep A as the chosen decision session.
  f.states.set("A", "running");
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).context_percentage, 50);
  f.disableTabs();
  f.setRoute({ type: "session", sessionID: "B" });
  await f.adapter.refresh();
  assert.equal(Object.hasOwn(f.records.at(-1), "context_percentage"), false);
});

test("V2 retries failed metadata syncs and preserves its last reliable record", async () => {
  const f = fixture();
  f.states.set("A", "running");
  await f.adapter.refresh();
  f.context.data.session.sync = async () => { throw new Error("disconnected"); };
  f.setTabs(["A", "B"]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WORKING");
  f.context.data.session.sync = async () => {};
  f.forms.set("B", [{ id: "frm_B", title: "Restored request" }]);
  await f.adapter.refresh();
  assert.equal(f.records.at(-1).state, "WAITING");
});

test("V2 cleanup waits for in-flight sync and never writes after disposal", async () => {
  const f = fixture();
  let release;
  f.context.data.session.sync = () => new Promise((resolve) => { release = resolve; });
  f.setRoute({ type: "session", sessionID: "B" });
  f.setTabs(["B"]);
  const refreshing = f.adapter.refresh();
  const disposing = f.adapter.dispose();
  release();
  await Promise.all([refreshing, disposing]);
  await f.adapter.refresh();
  assert.equal(f.records.length, 0);
  assert.equal(f.removed(), 1);
});

test("V2 snapshots flow through the watcher and shared notification policy", async () => {
  const f = fixture();
  const frames = [];
  async function capture() {
    await f.adapter.refresh();
    frames.push([structuredClone(f.records.at(-1))]);
  }
  await capture();
  f.states.set("A", "running");
  await capture();
  f.states.set("child", "running");
  await capture();
  f.permissions.set("child", [{ id: "per_1", action: "edit", resources: ["app.js"] }]);
  await capture();
  f.states.delete("child");
  await capture();
  f.permissions.delete("child");
  await capture();
  f.states.delete("A");
  await capture();
  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(frames), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  const snapshots = JSON.parse(watcher.stdout);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.sessions[0].state), [
    "IDLE", "WORKING", "WORKING", "NEEDS_APPROVAL", "NEEDS_APPROVAL", "WORKING", "IDLE",
  ]);
  const policy = (await loadQmlScript("../NotificationPolicy.js")).create();
  assert.deepEqual(snapshots.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions)), [
    [], [], [], [{ eventType: "attention", sessionId: "child", sourcePid: "101" }], [], [],
    [{ eventType: "finished", sessionId: "A", sourcePid: "101" }],
  ]);
});

test("V2 setup writes the local terminal PID and removes its runtime record on cleanup", async () => {
  const directory = await mkdtemp("/tmp/opencode/praefectus-v2-test-");
  try {
    const result = spawnSync(process.execPath, ["--input-type=module", "-e", `
      import assert from "node:assert/strict";
      import fs from "node:fs";
      import server from ${JSON.stringify(new URL("../plugin/index.js", import.meta.url).href)};
      import terminal from ${JSON.stringify(new URL("../plugin/tui.js", import.meta.url).href)};
      const recordPath = process.env.XDG_RUNTIME_DIR + "/praefectus-opencode/" + process.pid + ".json";
      server.setup();
      assert.equal(fs.existsSync(recordPath), false, "the V2 server must not publish status");
      const dispose = await terminal.setup({
        location: { directory: "/work/demo" },
        data: { session: {}, location: { model: { list: () => [] } } },
        ui: { router: { current: () => ({ type: "home" }) }, tabs: { enabled: () => false } },
      });
      const record = JSON.parse(fs.readFileSync(recordPath));
      assert.equal(record.source_pid, process.pid);
      assert.equal(record.state, "IDLE");
      assert.ok(Number.isSafeInteger(record.process_start_ticks));
      await dispose();
      assert.equal(fs.existsSync(recordPath), false);
      const legacy = await server.server({ directory: "/work/demo" });
      await legacy.event({ event: { type: "session.status", properties: { sessionID: "legacy", status: "busy" } } });
      assert.equal(JSON.parse(fs.readFileSync(recordPath)).state, "WORKING");
      await legacy.dispose();
      assert.equal(fs.existsSync(recordPath), false);
    `], { env: { ...process.env, XDG_RUNTIME_DIR: directory }, encoding: "utf8", timeout: 5000 });
    assert.equal(result.status, 0, result.stderr);
  } finally {
    await rm(directory, { recursive: true });
  }
});
