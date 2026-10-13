import { createHmac, timingSafeEqual } from "node:crypto";
import type { WorkerEvent } from "./types";

export function eventProof(event: Omit<WorkerEvent, "proof">, token: string): string {
  const body = JSON.stringify({ type: event.type, version: event.version, runId: event.runId,
    stepId: event.stepId, actor: event.actor, status: event.status, ...(event.result ? { result: event.result } : {}) });
  return createHmac("sha256", token).update(body).digest("hex");
}
export function validProof(event: WorkerEvent, token: string): boolean {
  if (typeof event.proof !== "string" || !/^[0-9a-f]{64}$/.test(event.proof)) return false;
  return timingSafeEqual(Buffer.from(event.proof, "hex"), Buffer.from(eventProof(event, token), "hex"));
}
export function nativeActor(actor: string): boolean {
  return /^claude-[0-9a-f]{8}$/.test(actor) || /^codex-[0-9a-f]{8}(?:-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})?$/.test(actor);
}
