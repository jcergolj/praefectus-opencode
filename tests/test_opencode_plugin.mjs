import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const pluginSource = await readFile(
  new URL("../plugin/index.js", import.meta.url),
  "utf8",
);
const plugin = await import(`data:text/javascript,${encodeURIComponent(pluginSource)}`);

test("process start ticks use field 22 after the last closing parenthesis", () => {
  for (const ticks of [0, 12345, Number.MAX_SAFE_INTEGER]) {
    const result = plugin.readProcessStartTicks({
      readFileSync(filePath, encoding) {
        assert.equal(filePath, `/proc/${process.pid}/stat`);
        assert.equal(encoding, "utf8");
        return `${process.pid} (open (code) worker))\tS 1 ${"0 ".repeat(17)}${ticks} 999\n`;
      },
    });
    assert.equal(result, ticks);
    const builder = new plugin.StatusRecordBuilder({
      processId: 123,
      processStartedAt: 10,
      processStartTicks: result,
    });
    assert.equal(builder.build({ state: "WORKING" }).process_start_ticks, ticks);
  }
});

test("unreadable or malformed process stat falls back to timestamp-only records", () => {
  const prefix = `123 (opencode) S 1 ${"0 ".repeat(17)}`;
  const stats = [
    null, "", "123 opencode S 1", "123 (opencode) S 1",
    ...["-1", "1.5", "12oops", "NaN", "Infinity", "9007199254740993"]
      .map((ticks) => `${prefix}${ticks}`),
  ];
  for (const stat of stats) {
    const ticks = plugin.readProcessStartTicks({
      readFileSync() {
        if (stat === null) throw new Error("proc unavailable");
        return stat;
      },
    });
    assert.equal(ticks, null);
    const record = new plugin.StatusRecordBuilder({
      processId: 123,
      processStartedAt: 10,
      processStartTicks: ticks,
    }).build({ state: "WORKING" });
    assert.equal(Object.hasOwn(record, "process_start_ticks"), false);
    assert.equal(record.process_started_at, 10);
  }
});

test("event mapper translates OpenCode events into domain states", () => {
  const stateMapper = new plugin.EventStateMapper();

  for (const status of ["busy", "retry", "working", "running", "generating", "streaming"]) {
    assert.equal(
      stateMapper.stateFor({ type: "session.status", properties: { status } }),
      plugin.SessionStatus.WORKING,
    );
  }
  assert.equal(
    stateMapper.stateFor({ type: "session.status", properties: { status: { type: "idle" } } }),
    plugin.SessionStatus.IDLE,
  );
  assert.equal(
    stateMapper.stateFor({ type: "question.asked" }),
    plugin.SessionStatus.WAITING,
  );
  assert.equal(
    stateMapper.stateFor({ type: "permission.asked" }),
    plugin.SessionStatus.NEEDS_APPROVAL,
  );
  assert.equal(stateMapper.stateFor({ type: "session.updated" }), null);
});

test("context usage helpers calculate tokens and resolve model limits", () => {
  assert.equal(
    plugin.contextTokensFor({
      tokens: {
        input: 100,
        output: 20,
        reasoning: 5,
        cache: { read: 30, write: 10 },
      },
    }),
    165,
  );
  assert.equal(
    plugin.contextTokensFor({ tokens: { total: 42, input: 100 } }),
    42,
  );
  assert.equal(plugin.contextTokensFor({}), null);
  assert.equal(
    plugin.contextLimitFor(
      [
        {
          id: "demo",
          models: { "model-1": { limit: { context: 8192 } } },
        },
      ],
      "demo",
      "model-1",
    ),
    8192,
  );
  assert.equal(plugin.contextLimitFor([], "demo", "model-1"), null);
});

test("context limit resolver caches provider metadata", async () => {
  let configuredCalls = 0;
  let allCalls = 0;
  const resolver = new plugin.ContextLimitResolver({
    client: {
      config: {
        providers: async () => {
          configuredCalls += 1;
          return {
            data: {
              providers: [
                {
                  id: "demo",
                  models: { "model-1": { limit: { context: 4096 } } },
                },
              ],
            },
          };
        },
      },
      provider: {
        list: async () => {
          allCalls += 1;
          return { data: { all: [] } };
        },
      },
    },
  });

  assert.equal(
    await resolver.limitFor({ providerID: "demo", modelID: "model-1" }),
    4096,
  );
  assert.equal(
    await resolver.limitFor({ providerID: "demo", modelID: "model-1" }),
    4096,
  );
  assert.equal(configuredCalls, 1);
  assert.equal(allCalls, 1);
});

