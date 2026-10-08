function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function validateSnapshot(snapshot) {
  if (!isObject(snapshot) || !Array.isArray(snapshot.sessions) || !isObject(snapshot.counts))
    throw new Error("Expected snapshot counts and sessions")
  var countNames = ["sessions", "attention", "response", "permission", "idle", "working"]
  for (var index = 0; index < countNames.length; index++) {
    var count = snapshot.counts[countNames[index]]
    if (typeof count !== "number" || !isFinite(count) || count < 0 || Math.floor(count) !== count)
      throw new Error("Invalid snapshot count")
  }
}

function validateSession(session) {
  if (!isObject(session) || ["WORKING", "IDLE", "WAITING", "NEEDS_APPROVAL"].indexOf(session.state) === -1)
    throw new Error("Invalid session state")
  if (session.attention !== undefined && typeof session.attention !== "boolean")
    throw new Error("Invalid session attention")
  if (session.session_id !== undefined && session.session_id !== null && typeof session.session_id !== "string")
    throw new Error("Invalid session ID")
  if (session.tracking_id !== undefined && (typeof session.tracking_id !== "string" || session.tracking_id === ""))
    throw new Error("Invalid tracking ID")
  if (session.focus_target !== undefined && (typeof session.focus_target !== "string" || session.focus_target === ""))
    throw new Error("Invalid focus target")
  var pid = session.source_pid
  if (pid !== undefined && pid !== null && pid !== ""
      && !((typeof pid === "number" && isFinite(pid) && pid > 0 && Math.floor(pid) === pid)
           || (typeof pid === "string" && /^[1-9][0-9]*$/.test(pid))))
    throw new Error("Invalid session PID")
}

// One policy per widget. accept(JSON line, enabled) returns the accepted snapshot
// and focus-targeted decisions. Invalid input throws before advancing memory.
function create() {
  var previousSessions = null
  var completedSessions = Object.create(null)
  return {
    accept: function(inputText, notificationsEnabled) {
      var snapshot = JSON.parse(inputText)
      validateSnapshot(snapshot)
      var currentSessions = Object.create(null)
      var decisions = []
      var nextCompleted = Object.create(null)
      for (var seenKey in completedSessions) nextCompleted[seenKey] = completedSessions[seenKey]
      var completed = snapshot.completed_sessions || []
      if (!Array.isArray(completed)) throw new Error("Invalid completed sessions")
      for (var index = 0; index < snapshot.sessions.length; index++) {
        var session = snapshot.sessions[index]
        validateSession(session)
        var sourcePid = session.source_pid === undefined || session.source_pid === null
          ? "" : String(session.source_pid)
        var sessionId = session.session_id === undefined || session.session_id === null
          ? "" : String(session.session_id)
        if (sourcePid === "" && sessionId === "") throw new Error("Missing session identity")
        var identity = session.tracking_id !== undefined
          ? session.tracking_id : (sourcePid !== "" ? "pid:" + sourcePid : "session:" + sessionId)
        if (currentSessions[identity]) throw new Error("Duplicate session identity")
        var current = {
          state: session.state,
          attention: !!session.attention || session.state === "WAITING" || session.state === "NEEDS_APPROVAL"
        }
        currentSessions[identity] = current
        if (current.state === "WORKING" || current.attention) delete nextCompleted[identity]
        if (notificationsEnabled && previousSessions !== null) {
          var previous = previousSessions[identity]
          var eventType = ""
          if (current.attention && (!previous || !previous.attention)) eventType = "attention"
          else if (previous && previous.state === "WORKING" && current.state === "IDLE") eventType = "finished"
          if (eventType) {
            var decision = { eventType: eventType, sessionId: sessionId, sourcePid: sourcePid }
            if (session.focus_target) decision.focusTarget = session.focus_target
            decisions.push(decision)
          }
        }
        if (session.focus_target && current.state === "IDLE" && previousSessions && previousSessions[identity]
            && previousSessions[identity].state === "WORKING") nextCompleted[identity] = true
      }
      var completionIdentities = Object.create(null)
      for (var completionIndex = 0; completionIndex < completed.length; completionIndex++) {
        var completion = completed[completionIndex]
        validateSession(completion)
        if (!completion.tracking_id || typeof completion.completion_id !== "string"
            || !completion.completion_id || completion.state !== "IDLE")
          throw new Error("Invalid completion record")
        var completionKey = completion.tracking_id
        if (completionIdentities[completionKey]) throw new Error("Duplicate completion identity")
        completionIdentities[completionKey] = true
        if (currentSessions[completionKey]) continue
        if (notificationsEnabled && previousSessions !== null && !nextCompleted[completionKey]) {
          decisions.push({ eventType: "finished", sessionId: completion.session_id,
            sourcePid: String(completion.source_pid), focusTarget: completion.focus_target })
        }
        nextCompleted[completionKey] = true
      }
      previousSessions = currentSessions
      completedSessions = nextCompleted
      return { snapshot: snapshot, decisions: decisions }
    }
  }
}
