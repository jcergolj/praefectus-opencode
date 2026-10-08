// Desktop-specific command construction; execution and process lifetime are QML's.
function boundedTimeoutSeconds(value) {
  var seconds = Number(value)
  if (!isFinite(seconds)) seconds = 10
  return Math.max(8, Math.min(30, Math.round(seconds)))
}

function command(decision, watcherPath, timeoutSeconds) {
  return [
    "omarchy-notification-send",
    "--app-name", "OpenCode",
    "--urgency", "normal",
    "--expire-time", String(boundedTimeoutSeconds(timeoutSeconds) * 1000),
    decision.eventType === "attention" ? "OpenCode session needs attention" : "OpenCode session finished",
    "OpenCode session status changed",
    "--exec", watcherPath,
    "--focus", decision.focusTarget || (decision.sourcePid !== "" ? decision.sourcePid : decision.sessionId)
  ]
}
