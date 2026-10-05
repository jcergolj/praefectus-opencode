import assert from "node:assert/strict";
import test from "node:test";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

const policyModule = await loadQmlScript("../NotificationPolicy.js");

function snapshot(sessions) {
  return JSON.stringify({
    counts: { sessions: sessions.length, attention: 0, response: 0, permission: 0, idle: 0, working: 0 },
    sessions,
  });
}

function session(state, fields = {}) {
  return { session_id: "alpha", source_pid: 101, state, attention: false, ...fields };
}

test("the first accepted snapshot is silent even for sessions needing attention", () => {
  const policy = policyModule.create();
  const input = snapshot([session("WAITING")]);
  const result = policy.accept(input, true);

  assert.deepEqual(plain(result.snapshot), JSON.parse(input));
  assert.deepEqual(plain(result.decisions), []);
  assert.deepEqual(plain(policy.accept(input, true).decisions), []);
});

test("successive snapshots notify on attention entry and tracked working-to-idle completion", () => {
  const policy = policyModule.create();
  const accept = (sessions) => plain(policy.accept(snapshot(sessions), true).decisions);
  assert.deepEqual(accept([session("IDLE")]), []);
  assert.deepEqual(accept([session("WAITING")]), [
    { eventType: "attention", sessionId: "alpha", sourcePid: "101" },
  ]);
  assert.deepEqual(accept([session("WAITING")]), []);
  assert.deepEqual(accept([session("NEEDS_APPROVAL")]), []);
  assert.deepEqual(accept([session("IDLE")]), []);
  assert.deepEqual(accept([session("NEEDS_APPROVAL")]), [
    { eventType: "attention", sessionId: "alpha", sourcePid: "101" },
  ]);
  assert.deepEqual(accept([session("WORKING")]), []);
  assert.deepEqual(accept([session("IDLE")]), [
    { eventType: "finished", sessionId: "alpha", sourcePid: "101" },
  ]);
  assert.deepEqual(accept([session("IDLE")]), []);
  assert.deepEqual(accept([session("IDLE", { source_pid: 202, session_id: "new" })]), []);
});

test("disappearance drops memory so reappearance cannot finish stale work or suppress fresh attention", () => {
  const policy = policyModule.create();
  const accept = (sessions) => plain(policy.accept(snapshot(sessions), true).decisions);
  accept([session("WORKING")]);
  assert.deepEqual(accept([]), []);
  assert.deepEqual(accept([session("IDLE")]), []);
  assert.deepEqual(accept([session("WAITING")]), [
    { eventType: "attention", sessionId: "alpha", sourcePid: "101" },
  ]);
  assert.deepEqual(accept([]), []);
  assert.deepEqual(accept([session("WAITING")]), [
    { eventType: "attention", sessionId: "alpha", sourcePid: "101" },
  ]);
});

test("disabled snapshots still advance baseline and memory without delayed notifications", () => {
  const policy = policyModule.create();
  const accept = (state, enabled) => plain(policy.accept(snapshot([session(state)]), enabled).decisions);
  assert.deepEqual(accept("WORKING", false), []);
  assert.deepEqual(accept("IDLE", false), []);
  assert.deepEqual(accept("IDLE", true), []);
  assert.deepEqual(accept("WAITING", false), []);
  assert.deepEqual(accept("WAITING", true), []);
  assert.deepEqual(accept("WORKING", false), []);
  assert.deepEqual(accept("IDLE", true), [
    { eventType: "finished", sessionId: "alpha", sourcePid: "101" },
  ]);
  policy.accept(snapshot([]), false);
  assert.deepEqual(accept("WAITING", true), [
    { eventType: "attention", sessionId: "alpha", sourcePid: "101" },
  ]);
});

test("malformed snapshots are rejected atomically without establishing or replacing a baseline", () => {
  const malformed = [
    "", "not json", "null", "[]", "42", "{}",
    JSON.stringify({ sessions: [] }),
    JSON.stringify({ counts: {}, sessions: [] }),
    JSON.stringify({ counts: { sessions: -1 }, sessions: [] }),
    snapshot([null]), snapshot([[]]), snapshot([{}]),
    snapshot([session("UNKNOWN")]), snapshot([session("IDLE", { attention: "false" })]),
    snapshot([session("IDLE", { source_pid: {}, session_id: {} })]),
    snapshot([session("IDLE", { tracking_id: "" })]),
    snapshot([session("IDLE", { tracking_id: null })]),
    snapshot([session("IDLE", { tracking_id: 12345 })]),
    snapshot([
      session("IDLE", { tracking_id: "same-lifetime" }),
      session("WAITING", { source_pid: 202, tracking_id: "same-lifetime" }),
    ]),
    snapshot([session("IDLE", { source_pid: null, session_id: "" })]),
    snapshot([session("IDLE"), session("WAITING")]),
    snapshot([session("IDLE"), session("UNKNOWN", { source_pid: 202 })]),
  ];
  for (const input of malformed) {
    const policy = policyModule.create();
    assert.throws(() => policy.accept(input, true), undefined, input);
    assert.deepEqual(plain(policy.accept(snapshot([session("WORKING")]), true).decisions), []);
    assert.throws(() => policy.accept(input, false), undefined, input);
    assert.deepEqual(plain(policy.accept(snapshot([session("IDLE")]), true).decisions), [
      { eventType: "finished", sessionId: "alpha", sourcePid: "101" },
    ], input);
  }
});

test("decisions retain per-process targets across bridge session-ID changes and support ID fallback", () => {
  const policy = policyModule.create();
  policy.accept(snapshot([
    session("WORKING"),
    session("IDLE", { source_pid: null, session_id: "fallback" }),
    session("WORKING", { source_pid: 202, session_id: "other" }),
  ]), true);
  assert.deepEqual(plain(policy.accept(snapshot([
    session("IDLE", { session_id: "child" }),
    session("IDLE", { source_pid: null, session_id: "fallback", attention: true }),
    session("WORKING", { source_pid: 202, session_id: "other" }),
    session("NEEDS_APPROVAL", { source_pid: 303, session_id: "new" }),
  ]), true).decisions), [
    { eventType: "finished", sessionId: "child", sourcePid: "101" },
    { eventType: "attention", sessionId: "fallback", sourcePid: "" },
    { eventType: "attention", sessionId: "new", sourcePid: "303" },
  ]);
});

test("policy instances and returned snapshots cannot mutate each other's transition memory", () => {
  const policy = policyModule.create();
  const result = policy.accept(snapshot([session("WORKING")]), true);
  result.snapshot.sessions[0].state = "IDLE";
  const other = policyModule.create();
  assert.deepEqual(plain(other.accept(snapshot([session("IDLE")]), true).decisions), []);
  assert.deepEqual(plain(policy.accept(snapshot([session("IDLE")]), true).decisions), [
    { eventType: "finished", sessionId: "alpha", sourcePid: "101" },
  ]);
});
