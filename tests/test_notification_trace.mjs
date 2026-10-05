import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

const pluginSource = await readFile(new URL("../plugin/index.js", import.meta.url), "utf8");
const bridge = await import(`data:text/javascript,${encodeURIComponent(pluginSource)}`);
const policyModule = await loadQmlScript("../NotificationPolicy.js");
const delivery = await loadQmlScript("../NotificationDelivery.js");

test("PID replacement cannot finish old work and hosted-session changes preserve notification memory", async () => {
  let record;
  function reporter(startTicks) {
    return new bridge.OpenCodeStatusReporter({
      stateMachine: new bridge.LifecycleStateMachine(),
      eventMapper: new bridge.EventStateMapper(),
      recordBuilder: new bridge.StatusRecordBuilder({
        processId: 101, processStartedAt: 100, processStartTicks: startTicks,
        directory: "/work/alpha", environment: {}, clock: () => 200,
      }),
      recordWriter: { write(value) { record = value; } },
    });
  }
  const frames = [];
  function capture(process, records = [record]) {
    frames.push({ processes: [structuredClone(process)], records: structuredClone(records) });
  }
  const old = reporter(12345);
  await old.initialize();
  await old.handle({ type: "session.status", properties: { sessionID: "old", status: "busy" } });
  const oldProcess = structuredClone(record);
  capture(oldProcess);
  capture(oldProcess, []); // A missing record must not finish the same process.
  capture({ ...oldProcess, inspectable: false }, [
    { ...record, state: "IDLE", process_start_ticks: null },
  ]); // Uncertain process inspection freezes the last reliable observation.
  const replacementProcess = { ...oldProcess, process_start_ticks: 54321 };
  capture(replacementProcess); // The old record stays on disk across PID reuse.

  const replacement = reporter(54321);
  await replacement.initialize();
  await replacement.handle({ type: "permission.asked", properties: { sessionID: "parent", id: "p1" } });
  capture(replacementProcess);
  await replacement.handle({ type: "session.updated", properties: { sessionID: "child" } });
  capture(replacementProcess);
  await replacement.handle({ type: "permission.replied", properties: { sessionID: "parent", id: "p1", reply: "once" } });
  capture(replacementProcess);
  await replacement.handle({ type: "session.idle", properties: { sessionID: "child" } });
  capture(replacementProcess);

  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(frames), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  const snapshots = JSON.parse(watcher.stdout);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.sessions[0].state), [
    "WORKING", "WORKING", "WORKING", "IDLE", "NEEDS_APPROVAL", "NEEDS_APPROVAL", "WORKING", "IDLE",
  ]);
  const policy = policyModule.create();
  assert.deepEqual(snapshots.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions)), [
    [], [], [], [],
    [{ eventType: "attention", sessionId: "parent", sourcePid: "101" }],
    [], [],
    [{ eventType: "finished", sessionId: "child", sourcePid: "101" }],
  ]);
});

test("bridge events flow through runtime records and watcher snapshots to notification decisions", async () => {
  let record;
  const reporter = new bridge.OpenCodeStatusReporter({
    stateMachine: new bridge.LifecycleStateMachine(),
    eventMapper: new bridge.EventStateMapper(),
    recordBuilder: new bridge.StatusRecordBuilder({
      processId: 101, processStartedAt: 100, processStartTicks: 12345,
      directory: "/work/<img src=x>", environment: {}, clock: () => 200,
    }),
    recordWriter: { write(value) { record = value; } },
  });
  const attention = [{ eventType: "attention", sessionId: "parent", sourcePid: "101" }];
  const finished = [{ eventType: "finished", sessionId: "parent", sourcePid: "101" }];
  const steps = [];
  function capture(name, expected = [], enabled = true) {
    steps.push({ name, records: [structuredClone(record)], expected, enabled });
  }
  async function event(type, properties, expected = [], enabled = true) {
    await reporter.handle({ type, properties });
    capture(`${type}: ${properties.sessionID}`, expected, enabled);
  }
  await reporter.initialize();
  capture("silent baseline");
  await event("session.status", { sessionID: "parent", status: "busy" });
  await event("session.status", { sessionID: "child", status: "busy" });
  await event("session.idle", { sessionID: "child" });
  await event("permission.asked", { sessionID: "parent", id: "permission-1", title: "<i>private preview</i>" }, attention);
  await event("session.idle", { sessionID: "parent" });
  await event("permission.replied", { sessionID: "parent", id: "permission-1", reply: "once" });
  await event("session.idle", { sessionID: "parent" }, finished);
  capture("repeated completion");
  steps.push({ name: "disappearance", records: [], expected: [], enabled: true });
  capture("idle reappearance");
  await event("session.status", { sessionID: "parent", status: "busy" });
  await event("question.asked", { sessionID: "parent", id: "question-1", question: "private question" }, [], false);
  capture("re-enabled without replay");
  await event("question.replied", { sessionID: "parent", id: "question-1" });
  await event("session.idle", { sessionID: "parent" }, finished);

  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(steps.map((step) => step.records)), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  const snapshots = JSON.parse(watcher.stdout);
  assert.equal(snapshots[3].sessions[0].state, "WORKING", "child completion cannot finish its parent");
  assert.equal(snapshots[4].sessions[0].project, "<img src=x>");
  assert.equal(snapshots[4].sessions[0].preview, "<i>private preview</i>");
  const policy = policyModule.create();
  assert.equal(snapshots.length, steps.length);
  const decisions = snapshots.map((snapshot, index) => {
    const step = steps[index];
    const result = plain(policy.accept(JSON.stringify(snapshot), step.enabled).decisions);
    assert.deepEqual(result, step.expected, step.name);
    return result;
  });
  const command = plain(delivery.command(decisions[4][0], "/bin/opencode-watch", 20));
  assert.deepEqual(command.slice(-4), ["--exec", "/bin/opencode-watch", "--focus", "101"]);
  assert.equal(command.includes("<img src=x>"), false);
  assert.equal(command.includes("<i>private preview</i>"), false);
});