test("record builder produces the watcher status contract", () => {
  const timestamps = [20, 30, 40];
  const builder = new plugin.StatusRecordBuilder({
    project: { name: "Demo" },
    directory: "/work/demo",
    processId: 123,
    environment: { TMUX_PANE: "%1", TMUX: "/tmp/tmux" },
    processStartedAt: 10,
    clock: () => timestamps.shift(),
  });

  const status = new plugin.ProcessStatus();
  const event = {
    type: "session.created",
    properties: { sessionID: "session-1" },
  };
  const idleRecord = builder.build(status.accept(event).decision, event);
  builder.markTransition();
  const question = { type: "question.asked", properties: { sessionID: "session-1" } };
  const waitingRecord = builder.build(status.accept(question).decision, question);

  assert.deepEqual(idleRecord, {
    session_id: "session-1",
    project: "Demo",
    state: "IDLE",
    tmux_pane: "%1",
    tmux_socket: "/tmp/tmux",
    source_pid: 123,
    process_started_at: 10,
    directory: "/work/demo",
    notification_id: null,
    attention: false,
    attention_since: null,
    last_transition_ts: 10,
    preview: "idle",
    event_type: "session.created",
    updated_at: 20,
  });
  assert.equal(waitingRecord.session_id, "session-1");
  assert.equal(waitingRecord.state, "WAITING");
  assert.equal(waitingRecord.attention, true);
  assert.equal(waitingRecord.attention_since, 30);
  assert.equal(waitingRecord.last_transition_ts, 30);
  assert.equal(waitingRecord.updated_at, 40);
});

test("reporter writes a baseline record before the first session event", async () => {
  const writtenRecords = [];
  const builder = new plugin.StatusRecordBuilder({
    project: { name: "Demo" },
    directory: "/work/demo",
    processId: 123,
    environment: {},
    processStartedAt: 10,
    clock: () => 20,
  });
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: builder,
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {},
    },
  });

  await reporter.initialize();

  assert.deepEqual(writtenRecords, [
    {
      session_id: "pid:123",
      project: "Demo",
      state: "IDLE",
      tmux_pane: null,
      tmux_socket: null,
      source_pid: 123,
      process_started_at: 10,
      directory: "/work/demo",
      notification_id: null,
      attention: false,
      attention_since: null,
      last_transition_ts: 10,
      preview: "idle",
      event_type: "server.connected",
      updated_at: 20,
    },
  ]);
});

test("record builder includes the latest context percentage", () => {
  const builder = new plugin.StatusRecordBuilder({
    project: { name: "Demo" },
    directory: "/work/demo",
    processId: 123,
    environment: {},
    processStartedAt: 10,
    clock: () => 20,
  });
  const info = {
    sessionID: "session-1",
    role: "assistant",
    tokens: {
      input: 400,
      output: 50,
      reasoning: 25,
      cache: { read: 20, write: 5 },
    },
  };

  assert.equal(builder.updateContextUsage(info, 1000), true);
  assert.deepEqual(
    builder.build({ state: "WORKING", attention: false, sessionId: "session-1", preview: "working" }, {
      type: "message.updated",
      properties: { info },
    }),
    {
      session_id: "session-1",
      project: "Demo",
      state: "WORKING",
      tmux_pane: null,
      tmux_socket: null,
      source_pid: 123,
      process_started_at: 10,
      directory: "/work/demo",
      notification_id: null,
      attention: false,
      attention_since: null,
      last_transition_ts: 10,
      preview: "working",
      event_type: "message.updated",
      updated_at: 20,
      context_tokens: 500,
      context_limit: 1000,
      context_percentage: 50,
    },
  );
});

test("reporter writes assistant context usage updates", async () => {
  const writtenRecords = [];
  const builder = new plugin.StatusRecordBuilder({
    project: { name: "Demo" },
    directory: "/work/demo",
    processId: 123,
    processStartedAt: 10,
    clock: () => 20,
  });
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: builder,
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {},
    },
    contextLimitFor: async () => 2000,
  });

  await reporter.handle({
    type: "message.updated",
    properties: {
      info: {
        sessionID: "session-1",
        role: "assistant",
        providerID: "demo",
        modelID: "model-1",
        tokens: {
          input: 900,
          output: 50,
          reasoning: 25,
          cache: { read: 20, write: 5 },
        },
      },
    },
  });

  assert.equal(writtenRecords.length, 1);
  assert.equal(writtenRecords[0].context_percentage, 50);
});

