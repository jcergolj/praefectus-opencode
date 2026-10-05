import assert from "node:assert/strict";
import test from "node:test";
import { loadQmlScript, plain } from "./qml_script_support.mjs";

const delivery = await loadQmlScript("../NotificationDelivery.js");

test("desktop delivery uses generic text, configured expiry, and the associated process focus target", () => {
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
