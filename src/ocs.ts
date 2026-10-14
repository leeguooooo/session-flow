import { command } from "./process";
import type { Agent, Message, Transport } from "./types";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export class OcsTransport implements Transport {
  constructor(readonly binary = process.env.SFLOW_OCS_BIN ?? "ocs") {}
  async read(channel: string, as: string): Promise<Message[]> {
    const r = await command([this.binary, "read", channel, "--json", "--peek", "--since", "0", "--as", as]);
    if (r.code) throw new Error(`ocs read failed: ${r.stderr.trim()}`);
    const rows = JSON.parse(r.stdout);
    if (!Array.isArray(rows)) throw new Error("invalid OCS read response");
    return rows;
  }
  async send(channel: string, body: unknown, as: string): Promise<void> {
    const r = await command([this.binary, "send", channel, JSON.stringify(body), "--as", as, "--no-wake"]);
    if (r.code) throw new Error(`ocs send exited ${r.code}; reconcile the channel before any further action`);
  }
  // The actor is the native session that owns a step. Claude, Codex and Pi sessions are
  // identified by OCS; agy has no per-session identity, so its actor is bound to the step.
  async whoami(agent?: Agent, scope?: { runId: string; stepId: string }): Promise<string> {
    if (agent === "agy") {
      if (!scope) throw new Error("agy worker identity needs its run and step");
      return `agy-${scope.runId.slice(0, 8)}-${scope.stepId}`;
    }
    const r = await command([this.binary, "whoami", "--json"]);
    if (r.code) throw new Error(`ocs whoami failed: ${r.stderr.trim()}`);
    const identity = JSON.parse(r.stdout), id = identity.id;
    if (typeof id !== "string" || !/^(claude|codex|pi)-[0-9a-f]{8}$/.test(id)) throw new Error("report must run inside a native Claude, Codex or Pi session");
    if (agent && !id.startsWith(agent + "-")) throw new Error(`this step runs on ${agent}, but the reporting session is ${id}`);
    if (id.startsWith("codex-")) {
      // Codex supplies this full id to tool commands. Roster discovery is
      // bounded and may omit a busy worker on machines with many sessions.
      const threadId = identity.threadId ?? process.env.CODEX_THREAD_ID;
      if (typeof threadId !== "string" || !UUID.test(threadId) || !threadId.startsWith(id.slice(6))) throw new Error("full native Codex thread identity unavailable");
      return `codex-${threadId}`;
    }
    if (id.startsWith("pi-")) {
      // The OCS Pi extension exports the full session id to tool commands.
      const sessionId = process.env.OCS_PI_SESSION_ID?.toLowerCase();
      if (!sessionId || !UUID.test(sessionId) || !sessionId.startsWith(id.slice(3))) throw new Error("full Pi session identity unavailable; run `ocs doctor --fix` to install the OCS Pi extension");
      return `pi-${sessionId}`;
    }
    return id;
  }
}
