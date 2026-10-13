import { saveRun } from "./store";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildTask, prefixGroup } from "./context";
import { resolveResult } from "./results";
import { nativeActor, validProof } from "./protocol";
import type { Run, SessionRuntime, Transport, TaskEvent, Message, WorkerEvent } from "./types";

const active = new Set(["dispatching", "launching", "starting", "running"]);
const terminal = new Set(["done", "failed", "blocked", "uncertain", "cancelled"]);
export function parseBody(row: Message): unknown {
  try { return JSON.parse(row.body); } catch { return null; }
}
export function isTask(value: unknown, run: Run, stepId: string): value is TaskEvent {
  const e = value as TaskEvent | null;
  return !!e && e.type === "sflow.task" && e.version === 1 && e.runId === run.id && e.stepId === stepId;
}
export function reconcile(run: Run, rows: Message[]) {
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const e = parseBody(row) as WorkerEvent | null;
    if (!e || e.type !== "sflow.worker" || e.version !== 1 || e.runId !== run.id) continue;
    const state = run.steps[e.stepId];
    if (!state || !validProof(e, state.token) || row.from !== e.actor || !nativeActor(e.actor)) continue;
    if (state.actor && state.actor !== e.actor) continue;
    // Only workers that this driver actually tried to create can report.
    if (["pending", "dispatching", "cancelled"].includes(state.status)) continue;
    if (e.status === "accepted") {
      if (["done", "failed", "blocked"].includes(state.status) && state.result) continue;
      state.actor = e.actor; state.status = "running"; delete state.error;
      state.acceptedAt ??= row.ts && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : Date.now();
    } else if (["done", "failed", "blocked"].includes(e.status)) {
      if (!state.actor || !e.result || typeof e.result !== "object" || Array.isArray(e.result)) continue;
      if (["done", "failed", "blocked"].includes(state.status) && state.result) continue;
      let result: Record<string, unknown>;
      try { result = resolveResult(run, e.stepId, e.result); } catch {
        state.status = "blocked"; state.error = "terminal report evidence missing or corrupted; inspect result file/hash"; continue;
      }
      state.status = e.status; state.result = e.result.fullResultFile ? e.result : result; delete state.error;
      state.finishedAt ??= row.ts && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : Date.now();
    }
  }
}
export async function tick(run: Run, runtime: SessionRuntime, transport: Transport) {
  if (existsSync(join(run.dir, "cancel.request"))) {
    for (const step of run.workflow.steps) {
      await runtime.stop(run, step.id);
      if (run.steps[step.id].status !== "done") run.steps[step.id].status = "cancelled";
    }
    run.status = "cancelled"; saveRun(run); return;
  }
  const sender = `sflow-${run.id}`;
  const rows = await transport.read(run.channel, sender);
  reconcile(run, rows); saveRun(run);
  for (const step of run.workflow.steps) {
    const s = run.steps[step.id];
    if (s.status === "blocked" && s.error === "dependency did not complete successfully" && step.dependsOn.every(id => run.steps[id].status === "done")) {
      s.status = "pending"; delete s.error; saveRun(run);
    }
    if (s.status === "launching" || (s.status === "uncertain" && s.uncertainty === "launch")) {
      // Crash between creating the process and recording success: adopting the
      // one exact owned tmux session is safe; creating another is not.
      if (await runtime.exists(run, step.id)) { s.status = "starting"; delete s.uncertainty; delete s.error; }
      else { s.status = "uncertain"; s.uncertainty = "launch"; s.error = "creation outcome unknown; no automatic recreation"; }
      saveRun(run);
    }
    if (s.status === "dispatching" || (s.status === "uncertain" && s.uncertainty === "dispatch")) {
      const assignments = rows.filter(r => r.from === sender && isTask(parseBody(r), run, step.id));
      if (assignments.length === 1) {
        // Assignment is committed, but a crash may have occurred before launch.
        // No launch was attempted until status=launching was durable.
        s.status = "pending"; delete s.uncertainty; delete s.error;
      } else { s.status = "uncertain"; s.error = "assignment outcome unknown; no automatic resend"; }
      saveRun(run);
    }
    if (["starting", "running"].includes(s.status)) {
      if (s.status === "starting" && Date.now() - (s.startedAt ?? Date.now()) > step.readyTimeoutSeconds * 1000) {
        s.status = "blocked"; s.error = `no acceptance yet; inspect with sflow attach ${run.id} ${step.id} (trust/permission/login prompts need human input)`; saveRun(run);
      } else if (Date.now() - (s.startedAt ?? Date.now()) > step.timeoutSeconds * 1000) {
        s.status = "blocked"; s.error = "step timed out; worker retained for inspection"; saveRun(run);
      } else if (!await runtime.exists(run, step.id)) {
        s.status = "uncertain"; s.uncertainty = "worker"; s.error = "worker exited without an explicit completion report"; saveRun(run);
      }
    }
  }
  for (const step of run.workflow.steps) {
    const s = run.steps[step.id];
    if (s.status !== "pending") continue;
    if (step.dependsOn.some(id => terminal.has(run.steps[id].status) && run.steps[id].status !== "done")) {
      s.status = "blocked"; s.error = "dependency did not complete successfully"; saveRun(run); continue;
    }
    if (!step.dependsOn.every(id => run.steps[id].status === "done")) continue;
    const group = prefixGroup(step);
    // Let the first matching worker begin its response before a sibling is
    // launched. This only enables compatible caching; it never claims a hit.
    if (group && Object.values(run.steps).some(other => other.prefixGroup === group && other.status === "starting" && Date.now() - (other.startedAt ?? 0) < (run.workflow.prefixWarmupMs ?? 0))) continue;
    let occupied = Object.values(run.steps).filter(s => active.has(s.status)).length;
    for (const other of run.workflow.steps) {
      if (["blocked", "uncertain", "failed"].includes(run.steps[other.id].status) && await runtime.exists(run, other.id)) occupied++;
    }
    if (occupied >= run.workflow.concurrency) break;
    // Completed steps keep their TUI alive for inspection, so stop those owned
    // processes before launching more: the cap applies to actual workers too.
    for (const prev of run.workflow.steps) if (run.steps[prev.id].status === "done") await runtime.stop(run, prev.id);
    const assignments = rows.filter(r => r.from === sender && isTask(parseBody(r), run, step.id));
    if (assignments.length > 1) { s.status = "uncertain"; s.error = "duplicate assignments found"; saveRun(run); continue; }
    if (!assignments.length) {
      s.status = "dispatching"; saveRun(run);
      let task: TaskEvent;
      try { task = buildTask(run, step); } catch (e) {
        s.status = "blocked"; s.error = `dependency evidence unavailable: ${String(e)}`; saveRun(run); continue;
      }
      if (Buffer.byteLength(JSON.stringify(task)) > 99000) {
        s.status = "failed"; s.error = "assignment exceeds OCS message limit; shorten prompt or dependency fan-in"; saveRun(run); continue;
      }
      try { await transport.send(run.channel, task, sender); }
      catch (e) { s.status = "uncertain"; s.uncertainty = "dispatch"; s.error = String(e); saveRun(run); continue; }
    }
    s.status = "launching"; s.startedAt = Date.now(); s.prefixGroup = group; saveRun(run);
    try { await runtime.create(run, step); s.status = "starting"; }
    catch (e) { s.status = "uncertain"; s.uncertainty = "launch"; s.error = String(e); }
    saveRun(run);
  }
  if (Object.values(run.steps).every(s => s.status === "done")) {
    run.status = "done";
    for (const step of run.workflow.steps) await runtime.stop(run, step.id);
  } else if (!Object.values(run.steps).some(s => active.has(s.status))) run.status = "blocked";
  saveRun(run);
}
export async function drive(run: Run, runtime: SessionRuntime, transport: Transport, intervalMs = 1000) {
  while (run.status === "running") {
    await tick(run, runtime, transport);
    if (run.status === "running") await Bun.sleep(intervalMs);
  }
  return run;
}