test("reporter records an initial idle status from a restored session", async () => {
  const writtenRecords = [];
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: {
      markTransition() {},
      build(decision, event) {
        return { state: decision.state, eventType: event.type };
      },
    },
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {},
    },
  });

  await reporter.handle({
    type: "session.status",
    properties: { sessionID: "session-1", status: { type: "idle" } },
  });

  assert.deepEqual(writtenRecords, [
    { state: plugin.SessionStatus.IDLE, eventType: "session.status" },
  ]);
});

test("permission records include the requested operation in their preview", () => {
  const builder = new plugin.StatusRecordBuilder({
    project: { name: "Demo" },
    directory: "/work/demo",
    processId: 123,
    processStartedAt: 10,
    clock: () => 20,
  });

  const event = {
    type: "permission.updated",
    properties: {
      sessionID: "session-1",
      permission: "edit",
      patterns: ["src/app.js"],
    },
  };
  const permissionRecord = builder.build(new plugin.ProcessStatus().accept(event).decision, event);

  assert.equal(permissionRecord.preview, "edit: src/app.js");
});

test("reporter coordinates mapping, transitions, records, and disposal", async () => {
  const writtenRecords = [];
  let removeCallCount = 0;
  let transitionMarkCount = 0;
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: {
      markTransition() {
        transitionMarkCount += 1;
      },
      build(decision, event) {
        return { state: decision.state, eventType: event.type };
      },
    },
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {
        removeCallCount += 1;
      },
    },
  });

  await reporter.handle({
    type: "session.created",
    properties: { info: { id: "session-1" } },
  });
  await reporter.handle({
    type: "session.status",
    properties: { sessionID: "session-1", status: "busy" },
  });
  await reporter.handle({ type: "question.asked", properties: { sessionID: "session-1", id: "question-1" } });
  await reporter.handle({
    type: "permission.asked",
    properties: { id: "permission-1", sessionID: "session-1" },
  });
  await reporter.handle({
    type: "permission.replied",
    properties: {
      sessionID: "session-1",
      permissionID: "permission-1",
      response: "reject",
    },
  });
  await reporter.handle({
    type: "session.idle",
    properties: { sessionID: "session-1" },
  });
  await reporter.handle({
    type: "question.rejected",
    properties: { sessionID: "session-1", id: "question-1" },
  });
  await reporter.handle({
    type: "permission.asked",
    properties: { id: "permission-2", sessionID: "session-1" },
  });
  await reporter.dispose();

  assert.deepEqual(writtenRecords, [
    { state: "IDLE", eventType: "session.created" },
    { state: "WORKING", eventType: "session.status" },
    { state: "WAITING", eventType: "question.asked" },
    { state: "NEEDS_APPROVAL", eventType: "permission.asked" },
    { state: "WAITING", eventType: "permission.replied" },
    { state: "IDLE", eventType: "question.rejected" },
    { state: "NEEDS_APPROVAL", eventType: "permission.asked" },
  ]);
  assert.equal(transitionMarkCount, 6);
  assert.equal(removeCallCount, 1);
});

test("permission requests remain visible until they are answered", async () => {
  const writtenRecords = [];
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: {
      markTransition() {},
      build(decision) {
        return { state: decision.state };
      },
    },
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {},
    },
  });

  await reporter.handle({
    type: "permission.updated",
    properties: { id: "permission-1", sessionID: "session-1" },
  });
  await reporter.handle({
    type: "session.status",
    properties: { sessionID: "session-1", status: { type: "idle" } },
  });

  assert.equal(writtenRecords.at(-1).state, plugin.SessionStatus.NEEDS_APPROVAL);

  await reporter.handle({
    type: "permission.replied",
    properties: {
      sessionID: "session-1",
      permissionID: "permission-1",
      response: "reject",
    },
  });

  assert.equal(writtenRecords.at(-1).state, plugin.SessionStatus.IDLE);
});

