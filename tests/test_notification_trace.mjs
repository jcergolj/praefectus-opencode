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

function watcherSnapshots(frames) {
  const watcher = spawnSync("python3", [fileURLToPath(new URL("./notification_trace_snapshots.py", import.meta.url))], {
    input: JSON.stringify(frames), encoding: "utf8",
  });
  assert.equal(watcher.status, 0, watcher.stderr);
  return JSON.parse(watcher.stdout);
}

test("outstanding attention survives other hosted sessions becoming busy", async () => {
  for (const [type, state, preview] of [
    ["permission.asked", "NEEDS_APPROVAL", "edit: app.js"],
    ["question.asked", "WAITING", "Which option?"],
  ]) {
    let record;
    const reporter = new bridge.OpenCodeStatusReporter({
      recordBuilder: new bridge.StatusRecordBuilder({
        processId: 101, processStartedAt: 100, processStartTicks: 12345,
        directory: "/work/alpha", environment: {}, clock: () => 200,
      }),
      recordWriter: { write(value) { record = value; } },
      contextLimitFor: async () => 100,
    });
    const frames = [];
    await reporter.initialize();
    frames.push([structuredClone(record)]);
    await reporter.handle({ type, properties: {
      sessionID: "A", id: "request-1", permission: "edit", patterns: ["app.js"],
      question: "Which option?",
    } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: "session.status", properties: { sessionID: "B", status: "busy" } });
    frames.push([structuredClone(record)]);
    // Force publication after the unrelated event, including context enrichment.
    await reporter.handle({ type: "message.updated", properties: { info: {
      sessionID: "B", role: "assistant", tokens: { total: 50 },
    } } });
    await reporter.handle({ type: "session.updated", properties: { sessionID: "B" } });
    frames.push([structuredClone(record)]);
    assert.equal(record.context_percentage, 50);
    const attentionFrameCount = frames.length;
    const replyType = type === "permission.asked" ? "permission.replied" : "question.replied";
    await reporter.handle({ type, properties: {
      sessionID: "B", id: "request-1", title: "B request", question: "B request",
    } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: replyType, properties: { sessionID: "A", id: "request-1", reply: "once" } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: replyType, properties: { sessionID: "B", id: "request-1", reply: "once" } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: "session.idle", properties: { sessionID: "B" } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: "session.idle", properties: { sessionID: "unrelated" } });
    frames.push([structuredClone(record)]);
    await reporter.handle({ type: "session.idle", properties: { sessionID: "A" } });
    frames.push([structuredClone(record)]);
    const snapshots = watcherSnapshots(frames);
    const policy = policyModule.create();
    assert.deepEqual(plain(policy.accept(JSON.stringify(snapshots[0]), true).decisions), []);
    for (let index = 1; index < attentionFrameCount; index += 1) {
      const session = snapshots[index].sessions[0];
      assert.equal(session.state, state);
      assert.equal(session.attention, true);
      assert.equal(session.session_id, "A");
      assert.equal(session.preview, preview);
      assert.deepEqual(plain(policy.accept(JSON.stringify(snapshots[index]), true).decisions),
        index === 1 ? [{ eventType: "attention", sessionId: "A", sourcePid: "101" }] : []);
    }
    const remaining = snapshots.slice(attentionFrameCount);
    assert.deepEqual(remaining.map((snapshot) => snapshot.sessions[0].state), [
      state, state, "WORKING", "WORKING", "WORKING", "IDLE",
    ]);
    assert.equal(remaining[0].sessions[0].preview, preview, "newer request cannot replace the oldest");
    assert.equal(remaining[1].sessions[0].session_id, "B");
    assert.equal(remaining[1].sessions[0].preview, "B request");
    assert.equal(remaining[1].sessions[0].attention, true);
    assert.equal(remaining[2].sessions[0].attention, false);
    assert.equal(remaining[2].sessions[0].preview, "working");
    assert.deepEqual(remaining.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions)), [
      [], [], [], [], [], [{ eventType: "finished", sessionId: "A", sourcePid: "101" }],
    ]);
  }
});

test("rejecting a second request does not publish a false completion after work resumes", async () => {
  for (const [asked, replied, rejected] of [
    ["permission.asked", "permission.replied", "permission.replied"],
    ["question.asked", "question.replied", "question.rejected"],
  ]) {
    let record;
    const reporter = new bridge.OpenCodeStatusReporter({
      recordBuilder: new bridge.StatusRecordBuilder({
        processId: 101, processStartedAt: 100, processStartTicks: 12345,
        directory: "/work/alpha", environment: {}, clock: () => 200,
      }),
      recordWriter: { write(value) { record = value; } },
    });
    const frames = [];
    async function event(type, properties) {
      await reporter.handle({ type, properties });
      frames.push([structuredClone(record)]);
    }
    await reporter.initialize();
    frames.push([structuredClone(record)]);
    await event(asked, { sessionID: "A", id: "first" });
    await event(asked, { sessionID: "A", id: "second" });
    await event(replied, { sessionID: "A", id: "first", reply: "once" });
    await event(rejected, { sessionID: "A", id: "second", reply: "reject" });
    await event("session.idle", { sessionID: "unrelated" });
    await event("session.idle", { sessionID: "A" });
    const snapshots = watcherSnapshots(frames);
    const attentionState = asked === "permission.asked" ? "NEEDS_APPROVAL" : "WAITING";
    assert.deepEqual(snapshots.map((snapshot) => snapshot.sessions[0].state), [
      "IDLE", attentionState, attentionState, attentionState, "WORKING", "WORKING", "IDLE",
    ]);
    const policy = policyModule.create();
    assert.deepEqual(snapshots.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions)), [
      [], [{ eventType: "attention", sessionId: "A", sourcePid: "101" }], [], [], [], [],
      [{ eventType: "finished", sessionId: "A", sourcePid: "101" }],
    ]);
  }
});

test("PID replacement cannot finish old work and hosted-session changes preserve notification memory", async () => {
  let record;
  function reporter(startTicks) {
    return new bridge.OpenCodeStatusReporter({
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

  const snapshots = watcherSnapshots(frames);
  assert.deepEqual(snapshots.map((snapshot) => snapshot.sessions[0].state), [
    "WORKING", "WORKING", "WORKING", "IDLE", "NEEDS_APPROVAL", "NEEDS_APPROVAL", "WORKING", "WORKING",
  ]);
  const policy = policyModule.create();
  assert.deepEqual(snapshots.map((snapshot) => plain(policy.accept(JSON.stringify(snapshot), true).decisions)), [
    [], [], [], [],
    [{ eventType: "attention", sessionId: "parent", sourcePid: "101" }],
    [], [], [],
  ]);
});

test("bridge events flow through runtime records and watcher snapshots to notification decisions", async () => {
  let record;
  const reporter = new bridge.OpenCodeStatusReporter({
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

  const snapshots = watcherSnapshots(steps.map((step) => step.records));
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
