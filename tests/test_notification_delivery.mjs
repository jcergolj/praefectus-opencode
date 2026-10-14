import assert from "node:assert/strict";
import test from "node:test";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

const delivery = await loadQmlScript("../NotificationDelivery.js");
const policyModule = await loadQmlScript("../NotificationPolicy.js");

test("desktop delivery falls back to generic text, configured expiry, and the associated process focus target", () => {
  for (const [eventType, summary] of [
    ["attention", "OpenCode session needs attention"],
    ["finished", "OpenCode session finished"],
  ]) {
    const command = delivery.command({
      eventType, sessionId: "session-1", sourcePid: "101",
      project: "PRIVATE PROJECT", preview: "PRIVATE PREVIEW <b>bold</b>",
    }, "/plugin with spaces/bin/opencode-watch", 17);
    assert.deepEqual(plain(command), [
      "omarchy-notification-send", "--app-name", "OpenCode", "--urgency", "normal",
      "--expire-time", "17000", summary, "OpenCode session status changed",
      "--exec", "/plugin with spaces/bin/opencode-watch", "--focus", "101",
    ]);
  }
});

test("delivery excludes private session titles from all notification command arguments", () => {
  for (const eventType of ["attention", "finished"]) {
    for (const sessionTitle of [
      " PRIVATE SESSION TEXT ", "<b>PRIVATE SESSION TEXT</b> & verify",
      "--exec", "$(touch /tmp/unwanted)", "   ", null, 123,
    ]) {
      const command = plain(delivery.command({ eventType, sessionTitle, sourcePid: "101",
        focusTarget: "exact-session", preview: "PRIVATE PREVIEW" }, "/watcher", 10));
      assert.equal(command[8], "OpenCode session status changed");
      assert.equal(command.some((argument) => argument.includes("PRIVATE")), false);
      assert.deepEqual(command.slice(-4), ["--exec", "/watcher", "--focus", "exact-session"]);
    }
  }
});

for (const [name, state, closed, eventType] of [
  ["attention", "WAITING", false, "attention"],
  ["approval", "NEEDS_APPROVAL", false, "attention"],
  ["open completion", "IDLE", false, "finished"],
  ["closed completion", "IDLE", true, "finished"],
]) {
  test(`V2 ${name} keeps private snapshot text out of notification decisions and argv`, () => {
    const policy = policyModule.create();
    const session = {
      session_id: "alpha", source_pid: 101, tracking_id: "session-A", focus_target: "exact-A",
      state: "WORKING", session_title: "PRIVATE SESSION TEXT <b>secret</b>",
      project: "PRIVATE PROJECT", preview: "PRIVATE PREVIEW",
    };
    const frame = (sessions, completed_sessions = []) => JSON.stringify({
      counts: { sessions: sessions.length, attention: 0, response: 0, permission: 0, idle: 0, working: 0 },
      sessions, completed_sessions,
    });
    assert.deepEqual(plain(policy.accept(frame([session]), true).decisions), []);
    const current = { ...session, state, completion_id: "101:1" };
    const result = policy.accept(closed ? frame([], [current]) : frame([current]), true);
    const command = plain(delivery.command(result.decisions[0], "/watcher", 17));
    assert.equal(command.some((argument) => argument.includes("PRIVATE")), false);
    assert.equal(command[7], eventType === "attention"
      ? "OpenCode session needs attention" : "OpenCode session finished");
    assert.equal(command[8], "OpenCode session status changed");
    assert.equal(command[6], "17000");
    assert.deepEqual(command.slice(-4), ["--exec", "/watcher", "--focus", "exact-A"]);
    assert.deepEqual(plain(result.decisions), [
      { eventType, sessionId: "alpha", sourcePid: "101", focusTarget: "exact-A" },
    ]);
    const record = closed ? result.snapshot.completed_sessions[0] : result.snapshot.sessions[0];
    assert.equal(record.session_title, session.session_title, "private widget data is preserved");
  });
}

test("delivery falls back to the session ID and preserves timeout rounding, bounds, and default", () => {
  for (const [value, expiry] of [
    [8, "8000"], [30, "30000"], [1, "8000"], [90, "30000"],
    [12.6, "13000"], ["18", "18000"], ["invalid", "10000"], [Infinity, "10000"],
  ]) {
    const command = delivery.command({ eventType: "attention", sessionId: "fallback", sourcePid: "" },
      "/bin/opencode-watch", value);
    assert.equal(command[6], expiry);
    assert.deepEqual(plain(command.slice(-4)), ["--exec", "/bin/opencode-watch", "--focus", "fallback"]);
  }
});
