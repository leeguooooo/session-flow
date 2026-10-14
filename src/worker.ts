import { timingSafeEqual } from "node:crypto";
import { loadRun } from "./store";
import { isTask, parseBody } from "./engine";
import { eventProof, validProof } from "./protocol";
import type { Transport, WorkerEvent } from "./types";
import { resolveResult, storeResult } from "./results";

function context() {
  const id = process.env.SFLOW_RUN_ID, stepId = process.env.SFLOW_STEP_ID, token = process.env.SFLOW_TOKEN;
  if (!id || !stepId || !token) throw new Error("worker commands must run through the worker path given in your Session Flow prompt (<run>/<step>/worker task, then <run>/<step>/worker report …), not through plain sflow");
  const run = loadRun(id), state = run.steps[stepId];
  if (!state || token.length !== state.token.length || !timingSafeEqual(Buffer.from(token), Buffer.from(state.token))) throw new Error("invalid worker capability");
  if (["pending", "dispatching", "cancelled"].includes(state.status)) throw new Error("step is not eligible to execute");
  const step = run.workflow.steps.find(s => s.id === stepId)!;
  return { run, state, step, stepId, token };
}
export async function workerTask(transport: Transport) {
  const { run, state, step, stepId, token } = context();
  const actor = await transport.whoami(step.agent, { runId: run.id, stepId });
  if (state.actor && actor !== state.actor) throw new Error("worker identity changed");
  const rows = await transport.read(run.channel, actor);
  const claimedElsewhere = rows.some(row => {
    const e = parseBody(row) as WorkerEvent | null;
    return e?.type === "sflow.worker" && e.runId === run.id && e.stepId !== stepId && e.status === "accepted" &&
      e.actor === actor && row.from === actor && !!run.steps[e.stepId] && validProof(e, run.steps[e.stepId].token);
  });
  if (claimedElsewhere) throw new Error("this native session already accepted another step");
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
  const { run, state, step, stepId, token } = context();
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("result must be a JSON object");
  const r = result as Record<string, unknown>;
  if (!["done", "failed", "blocked"].includes(String(r.status)) || typeof r.summary !== "string" || !r.summary.trim()) throw new Error("result needs status done/failed/blocked and a non-empty summary");
  if (Buffer.byteLength(JSON.stringify(r)) > 64 * 1024) throw new Error("report exceeds 64 KiB; use artifact paths");
  const actor = await transport.whoami(step.agent, { runId: run.id, stepId });
  if (state.actor && actor !== state.actor) throw new Error("worker identity changed");
  const rows = await transport.read(run.channel, actor);
  const events = rows.filter(row => { const e = parseBody(row) as WorkerEvent | null; return e?.type === "sflow.worker" && e.runId === run.id && e.stepId === stepId && row.from === e.actor && validProof(e, token); }).map(parseBody) as WorkerEvent[];
  if (!events.some(e => e.actor === actor && e.status === "accepted")) throw new Error("task was not accepted by this worker");
  const old = events.find(e => ["done", "failed", "blocked"].includes(e.status));
  if (old) {
    if (JSON.stringify(resolveResult(run, stepId, old.result!)) === JSON.stringify(r) && old.actor === actor) return { reported: true, alreadyReported: true };
    throw new Error("terminal report already exists; refusing to overwrite");
  }
  // A running 0.1.0 driver expects inline results. Upgrading the helper must not
  // change its wire semantics; only new v2 runs use file-backed reports.
  const resultRef = run.version >= 2 ? storeResult(run, stepId, r) : r;
  const e: Omit<WorkerEvent, "proof"> = { type: "sflow.worker", version: 1, runId: run.id, stepId, actor, status: r.status as WorkerEvent["status"], result: resultRef };
  await transport.send(run.channel, { ...e, proof: eventProof(e, token) }, actor);
  return { reported: true };
}