test("permission updates refresh the expanded preview", async () => {
  const writtenRecords = [];
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: {
      markTransition() {},
      build(decision, event) {
        return { state: decision.state, eventType: event.type };
      },
    },
    recordWriter: {
      write(record) {
        writtenRecords.push(record);
      },
      remove() {},
    },
  });

  await reporter.handle({
    type: "permission.asked",
    properties: { id: "permission-1", sessionID: "session-1" },
  });
  await reporter.handle({
    type: "permission.updated",
    properties: { id: "permission-1", sessionID: "session-1" },
  });

  assert.deepEqual(writtenRecords.map((record) => record.eventType), [
    "permission.asked",
    "permission.updated",
  ]);
});

function createReporter() {
  const records = [];
  const reporter = new plugin.OpenCodeStatusReporter({
    recordBuilder: new plugin.StatusRecordBuilder({
      processId: 123,
      processStartedAt: 10,
      clock: () => 20,
    }),
    recordWriter: {
      write: (record) => records.push(record),
      remove() {},
    },
  });
  return { reporter, records };
}

function statusEvent(sessionID, type) {
  return { type: "session.status", properties: { sessionID, status: { type } } };
}

test("process status chooses permissions before responses and the oldest request within each kind", () => {
  for (const permissionFirst of [false, true]) {
    const status = new plugin.ProcessStatus();
    const question = { type: "question.asked", properties: {
      sessionID: "A", id: "shared-id", question: "Choose a branch",
    } };
    const permission = { type: "permission.asked", properties: {
      sessionID: "A", id: "shared-id", permission: "edit", patterns: ["first.js"],
    } };
    for (const event of permissionFirst ? [permission, question] : [question, permission]) {
      status.accept(event);
    }
    status.accept({ type: "permission.asked", properties: {
      sessionID: "B", id: "permission-2", title: "Second permission",
    } });
    assert.deepEqual(status.decision, {
      state: "NEEDS_APPROVAL", attention: true, sessionId: "A",
      preview: "edit: first.js", eventType: "permission.asked",
    });
    status.accept({ ...permission, type: "permission.updated", properties: {
      ...permission.properties, patterns: ["updated.js"],
    } });
    assert.equal(status.decision.preview, "edit: updated.js");
    status.accept({ type: "permission.replied", properties: {
      sessionID: "A", permissionID: "shared-id", reply: "once",
    } });
    assert.deepEqual(status.decision, {
      state: "NEEDS_APPROVAL", attention: true, sessionId: "B",
      preview: "Second permission", eventType: "permission.asked",
    });
    status.accept({ type: "permission.replied", properties: {
      sessionID: "B", id: "permission-2", response: "reject",
    } });
    assert.deepEqual(status.decision, {
      state: "WAITING", attention: true, sessionId: "A",
      preview: "Choose a branch", eventType: "question.asked",
    });
  }
});

test("answering one request preserves other requests and resumed activity", () => {
  for (const [asked, replied, rejected] of [
    ["permission.asked", "permission.replied", "permission.replied"],
    ["question.asked", "question.replied", "question.rejected"],
  ]) {
    const status = new plugin.ProcessStatus();
    for (const sessionID of ["A", "B"]) {
      status.accept({ type: asked, properties: { sessionID, id: "same-id", title: sessionID, question: sessionID } });
    }
    status.accept({ type: replied, properties: { sessionID: "A", id: "same-id", reply: "once" } });
    assert.equal(status.decision.attention, true);
    assert.equal(status.decision.sessionId, "B");
    assert.equal(status.decision.preview, "B");
    status.accept(statusEvent("A", "idle"));
    status.accept({ type: rejected, properties: { sessionID: "B", id: "wrong-id", reply: "reject" } });
    assert.equal(status.decision.attention, true, "a mismatched reply cannot clear a request");
    status.accept({ type: replied, properties: { sessionID: "B", id: "same-id", reply: "once" } });
    assert.equal(status.decision.state, "WORKING");
    status.accept(statusEvent("A", "idle"));
    status.accept(statusEvent("unrelated", "idle"));
    assert.equal(status.decision.state, "WORKING", "a reply resumes work without needing a busy event");
    status.accept(statusEvent("B", "idle"));
    assert.equal(status.decision.state, "IDLE");
    assert.equal(status.decision.attention, false);
  }
});

