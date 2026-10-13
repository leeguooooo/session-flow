import { command } from "./process";
import type { Message, Transport } from "./types";
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
  async whoami(): Promise<string> {
    const r = await command([this.binary, "whoami", "--json"]);
    if (r.code) throw new Error(`ocs whoami failed: ${r.stderr.trim()}`);
    const identity = JSON.parse(r.stdout), id = identity.id;
    if (typeof id !== "string" || !/^(claude|codex)-[0-9a-f]{8}$/.test(id)) throw new Error("report must run inside a native Claude/Codex session");
    if (id.startsWith("codex-")) {
      // Codex supplies this full id to tool commands. Roster discovery is
      // bounded and may omit a busy worker on machines with many sessions.
      const threadId = identity.threadId ?? process.env.CODEX_THREAD_ID;
      if (typeof threadId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(threadId) || !threadId.startsWith(id.slice(6))) throw new Error("full native Codex thread identity unavailable");
      return `codex-${threadId}`;
    }
    return id;
  }
}
