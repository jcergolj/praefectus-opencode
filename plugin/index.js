/*
 * OpenCode status bridge for the Praefectus OpenCode bar widget.
 *
 * OpenCode loads this file for every instance. It records the latest structured
 * session status in a per-process runtime file; the widget watcher reads those
 * files without requiring a background daemon.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const runtimeDir =
  process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache");
const statusDir = path.join(runtimeDir, "praefectus-opencode");
const defaultProcessStartedAt = Date.now() / 1000 - process.uptime();

function readProcessStartTicks(fileSystem = fs) {
  try {
    const stat = fileSystem.readFileSync(`/proc/${process.pid}/stat`, "utf8");
    // The comm field can contain spaces and parentheses; starttime is field 22.
    const closingParen = stat.lastIndexOf(")");
    if (closingParen === -1) return null;
    const field = stat.slice(closingParen + 1).trim().split(/\s+/)[19];
    if (!/^\d+$/.test(field || "")) return null;
    const ticks = Number(field);
    return Number.isSafeInteger(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

const SessionStatus = Object.freeze({
  IDLE: "IDLE",
  WORKING: "WORKING",
  WAITING: "WAITING",
  NEEDS_APPROVAL: "NEEDS_APPROVAL",
});

const DEFAULT_PREVIEWS = Object.freeze({
  IDLE: "idle",
  WORKING: "working",
  WAITING: "waiting for response",
  NEEDS_APPROVAL: "waiting for permission",
});

function textValue(candidateText) {
  return typeof candidateText === "string" && candidateText.trim()
    ? candidateText.trim()
    : "";
}

function permissionPreview(properties) {
  const nestedPermissionProperties = properties?.permission;
  const permissionProperties =
    nestedPermissionProperties && typeof nestedPermissionProperties === "object"
      ? { ...properties, ...nestedPermissionProperties }
      : properties || {};
  const title = textValue(permissionProperties.title);
  const requestedOperation =
    title ||
    textValue(permissionProperties.permission) ||
    textValue(permissionProperties.type);
  const patternValues = permissionProperties.patterns ?? permissionProperties.pattern;
  const patternText = Array.isArray(patternValues)
    ? patternValues.map(textValue).filter(Boolean).join(", ")
    : textValue(patternValues);

  if (!requestedOperation) return patternText || null;
  return patternText
    ? `${requestedOperation}: ${patternText}`
    : requestedOperation;
}

function questionPreview(properties) {
  const directQuestion = textValue(
    properties?.question || properties?.prompt || properties?.message,
  );
  if (directQuestion) return directQuestion;

  const questionEntries = Array.isArray(properties?.questions)
    ? properties.questions
    : [];
  for (const questionEntry of questionEntries) {
    const questionText = textValue(
      questionEntry?.question || questionEntry?.prompt || questionEntry?.message,
    );
    if (questionText) return questionText;
  }
  return null;
}

function finiteNonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function contextTokensFor(info) {
  const tokens = info?.tokens;
  if (!tokens || typeof tokens !== "object") return null;

  const total = finiteNonNegativeNumber(tokens.total);
  if (total !== null) return total;

  const tokenValues = [
    tokens.input,
    tokens.output,
    tokens.reasoning,
    tokens.cache?.read,
    tokens.cache?.write,
  ];
  if (tokenValues.every((value) => value === undefined || value === null)) {
    return null;
  }
  return tokenValues.reduce(
    (sum, value) => sum + (finiteNonNegativeNumber(value) || 0),
    0,
  );
}

function contextLimitFor(providers, providerId, modelId) {
  for (const provider of providers || []) {
    if (String(provider?.id || "") !== String(providerId || "")) continue;
    const model =
      provider?.models?.[modelId] ||
      Object.values(provider?.models || {}).find(
        (candidate) => String(candidate?.id || "") === String(modelId),
      );
    const limit = finiteNonNegativeNumber(model?.limit?.context);
    if (limit !== null && limit > 0) return limit;
  }
  return null;
}

class ContextLimitResolver {
  constructor({ client }) {
    this.client = client;
    this.providersPromise = null;
  }

  async readProviders(request) {
    try {
      return await request();
    } catch {
      return null;
    }
  }

  async providers() {
    if (!this.providersPromise) {
      this.providersPromise = Promise.all([
        typeof this.client?.config?.providers === "function"
          ? this.readProviders(() => this.client.config.providers())
          : Promise.resolve(null),
        typeof this.client?.provider?.list === "function"
          ? this.readProviders(() => this.client.provider.list())
          : Promise.resolve(null),
      ]).then(([configuredResponse, allResponse]) => {
        const configuredData = configuredResponse?.data || configuredResponse;
        const allData = allResponse?.data || allResponse;
        const configuredProviders = configuredData?.providers;
        const allProviders = allData?.all;
        return [
          ...(Array.isArray(configuredProviders) ? configuredProviders : []),
          ...(Array.isArray(allProviders) ? allProviders : []),
        ];
      });
    }
    return this.providersPromise;
  }

  async limitFor(info) {
    if (!info?.providerID || !info?.modelID) return null;
    return contextLimitFor(
      await this.providers(),
      info.providerID,
      info.modelID,
    );
  }
}

class EventStateMapper {
  statusType(properties) {
    const status = properties?.status;
    if (typeof status === "string") return status.toLowerCase();
    return typeof status?.type === "string" ? status.type.toLowerCase() : "";
  }

  stateFor(event) {
    return this.map(event).state;
  }

  map(event) {
    switch (event?.type) {
      case "session.status": {
        const status = this.statusType(event.properties || {});
        if (
          status === "busy" ||
          status === "retry" ||
          status === "working" ||
          status === "running" ||
          status === "generating" ||
          status === "streaming"
        ) {
          return { state: SessionStatus.WORKING, activity: "busy" };
        }
        if (status === "idle") return { state: SessionStatus.IDLE, activity: "idle" };
        return { state: null };
      }
      case "session.idle":
        return { state: SessionStatus.IDLE, activity: "idle" };
      case "question.asked":
        return {
          state: SessionStatus.WAITING, requestKind: "question", requestAction: "upsert",
          preview: questionPreview(event.properties),
        };
      case "permission.asked":
      case "permission.updated":
        return {
          state: SessionStatus.NEEDS_APPROVAL, requestKind: "permission", requestAction: "upsert",
          preview: permissionPreview(event.properties),
        };
      case "permission.replied": {
        const response = event.properties?.reply || event.properties?.response;
        return {
          state: response === "reject" ? SessionStatus.IDLE : SessionStatus.WORKING,
          activity: response === "reject" ? null : "busy",
          requestKind: "permission", requestAction: "remove",
        };
      }
      case "question.replied":
        return {
          state: SessionStatus.WORKING, activity: "busy",
          requestKind: "question", requestAction: "remove",
        };
      case "question.rejected":
        return {
          state: SessionStatus.IDLE, requestKind: "question", requestAction: "remove",
        };
      default:
        return { state: null };
    }
  }
}

// Owns the process-wide decision: outstanding permissions first, then questions,
// oldest within each kind. Activity remains tracked while attention is displayed.
class ProcessStatus {
  constructor() {
    this.eventMapper = new EventStateMapper();
    this.workingSessions = new Set();
    this.pendingRequests = new Map();
    this.requestSequence = 0;
    this.lastSessionId = null;
    this.decision = this.aggregate();
  }

  aggregate() {
    const requests = [...this.pendingRequests.values()].flatMap(
      (sessionRequests) => [...sessionRequests.values()],
    );
    const request = requests
      .filter((candidate) => candidate.state === SessionStatus.NEEDS_APPROVAL)
      .sort((a, b) => a.sequence - b.sequence)[0] ||
      requests.sort((a, b) => a.sequence - b.sequence)[0];
    const state = request?.state ||
      (this.workingSessions.size ? SessionStatus.WORKING : SessionStatus.IDLE);
    return {
      state,
      attention: Boolean(request),
      sessionId: request ? request.sessionId :
        (this.workingSessions.size ? this.workingSessions.values().next().value : this.lastSessionId),
      preview: request?.preview || DEFAULT_PREVIEWS[state],
      eventType: request?.eventType || null,
    };
  }

  accept(event) {
    const properties = event?.properties || {};
    const sessionId = properties.sessionID || properties.sessionId ||
      properties.info?.sessionID || properties.info?.sessionId ||
      ((event?.type === "session.created" || event?.type === "session.updated")
        ? properties.info?.id : null) || null;
    const sessionKey = sessionId ? String(sessionId) : null;
    if (sessionKey) this.lastSessionId = sessionKey;
    const mapped = this.eventMapper.map(event);
    const isRequest = mapped.requestAction === "upsert";

    if (mapped.requestAction) {
      const requestId = properties.id || properties.permissionID ||
        properties.permissionId || properties.requestID || properties.requestId ||
        event.id || `request-${++this.requestSequence}`;
      const requestKey = `${mapped.requestKind}:${requestId}`;
      const requests = this.pendingRequests.get(sessionKey) || new Map();
      if (isRequest) {
        const previous = requests.get(requestKey);
        requests.set(requestKey, {
          sessionId: sessionKey,
          state: mapped.state,
          preview: mapped.preview || previous?.preview || DEFAULT_PREVIEWS[mapped.state],
          eventType: event.type,
          sequence: previous?.sequence ?? ++this.requestSequence,
        });
      } else {
        requests.delete(requestKey);
      }
      if (requests.size) this.pendingRequests.set(sessionKey, requests);
      else this.pendingRequests.delete(sessionKey);
    }

    // Replies that resume work count as busy even if no busy event follows.
    // Rejecting a request is not an idle report for previously resumed work.
    if (mapped.activity === "busy") this.workingSessions.add(sessionKey);
    else if (mapped.activity === "idle") this.workingSessions.delete(sessionKey);

    const previous = this.decision;
    this.decision = this.aggregate();
    return {
      decision: this.decision,
      stateChanged: previous.state !== this.decision.state,
      changed: JSON.stringify(previous) !== JSON.stringify(this.decision),
      recognized: mapped.state !== null,
      requestUpdated: isRequest,
    };
  }
}

class StatusRecordBuilder {
  constructor({
    project,
    directory,
    processId = process.pid,
    environment = process.env,
    processStartedAt = defaultProcessStartedAt,
    processStartTicks = null,
    clock = () => Date.now() / 1000,
  }) {
    this.project =
      project?.id ||
      project?.name ||
      (directory ? path.basename(directory) : "OpenCode") ||
      "OpenCode";
    this.directory = directory || "";
    this.processId = processId;
    this.environment = environment;
    this.processStartedAt = processStartedAt;
    this.processStartTicks = processStartTicks;
    this.clock = clock;
    this.lastTransitionAt = processStartedAt;
    this.contextUsage = null;
  }

  markTransition() {
    this.lastTransitionAt = this.clock();
  }

  updateContextUsage(info, contextLimit) {
    const contextTokens = contextTokensFor(info);
    const contextSize = finiteNonNegativeNumber(contextLimit);
    const nextContextUsage =
      contextTokens === null || contextSize === null || contextSize === 0
        ? null
        : {
            context_tokens: contextTokens,
            context_limit: contextSize,
            context_percentage: Math.round((contextTokens / contextSize) * 100),
          };
    const previousContextUsage = this.contextUsage;
    this.contextUsage = nextContextUsage;
    return JSON.stringify(previousContextUsage) !== JSON.stringify(nextContextUsage);
  }

  build(decision, event) {
    const currentTimestamp = this.clock();

    return {
      session_id: decision.sessionId || `pid:${this.processId}`,
      project: this.project,
      state: decision.state,
      tmux_pane: this.environment.TMUX_PANE || null,
      tmux_socket: this.environment.TMUX || null,
      source_pid: this.processId,
      process_started_at: this.processStartedAt,
      ...(this.processStartTicks === null
        ? {}
        : { process_start_ticks: this.processStartTicks }),
      directory: this.directory,
      notification_id: null,
      attention: decision.attention,
      attention_since: decision.attention ? this.lastTransitionAt : null,
      last_transition_ts: this.lastTransitionAt || currentTimestamp,
      preview: decision.preview,
      event_type: decision.eventType || event?.type || null,
      updated_at: currentTimestamp,
      ...(this.contextUsage || {}),
    };
  }
}

class AtomicStatusRecordWriter {
  constructor({
    directory,
    recordPath,
    fileSystem = fs,
    processId = process.pid,
    clock = () => Date.now(),
  }) {
    this.directory = directory;
    this.recordPath = recordPath;
    this.fileSystem = fileSystem;
    this.processId = processId;
    this.clock = clock;
    this.sequence = 0;
  }

  write(record) {
    let temporaryPath = null;
    try {
      this.fileSystem.mkdirSync(this.directory, {
        recursive: true,
        mode: 0o700,
      });
      this.sequence += 1;
      temporaryPath = path.join(
        this.directory,
        `.${this.processId}.${this.clock()}.${this.sequence}.tmp`,
      );
      this.fileSystem.writeFileSync(
        temporaryPath,
        `${JSON.stringify(record)}\n`,
        {
          encoding: "utf8",
          mode: 0o600,
        },
      );
      this.fileSystem.renameSync(temporaryPath, this.recordPath);
      temporaryPath = null;
    } catch {
      // Status reporting must never interfere with the OpenCode session.
    } finally {
      if (temporaryPath) {
        try {
          this.fileSystem.unlinkSync(temporaryPath);
        } catch {
          // The temporary file may already have been removed.
        }
      }
    }
  }

  remove() {
    try {
      this.fileSystem.unlinkSync(this.recordPath);
    } catch {
      // The watcher can ignore a missing record.
    }
  }
}

class OpenCodeStatusReporter {
  constructor({
    processStatus = new ProcessStatus(),
    recordBuilder,
    recordWriter,
    contextLimitFor: resolveContextLimit = async () => null,
  }) {
    this.processStatus = processStatus;
    this.recordBuilder = recordBuilder;
    this.recordWriter = recordWriter;
    this.resolveContextLimit = resolveContextLimit;
    this.hasWrittenRecord = false;
  }

  async handle(event) {
    const update = this.processStatus.accept(event);
    if (update.stateChanged) this.recordBuilder.markTransition();

    let contextUsageChanged = false;
    const messageInfo = event?.type === "message.updated" ? event.properties?.info : null;
    if (messageInfo?.role === "assistant" && typeof this.recordBuilder.updateContextUsage === "function") {
      let contextLimit = null;
      try {
        contextLimit = await this.resolveContextLimit(messageInfo);
      } catch {
        contextLimit = null;
      }
      contextUsageChanged = this.recordBuilder.updateContextUsage(
        messageInfo,
        contextLimit,
      );
    }

    if (
      update.changed ||
      (update.recognized && !this.hasWrittenRecord) ||
      event?.type === "session.created" ||
      event?.type === "session.updated" ||
      update.requestUpdated ||
      contextUsageChanged
    ) {
      this.recordWriter.write(
        this.recordBuilder.build(this.processStatus.decision, event),
      );
      this.hasWrittenRecord = true;
    }
  }

  async initialize() {
    if (this.hasWrittenRecord) return;
    this.recordWriter.write(
      this.recordBuilder.build(this.processStatus.decision, {
        type: "server.connected",
        properties: {},
      }),
    );
    this.hasWrittenRecord = true;
  }

  async dispose() {
    this.recordWriter.remove();
  }
}

function createStatusReporter({ project, directory, client }) {
  const recordPath = path.join(statusDir, `${process.pid}.json`);
  const contextLimitResolver = new ContextLimitResolver({ client });
  const reporter = new OpenCodeStatusReporter({
    recordBuilder: new StatusRecordBuilder({
      project,
      directory,
      processStartedAt: defaultProcessStartedAt,
      processStartTicks: readProcessStartTicks(),
    }),
    recordWriter: new AtomicStatusRecordWriter({
      directory: statusDir,
      recordPath,
    }),
    contextLimitFor: (info) => contextLimitResolver.limitFor(info),
  });
  return reporter;
}

async function server(context) {
  const reporter = createStatusReporter(context);
  await reporter.initialize();

  return {
    event: async ({ event }) => reporter.handle(event),
    dispose: async () => reporter.dispose(),
  };
}

export {
  AtomicStatusRecordWriter,
  ContextLimitResolver,
  EventStateMapper,
  OpenCodeStatusReporter,
  ProcessStatus,
  SessionStatus,
  StatusRecordBuilder,
  contextLimitFor,
  contextTokensFor,
  createStatusReporter,
  readProcessStartTicks,
};

export default {
  id: "praefectus-opencode",
  server,
  // V2 status belongs to the terminal process, not the shared server. The
  // sibling tui entrypoint owns reporting; never publish the server's PID.
  setup() {},
};
