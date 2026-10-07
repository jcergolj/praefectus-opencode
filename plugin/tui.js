/* V2 terminal adapter. Read only public CLI data, never server storage. */
import { createStatusReporter } from "./index.js";

export class TerminalStatusBridge {
  constructor(context, reporter = createStatusReporter({
    directory: (context.location ?? context.data.location.default()).directory,
  })) {
    this.context = context;
    this.reporter = reporter;
    this.synced = new Set();
    this.disposed = false;
    this.refreshing = null;
  }

  sessionIDs() {
    const { data, ui } = this.context;
    const route = ui.router.current();
    const roots = new Set(ui.tabs.enabled() ? ui.tabs.list().map((tab) => tab.sessionID) : []);
    if (route.type === "session") roots.add(data.session.root(route.sessionID));
    return new Set([...roots].flatMap((id) => [id, ...data.session.family(id)]));
  }

  refresh() {
    if (this.disposed) return Promise.resolve();
    if (!this.refreshing) {
      this.refreshing = this.update().catch(() => {
        // A disconnected server or missing metadata must not break the TUI.
      }).finally(() => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async update() {
    const { data } = this.context;
    const ids = this.sessionIDs();
    const added = [...ids].filter((id) => !this.synced.has(id));
    await Promise.all(added.map(async (id) => {
      await data.session.sync(id);
      const location = data.session.get(id)?.location;
      await Promise.all([
        data.session.permission.sync(id),
        data.session.form.sync(id, location),
        data.session.message.sync(id),
        // Context metadata is optional; catalogue failures cannot hide status.
        data.location.model.sync(location).catch(() => {}),
      ]);
      this.synced.add(id);
    }));
    if (this.disposed) return;

    // Route/tab changes do not emit server events. Re-read membership after
    // async syncs so an old tab can never leak into a different terminal.
    const currentIDs = this.sessionIDs();
    const status = this.reporter.processStatus;
    const previous = status.decision;
    for (const id of this.synced) {
      if (!currentIDs.has(id)) this.synced.delete(id);
    }
    for (const id of status.workingSessions) {
      if (!currentIDs.has(id)) status.workingSessions.delete(id);
    }
    for (const id of status.pendingRequests.keys()) {
      if (!currentIDs.has(id)) status.pendingRequests.delete(id);
    }
    if (!currentIDs.has(status.lastSessionId)) status.lastSessionId = null;

    // Aggregate all changes before publishing: answering a permission must
    // not briefly look idle while its session is still running.
    for (const id of currentIDs) {
      if (!this.synced.has(id)) continue;
      status.accept({ type: "session.status", properties: {
        sessionID: id, status: data.session.status(id) === "running" ? "busy" : "idle",
      } });
      const requests = [];
      const permissions = data.session.permission.list(id);
      const forms = data.session.form.list(id, data.session.get(id)?.location);
      for (const permission of permissions ?? []) {
        requests.push({ type: "permission.asked", properties: {
          ...permission, sessionID: id, permission: permission.action, patterns: permission.resources,
        } });
      }
      for (const form of forms ?? []) {
        requests.push({ type: "question.asked", properties: {
          id: form.id, sessionID: id, question: form.title,
        } });
      }
      const keys = new Set(requests.map((request) =>
        `${request.type === "permission.asked" ? "permission" : "question"}:${request.properties.id}`));
      const pending = status.pendingRequests.get(id);
      for (const key of pending?.keys() ?? []) {
        const available = key.startsWith("permission:") ? permissions : forms;
        if (available !== undefined && !keys.has(key)) pending.delete(key);
      }
      if (pending?.size === 0) status.pendingRequests.delete(id);
      for (const request of requests) status.accept(request);
    }
    const route = this.context.ui.router.current();
    status.lastSessionId = route.type === "session" && currentIDs.has(route.sessionID)
      ? route.sessionID : (currentIDs.values().next().value ?? null);
    status.decision = status.aggregate();
    const decision = status.decision;
    if (previous.state !== decision.state) this.reporter.recordBuilder.markTransition();

    // The V2 message/model shapes differ from V1's provider catalogue. Use
    // the model catalogue for the session's actual location and model.
    const session = decision.sessionId ? data.session.get(decision.sessionId) : null;
    const messages = decision.sessionId ? data.session.message.list(decision.sessionId) : [];
    const assistant = [...messages].reverse().find((message) => message.type === "assistant" && message.tokens);
    const models = data.location.model.list(session?.location) ?? [];
    const model = assistant && models.find((candidate) =>
      candidate.providerID === assistant.model?.providerID && candidate.id === assistant.model?.id);
    const contextChanged = this.reporter.recordBuilder.updateContextUsage(assistant, model?.limit?.context);
    if (!this.reporter.hasWrittenRecord || contextChanged || JSON.stringify(previous) !== JSON.stringify(decision)) {
      this.reporter.recordWriter.write(this.reporter.recordBuilder.build(decision, { type: "cli.snapshot" }));
      this.reporter.hasWrittenRecord = true;
    }
  }

  async dispose() {
    this.disposed = true;
    await this.refreshing;
    await this.reporter.dispose();
  }
}

export default {
  id: "praefectus-opencode",
  async setup(context) {
    const bridge = new TerminalStatusBridge(context);
    await bridge.refresh();
    // Public CLI caches are updated by OpenCode's event stream. Polling also
    // catches local tab/route changes without subscribing to private UI state.
    const timer = setInterval(() => void bridge.refresh(), 500);
    return async () => {
      clearInterval(timer);
      await bridge.dispose();
    };
  },
};
