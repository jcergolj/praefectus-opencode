/* V2 membership belongs to local tabs; status belongs to each root session. */
import { createHash } from "node:crypto";
import { createStatusReporter, ProcessStatus, StatusRecordBuilder } from "./index.js";
import { NavigationChannel } from "./navigation.js";

export class TerminalStatusBridge {
  constructor(context, reporter = createStatusReporter({
    directory: (context.location ?? context.data.location.default()).directory,
  })) {
    this.context = context;
    this.reporter = reporter;
    this.sessions = new Map();
    this.completed = new Map();
    this.known = new Set();
    this.serverID = null;
    this.disposed = false;
    this.refreshing = null;
    this.channel = null;
    this.navigationWarning = null;
    this.sequence = 0;
  }

  sessionIDs() {
    const { data, ui } = this.context;
    const route = ui.router.current();
    const ids = ui.tabs.enabled() ? ui.tabs.list().map((tab) => tab.sessionID)
      : (route.type === "session" ? [data.session.root(route.sessionID)] : []);
    return new Set(ids.filter(Boolean).map((id) => data.session.root(id)));
  }

  async startNavigation() {
    this.channel = new NavigationChannel((command) => this.navigate(command));
    await this.channel.start();
  }

  navigate(command) {
    if (this.disposed || command.server_id !== this.serverID ||
        !this.known.has(command.session_id)) return false;
    const { ui } = this.context;
    if (ui.tabs.enabled()) ui.tabs.focus(command.session_id);
    else ui.router.navigate({ type: "session", sessionID: command.session_id });
    return true;
  }

  refresh() {
    if (this.disposed) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.update().catch(() => {
        // Disconnections cannot replace reliable status with invented idle data.
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async update() {
    const { data, client } = this.context;
    if (!this.serverID) {
      const info = await client.server.info();
      this.serverID = createHash("sha256").update(JSON.stringify({
        urls: [...info.urls].sort(), pid: info.pid, tmp: info.paths.tmp,
      })).digest("hex");
    }
    const ids = this.sessionIDs();
    for (const id of ids) {
      if (this.sessions.has(id)) continue;
      await data.session.sync(id);
      const session = data.session.get(id);
      if (!session || session.parentID) continue;
      await Promise.all([
        data.session.permission.sync(id), data.session.form.sync(id, session.location),
        data.session.message.sync(id), data.location.model.sync(session.location).catch(() => {}),
      ]);
      if (this.disposed) return;
      const builder = new StatusRecordBuilder({ ...this.reporter.recordBuilder,
        directory: session.location.directory });
      this.sessions.set(id, { status: new ProcessStatus(), builder, record: null });
      this.known.add(id);
    }
    if (this.disposed) return;
    // Re-read tabs after asynchronous cache synchronization.
    const open = this.sessionIDs();
    for (const [id, entry] of this.sessions) {
      const wasActive = entry.record && entry.record.state !== "IDLE";
      const newlyActive = !entry.record && (data.session.status(id) === "running" ||
        (data.session.permission.list(id) ?? []).some((p) => !p.sessionID || p.sessionID === id) ||
        (data.session.form.list(id, data.session.get(id)?.location) ?? []).some((f) => !f.sessionID || f.sessionID === id));
      if (!open.has(id) && !wasActive && !newlyActive) {
        this.sessions.delete(id);
        continue;
      }
      const { status, builder } = entry;
      const previous = status.decision;
      const activity = data.session.status(id);
      if (activity !== "running" && activity !== "idle") continue;
      status.accept({ type: "session.status", properties: {
        sessionID: id, status: activity === "running" ? "busy" : "idle",
      } });
      const permissions = data.session.permission.list(id);
      const forms = data.session.form.list(id, data.session.get(id)?.location);
      const requests = [
        ...(permissions ?? []).filter((p) => !p.sessionID || p.sessionID === id).map((p) => ({ type: "permission.asked", properties: {
          ...p, sessionID: id, permission: p.action, patterns: p.resources,
        } })),
        ...(forms ?? []).filter((f) => !f.sessionID || f.sessionID === id).map((f) => ({ type: "question.asked", properties: {
          id: f.id, sessionID: id, question: f.title,
        } })),
      ];
      const keys = new Set(requests.map((r) =>
        `${r.type === "permission.asked" ? "permission" : "question"}:${r.properties.id}`));
      const pending = status.pendingRequests.get(id);
      for (const key of pending?.keys() ?? []) {
        if ((key.startsWith("permission:") ? permissions : forms) !== undefined && !keys.has(key)) pending.delete(key);
      }
      if (pending?.size === 0) status.pendingRequests.delete(id);
      for (const request of requests) status.accept(request);
      status.decision = status.aggregate();
      if (previous.state !== status.decision.state) builder.markTransition();
      const session = data.session.get(id);
      const messages = data.session.message.list(id) ?? [];
      const assistant = [...messages].reverse().find((m) => m.type === "assistant" && m.tokens);
      const model = (data.location.model.list(session?.location) ?? []).find((m) =>
        m.providerID === assistant?.model?.providerID && m.id === assistant?.model?.id);
      builder.updateContextUsage(assistant, model?.limit?.context);
      entry.record = { ...builder.build(status.decision, { type: "cli.snapshot" }),
        server_id: this.serverID, tab_open: open.has(id),
        session_created_at: session?.time?.created ?? builder.processStartedAt,
        navigation_socket: this.channel?.path ?? null };
      if (open.has(id)) this.completed.delete(id);
      else if (entry.record.state === "IDLE") {
        // Durable until reopened/exit: a slower watcher cannot miss completion.
        this.completed.set(id, { ...entry.record,
          completion_id: `${this.reporter.recordBuilder.processId}:${++this.sequence}` });
        this.sessions.delete(id);
      }
    }
    const owner = this.reporter.recordBuilder.build(this.reporter.processStatus.decision, null);
    this.reporter.recordWriter.write({ ...owner, bridge_version: 2, server_id: this.serverID,
      sessions: [...this.sessions.values()].map((entry) => entry.record).filter(Boolean),
      completed_sessions: [...this.completed.values()],
      warnings: [
        ...[...this.sessions].filter(([, entry]) => !entry.record)
          .map(([id]) => `Session ${id}: awaiting status bridge data`),
        ...(this.navigationWarning ? [this.navigationWarning] : []),
      ],
    });
  }

  async dispose() {
    this.disposed = true;
    await this.refreshing;
    await this.channel?.dispose();
    await this.reporter.dispose();
  }
}

export default {
  id: "praefectus-opencode",
  async setup(context) {
    const bridge = new TerminalStatusBridge(context);
    try { await bridge.startNavigation(); } catch {
      await bridge.channel?.dispose();
      bridge.channel = null;
      bridge.navigationWarning = "exact-session navigation unavailable (could not create local command socket)";
    }
    await bridge.refresh();
    const timer = setInterval(() => void bridge.refresh(), 500);
    return async () => { clearInterval(timer); await bridge.dispose(); };
  },
};
