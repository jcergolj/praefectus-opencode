import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import test from "node:test";
import { loadQmlScript } from "./qml_script_support.mjs";

const widget = await readFile(new URL("../Widget.qml", import.meta.url), "utf8");
const delivery = await loadQmlScript("../NotificationDelivery.js");

test("the widget never instantiates clipboard-aware text editors, even in hidden settings", () => {
  // Visibility, validators, and numeric bounds do not prevent Qt from reading
  // foreign clipboard text. Guard the widget, not just the settings visibility.
  const editor = widget.match(/\b(?:NumberField|SpinBox|TextInput|TextEdit|TextField|TextArea)\s*\{/);
  assert.equal(editor?.[0], undefined, "clipboard-aware editor must not be instantiated");
});

test("timeout buttons preserve one-second steps, bounds, and settings persistence", () => {
  const context = vm.createContext({ NotificationDelivery: delivery });
  const updates = [];
  const root = {
    moduleName: "praefectus.opencode",
    settings: { notificationTimeoutSeconds: 10, coloredCounts: true, notificationsEnabled: true },
    get notificationTimeoutSeconds() {
      return delivery.boundedTimeoutSeconds(this.settings.notificationTimeoutSeconds);
    },
    bar: { shell: { updateEntryInline(name, settings) { updates.push([name, settings]); } } },
  };
  context.root = root;
  const updateSetting = widget.match(/^  function updateSetting\([^)]*\)\s*\{[\s\S]*?^  \}/m);
  const setter = widget.match(/^  function setNotificationTimeout\(seconds\)\s*\{[\s\S]*?^  \}/m);
  assert.ok(updateSetting, "settings must persist through the shell");
  assert.ok(setter, "timeout changes must use the persisted, bounded setting");
  vm.runInContext(`${updateSetting[0]}\n${setter[0]}`, context);
  root.setNotificationTimeout = context.setNotificationTimeout;

  for (const [direction, bound] of [["-", 8], ["+", 30]]) {
    const handler = widget.match(new RegExp(
      `onClicked:\\s*(root\\.setNotificationTimeout\\(root\\.notificationTimeoutSeconds \\${direction} 1\\))`,
    ));
    assert.ok(handler, `missing ${direction} timeout button`);
    root.settings = { ...root.settings, notificationTimeoutSeconds: 10 };
    const previousSettings = root.settings;
    vm.runInContext(handler[1], context);
    assert.equal(root.notificationTimeoutSeconds, direction === "-" ? 9 : 11);
    assert.notEqual(root.settings, previousSettings);
    assert.equal(previousSettings.notificationTimeoutSeconds, 10);
    for (let index = 0; index < 40; index++) vm.runInContext(handler[1], context);
    assert.equal(root.notificationTimeoutSeconds, bound);
    assert.deepEqual(updates.at(-1), [root.moduleName, root.settings]);
    assert.equal(root.settings.coloredCounts, true);
    assert.equal(root.settings.notificationsEnabled, true);
  }
  assert.match(widget, /enabled:\s*root\.notificationTimeoutSeconds > 8/);
  assert.match(widget, /enabled:\s*root\.notificationTimeoutSeconds < 30/);
  assert.match(widget, /text:\s*String\(root\.notificationTimeoutSeconds\)/);
});
