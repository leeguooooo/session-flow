import { timingSafeEqual } from "node:crypto";
import { loadRun } from "./store";
import { isTask, parseBody } from "./engine";
import { eventProof, validProof } from "./protocol";
import type { Transport, WorkerEvent } from "./types";

function context() {
  const id = process.env.SFLOW_RUN_ID, stepId = process.env.SFLOW_STEP_ID, token = process.env.SFLOW_TOKEN;
  if (!id || !stepId || !token) throw new Error("worker commands must run in a Session Flow worker");
  const run = loadRun(id), state = run.steps[stepId];
  if (!state || token.length !== state.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(state.token))) throw new Error("invalid worker capability");
  if (["pending", "dispatching", "cancelled"].includes(state.status)) throw new Error("step is not eligible to execute");
  return { run, state, stepId, token };
}
export async function workerTask(transport: Transport) {
  const { run, state, stepId, token } = context();
  const actor = await transport.whoami();
  if (state.actor && actor !== state.actor) throw new Error("worker identity changed");
  const rows = await transport.read(run.channel, actor);
  const tasks = rows.filter(r => r.from === `sflow-${run.id}` && isTask(parseBody(r), run, stepId));
  if (tasks.length !== 1) throw new Error("expected one committed OCS assignment");
  const events = rows.filter(row => { const e = parseBody(row) as WorkerEvent | null; return e?.type === "sflow.worker" && e.runId === run.id && e.stepId === stepId && row.from === e.actor && validProof(e, token); }).map(parseBody) as WorkerEvent[];
  if (events.some(e => ["done", "failed", "blocked"].includes(e.status))) throw new Error("task already has a terminal report; do not execute it again");
  if (!events.some(e => e.actor === actor && e.status === "accepted")) {
    const e: Omit<WorkerEvent, "proof"> = { type: "sflow.worker", version: 1, runId: run.id, stepId, actor, status: "accepted" };
    await transport.send(run.channel, { ...e, proof: eventProof(e, token) }, actor);
  }
  return parseBody(tasks[0]);
}
export async function workerReport(transport: Transport, result: unknown) {
  const { run, state, stepId, token } = context();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("result must be a JSON object");
  const r = result as Record<string, unknown>;
  if (!["done", "failed", "blocked"].includes(String(r.status)) || typeof r.summary !== "string" || !r.summary.trim()) throw new Error("result needs status done/failed/blocked and a non-empty summary");
  if (Buffer.byteLength(JSON.stringify(r)) > 64 * 1024) throw new Error("report exceeds 64 KiB; use artifact paths");
  const actor = await transport.whoami();
  if (state.actor && actor !== state.actor) throw new Error("worker identity changed");
  const rows = await transport.read(run.channel, actor);
  const events = rows.filter(row => { const e = parseBody(row) as WorkerEvent | null; return e?.type === "sflow.worker" && e.runId === run.id && e.stepId === stepId && row.from === e.actor && validProof(e, token); }).map(parseBody) as WorkerEvent[];
  if (!events.some(e => e.actor === actor && e.status === "accepted")) throw new Error("task was not accepted by this worker");
  const old = events.find(e => ["done", "failed", "blocked"].includes(e.status));
  if (old) {
    if (JSON.stringify(old.result) === JSON.stringify(r) && old.actor === actor) return { reported: true, alreadyReported: true };
    throw new Error("terminal report already exists; refusing to overwrite");
  }
  const e: Omit<WorkerEvent, "proof"> = { type: "sflow.worker", version: 1, runId: run.id, stepId, actor, status: r.status as WorkerEvent["status"], result: r };
  await transport.send(run.channel, { ...e, proof: eventProof(e, token) }, actor);
  return { reported: true };
}