test("rejecting another request cannot finish work resumed by an earlier reply", () => {
  for (const [asked, replied, rejected] of [
    ["permission.asked", "permission.replied", "permission.replied"],
    ["question.asked", "question.replied", "question.rejected"],
  ]) {
    const status = new plugin.ProcessStatus();
    for (const id of ["first", "second"]) {
      status.accept({ type: asked, properties: { sessionID: "A", id } });
    }
    status.accept({ type: replied, properties: { sessionID: "A", id: "first", reply: "once" } });
    assert.equal(status.decision.attention, true);
    status.accept({ type: rejected, properties: { sessionID: "A", id: "second", reply: "reject" } });
    assert.equal(status.decision.state, "WORKING");
    assert.equal(status.decision.attention, false);
    status.accept(statusEvent("unrelated", "idle"));
    assert.equal(status.decision.state, "WORKING");
    status.accept(statusEvent("A", "idle"));
    assert.equal(status.decision.state, "IDLE");
  }
});

test("a subagent finishing does not mark its busy parent as finished", async () => {
  const { reporter, records } = createReporter();
  await reporter.handle(statusEvent("parent", "busy"));
  await reporter.handle(statusEvent("child", "busy"));
  await reporter.handle(statusEvent("child", "idle"));
  await reporter.handle({ type: "session.idle", properties: { sessionID: "child" } });

  assert.deepEqual(records.map((record) => record.state), ["WORKING"]);

  await reporter.handle(statusEvent("parent", "idle"));
  await reporter.handle({ type: "session.idle", properties: { sessionID: "parent" } });
  assert.deepEqual(records.map((record) => record.state), ["WORKING", "IDLE"]);
  assert.equal(records.at(-1).session_id, "parent");
});

test("the process stays working until all busy sessions finish", async () => {
  const { reporter, records } = createReporter();
  await reporter.handle(statusEvent("parent", "busy"));
  await reporter.handle(statusEvent("child-1", "busy"));
  await reporter.handle(statusEvent("child-2", "retry"));
  await reporter.handle(statusEvent("parent", "idle"));
  await reporter.handle(statusEvent("child-1", "idle"));
  assert.ok(records.every((record) => record.state === "WORKING"));
  assert.equal(records.at(-1).session_id, "child-2");

  await reporter.handle(statusEvent("child-2", "idle"));
  assert.equal(records.at(-1).state, "IDLE");
});

test("an unrelated idle session cannot finish a busy session", async () => {
  const { reporter, records } = createReporter();
  await reporter.handle(statusEvent("active", "busy"));
  await reporter.handle(statusEvent("restored", "idle"));
  assert.deepEqual(records.map((record) => record.state), ["WORKING"]);
  assert.equal(records.at(-1).session_id, "active");
});

test("rejecting a child request does not finish a busy parent", async () => {
  for (const [asked, replied, replyProperties] of [
    ["permission.asked", "permission.replied", { reply: "reject" }],
    ["question.asked", "question.rejected", {}],
  ]) {
    const { reporter, records } = createReporter();
    await reporter.handle(statusEvent("parent", "busy"));
    await reporter.handle(statusEvent("child", "busy"));
    await reporter.handle({
      type: asked,
      properties: { sessionID: "child", id: "request-1" },
    });
    await reporter.handle({
      type: replied,
      properties: { sessionID: "child", id: "request-1", ...replyProperties },
    });
    await reporter.handle(statusEvent("child", "idle"));
    assert.deepEqual(records.map((record) => record.state), [
      "WORKING", asked === "question.asked" ? "WAITING" : "NEEDS_APPROVAL", "WORKING",
    ]);
    await reporter.handle(statusEvent("parent", "idle"));
    assert.equal(records.at(-1).state, "IDLE");
  }
});

test("an idle event from another session cannot clear a pending request", async () => {
  const { reporter, records } = createReporter();
  await reporter.handle({
    type: "question.asked",
    properties: { sessionID: "child", id: "question-1" },
  });
  await reporter.handle(statusEvent("parent", "idle"));
  assert.deepEqual(records.map((record) => record.state), ["WAITING"]);
  await reporter.handle({
    type: "question.replied",
    properties: { sessionID: "child", id: "question-1" },
  });
  await reporter.handle(statusEvent("child", "idle"));
  assert.deepEqual(records.map((record) => record.state), ["WAITING", "WORKING", "IDLE"]);
});
