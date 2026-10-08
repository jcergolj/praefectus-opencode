/* User-private, acknowledged command channel; no shell/terminal input injection. */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

export class NavigationChannel {
  constructor(navigate) {
    this.navigate = navigate;
    this.path = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"),
      "praefectus-opencode", `${randomUUID()}.sock`);
    this.connections = new Set();
    this.server = net.createServer((socket) => {
      this.connections.add(socket);
      socket.on("close", () => this.connections.delete(socket));
      socket.on("error", () => {});
      socket.setTimeout(2000, () => socket.destroy());
      let input = "";
      socket.on("data", (chunk) => {
        input += chunk.toString();
        if (input.length > 8192) return socket.destroy();
        if (!input.includes("\n")) return;
        let ok = false;
        try { ok = this.navigate(JSON.parse(input.split("\n")[0])) === true; } catch {}
        socket.end(JSON.stringify({ ok }) + "\n");
      });
    });
  }

  async start() {
    fs.mkdirSync(path.dirname(this.path), { recursive: true, mode: 0o700 });
    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.path, resolve);
    });
    fs.chmodSync(this.path, 0o600);
  }

  async dispose() {
    for (const socket of this.connections) socket.destroy();
    await new Promise((resolve) => this.server.close(resolve));
  }
}
