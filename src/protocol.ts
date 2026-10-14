import { createHmac, timingSafeEqual } from "node:crypto";
import type { Agent, WorkerEvent } from "./types";

export function eventProof(event: Omit<WorkerEvent, "proof">, token: string): string {
  const body = JSON.stringify({ type: event.type, version: event.version, runId: event.runId,
    stepId: event.stepId, actor: event.actor, status: event.status, ...(event.result ? { result: event.result } : {}) });
  return createHmac("sha256", token).update(body).digest("hex");
}
export function validProof(event: WorkerEvent, token: string): boolean {
  if (typeof event.proof !== "string" || !/^[0-9a-f]{64}$/.test(event.proof)) return false;
  return timingSafeEqual(Buffer.from(event.proof, "hex"), Buffer.from(eventProof(event, token), "hex"));
}
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
// An actor must look like the native session of the step's agent. agy has no per-session
// identity, so its actor is the fixed name bound to this run and step.
export function nativeActor(actor: string, agent?: Agent, scope?: { runId: string; stepId: string }): boolean {
  const kind = /^claude-[0-9a-f]{8}$/.test(actor) ? "claude"
    : new RegExp(`^codex-[0-9a-f]{8}(?:${UUID.slice(11)})?$`).test(actor) ? "codex"
    : new RegExp(`^pi-${UUID}$`).test(actor) ? "pi"
    : /^agy-[0-9a-f]{8}-[a-z][a-z0-9-]{0,39}$/.test(actor) ? "agy" : null;
  if (kind === null || (agent !== undefined && kind !== agent)) return false;
  return kind !== "agy" || (scope !== undefined && actor === `agy-${scope.runId.slice(0, 8)}-${scope.stepId}`);
}
