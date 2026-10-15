import { sessionRoot } from "./config";
import { beginObservation, endObservation } from "./workspace";
import { saveRun } from "./store";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { buildTask, prefixGroup } from "./context";
import { resolveResult, resultFile } from "./results";
import { nativeActor, validProof } from "./protocol";
import type { Run, SessionRuntime, Step, Transport, TaskEvent, Message, WorkerEvent } from "./types";

const active = new Set(["dispatching", "launching", "starting", "running"]);
const terminal = new Set(["done", "failed", "blocked", "uncertain", "cancelled", "skipped"]);
// A skipped step (its when did not hold) counts as finished for whatever comes after it.
const finished = (status: string) => status === "done" || status === "skipped";
export function field(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>)[k] : undefined, value);
}
// The result a when/expect looks at: the full report, or { status: "skipped" } for a skipped step.
function outcome(run: Run, id: string): Record<string, unknown> {
  const s = run.steps[id];
  return s.status === "skipped" ? { status: "skipped" } : { ...resolveResult(run, id, s.result!), status: s.status };
}
// Undecidable (a field the report left out) is not "false": the step stops for a person.
export function decideWhen(run: Run, step: Step): { run: boolean } | { error: string } {
  for (const [dep, want] of Object.entries(step.when ?? {})) {
    const got = outcome(run, dep);
    for (const [path, value] of Object.entries(want)) {
      const actual = field(got, path);
      if (actual === undefined && got.status !== "skipped") return { error: `${dep} reported no ${path}; cannot decide whether ${step.id} runs` };
      if (actual !== value) return { run: false };
    }
  }
  return { run: true };
}
export function parseBody(row: Message): unknown {
  try { return JSON.parse(row.body); } catch { return null; }
}
export function isTask(value: unknown, run: Run, stepId: string): value is TaskEvent {
  const e = value as TaskEvent | null;
  return !!e && e.type === "sflow.task" && e.version === 1 && e.runId === run.id && e.stepId === stepId;
}
// A step placed on another host reports only through that host's channel (sequence numbers are per machine).
function fromItsHost(run: Run, row: Message, stepId: string): boolean {
  const state = run.steps[stepId], step = run.workflow.steps.find(s => s.id === stepId);
  const remote = !!state?.host && state.host !== "local" && step?.agent !== "command";
  return remote ? row.host === state.host : row.host === undefined;
}
export function reconcile(run: Run, rows: Message[]) {
  for (const row of [...rows].sort((a, b) => a.seq - b.seq)) {
    const e = parseBody(row) as WorkerEvent | null;
    if (!e || e.type !== "sflow.worker" || e.version !== 1 || e.runId !== run.id) continue;
    const state = run.steps[e.stepId];
    const agent = run.workflow.steps.find(s => s.id === e.stepId)?.agent;
    // Command steps have no worker; sflow records their receipt itself.
    if (!state || agent === "command" || !fromItsHost(run, row, e.stepId) || !validProof(e, state.token) || row.from !== e.actor ||
      !nativeActor(e.actor, agent, { runId: run.id, stepId: e.stepId })) continue;
    if (state.actor && state.actor !== e.actor) continue;
    const definition = run.workflow.steps.find(s => s.id === e.stepId)!;
    if (definition.reuseSession && (run.steps[definition.reuseSession].status !== "done" || run.steps[definition.reuseSession].actor !== e.actor)) continue;
    // Only workers that this driver actually tried to create can report.
    if (["pending", "dispatching", "cancelled", "skipped"].includes(state.status)) continue;
    if (e.status === "accepted") {
      if (["done", "failed", "blocked"].includes(state.status) && state.result) continue;
      state.actor = e.actor; state.status = "running"; state.lifecycle = "active"; delete state.error;
      state.acceptedAt ??= row.ts && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : Date.now();
    } else if (["done", "failed", "blocked"].includes(e.status)) {
      if (!state.actor || !e.result || typeof e.result !== "object" || Array.isArray(e.result)) continue;
      if (["done", "failed", "blocked"].includes(state.status) && state.result) continue;
      let result: Record<string, unknown>;
      // A remote report names the host's file; the driver checks and keeps its own copy.
      if (row.host && typeof e.result.fullResultFile === "string" && typeof e.result.sha256 === "string") e.result = { ...e.result, fullResultFile: resultFile(run, e.stepId, e.result.sha256) };
      try { result = resolveResult(run, e.stepId, e.result); } catch {
        state.status = "blocked"; state.error = "terminal report evidence missing or corrupted; inspect result file/hash"; continue;
      }
      state.status = e.status; state.result = e.result.fullResultFile ? e.result : result; delete state.error;
      state.finishedAt ??= row.ts && Number.isFinite(Date.parse(row.ts)) ? Date.parse(row.ts) : Date.now();
      const expect = run.workflow.steps.find(s => s.id === e.stepId)?.expect;
      const miss = e.status === "done" && expect ? Object.entries(expect).find(([path, value]) => field(result, path) !== value) : undefined;
      if (miss) { state.status = "blocked"; state.error = `reported ${miss[0]} = ${JSON.stringify(field(result, miss[0]) ?? null)}, expected ${JSON.stringify(miss[1])}; over to you`; }
    }
  }
}
// concurrency counts native sessions (one per reuse chain, live or retained) and running command jobs together.
function commandsRunning(run: Run): number {
  return run.workflow.steps.filter(x => x.agent === "command" && (active.has(run.steps[x.id].status) || (run.steps[x.id].status === "uncertain" && run.steps[x.id].job))).length;
}
function live(run: Run): number {
  const sessions = new Set(run.workflow.steps.filter(x => x.agent !== "command" &&
    (active.has(run.steps[x.id].status) || ["active", "retained"].includes(run.steps[x.id].lifecycle ?? ""))).map(x => sessionRoot(run.workflow.steps, x)));
  return sessions.size + commandsRunning(run);
}
export async function tick(run: Run, runtime: SessionRuntime, transport: Transport) {
  if (existsSync(join(run.dir, "cancel.request"))) {
    for (const step of run.workflow.steps) {
      await runtime.stop(run, step.id); run.steps[step.id].lifecycle = "closed";
      if (!finished(run.steps[step.id].status)) run.steps[step.id].status = "cancelled";
    }
    run.status = "cancelled"; saveRun(run); return;
  }
  const sender = `sflow-${run.id}`;
  const rows = await transport.read(run.channel, sender);
  if (runtime.remoteRows) {
    // An unreachable host leaves its steps as they are; its reports are read on a later tick.
    try { rows.push(...await runtime.remoteRows(run)); } catch {}
  }
  reconcile(run, rows); saveRun(run);
  for (const step of run.workflow.steps) {
    try { await endObservation(run, step); }
    catch (e) { run.steps[step.id].status = "blocked"; run.steps[step.id].error = `workspace observation failed: ${String(e)}`; }
    try { await runtime.materialize?.(run, step); }
    catch (e) { run.steps[step.id].status = "blocked"; run.steps[step.id].error = `bringing the remote worktree back failed: ${String(e)}`; }
    if (step.agent === "command" && run.steps[step.id].job && ["running"].includes(run.steps[step.id].status)) await runtime.pollCommand?.(run, step);
  }
  saveRun(run);
  for (const step of run.workflow.steps) {
    const s = run.steps[step.id];
    if (s.status === "blocked" && s.error === "dependency did not complete successfully" && step.dependsOn.every(id => finished(run.steps[id].status))) {
      s.status = "pending"; delete s.error; saveRun(run);
    }
    if (step.agent === "command") {
      // A command job left mid-start is asked again by its job id; the host never starts it twice.
      if (s.status === "launching" && s.job && s.job.phase !== "placing" && runtime.startCommand) {
        const r = await runtime.startCommand(run, step);
        if ("error" in r && s.status === "launching") { s.status = "blocked"; s.error = r.error; }
        saveRun(run);
      }
      continue;
    }
    if (s.status === "launching" || (s.status === "uncertain" && s.uncertainty === "launch")) {
      // Crash between creating the process and recording success: adopting the
      // one exact owned tmux session is safe; creating another is not.
      if (step.reuseSession) {
        s.status = "uncertain"; s.uncertainty = "launch"; s.error = "continuation delivery unknown; wait for signed acceptance, no automatic resend";
      } else if (await runtime.exists(run, step.id)) { s.status = "starting"; delete s.uncertainty; delete s.error; }
      else { s.status = "uncertain"; s.uncertainty = "launch"; s.error = "creation outcome unknown; no automatic recreation"; }
      saveRun(run);
    }
    if (s.status === "dispatching" || (s.status === "uncertain" && s.uncertainty === "dispatch")) {
      const assignments = rows.filter(r => r.from === sender && isTask(parseBody(r), run, step.id) && fromItsHost(run, r, step.id));
      if (assignments.length === 1) {
        // Assignment is committed, but a crash may have occurred before launch.
        // No launch was attempted until status=launching was durable.
        s.status = "pending"; delete s.uncertainty; delete s.error;
      } else { s.status = "uncertain"; s.error = "assignment outcome unknown; no automatic resend"; }
      saveRun(run);
    }
    if (["starting", "running"].includes(s.status)) {
      // A prompt the user is still answering keeps readiness open, and readiness restarts once
      // it is answered; the step timeout still bounds the whole wait.
      if (s.status === "starting" && await runtime.waitingOnPrompt?.(run, step.id)) { s.promptAt = Date.now(); saveRun(run); }
      const readyFrom = Math.max(s.startedAt ?? Date.now(), s.promptAt ?? 0);
      if (Date.now() - (s.startedAt ?? Date.now()) > step.timeoutSeconds * 1000) {
        s.status = "blocked"; s.error = "step timed out; worker retained for inspection"; saveRun(run);
      } else if (s.status === "starting" && Date.now() - readyFrom > step.readyTimeoutSeconds * 1000) {
        const seen = await runtime.diagnose?.(run, step.id);
        s.status = "blocked";
        s.error = `no acceptance within ${step.readyTimeoutSeconds}s; ${seen ? `the worker screen shows: ${seen}` : "cause unknown (no prompt or error recognised on screen)"}; inspect with sflow logs ${run.id} ${step.id}`;
        saveRun(run);
      } else if (!await runtime.exists(run, step.id)) {
        s.status = "uncertain"; s.uncertainty = "worker"; s.error = "worker exited without an explicit completion report"; saveRun(run);
      }
    }
  }
  for (const step of run.workflow.steps) {
    const s = run.steps[step.id];
    if (s.status !== "pending") continue;
    if (step.dependsOn.some(id => terminal.has(run.steps[id].status) && !finished(run.steps[id].status))) {
      s.status = "blocked"; s.error = "dependency did not complete successfully"; saveRun(run); continue;
    }
    if (!step.dependsOn.every(id => finished(run.steps[id].status))) continue;
    if (step.when) {
      let decision: ReturnType<typeof decideWhen>;
      try { decision = decideWhen(run, step); } catch (e) { decision = { error: `dependency evidence unavailable: ${String(e)}` }; }
      if ("error" in decision) { s.status = "blocked"; s.error = decision.error; saveRun(run); continue; }
      if (!decision.run) { s.status = "skipped"; s.finishedAt = Date.now(); saveRun(run); continue; }
    }
    if (step.agent === "command") {
      if (live(run) >= run.workflow.concurrency) continue;
      if (!runtime.startCommand) { s.status = "blocked"; s.error = "this runtime cannot run command steps"; saveRun(run); continue; }
      s.status = "launching"; s.startedAt ??= Date.now(); saveRun(run);
      let r: Awaited<ReturnType<NonNullable<SessionRuntime["startCommand"]>>>;
      try { r = await runtime.startCommand(run, step); } catch (e) { r = { error: (e as Error).message }; }
      if ("wait" in r) { s.status = "pending"; delete s.startedAt; s.error = `waiting for a host: ${r.wait}`; }
      else if ("error" in r && s.status === "launching") { s.status = "blocked"; s.error = r.error; }
      saveRun(run); continue;
    }
    const group = prefixGroup(step);
    // Let the first matching worker begin its response before a sibling is
    // launched. This only enables compatible caching; it never claims a hit.
    if (group && Object.values(run.steps).some(other => other.prefixGroup === group && other.status === "starting" && Date.now() - (other.startedAt ?? 0) < (run.workflow.prefixWarmupMs ?? 0))) continue;
    // Stop only a whole worker group with no active or possible future round.
    const groups = new Map<string, Step[]>();
    for (const member of run.workflow.steps) {
      const root = sessionRoot(run.workflow.steps, member);
      groups.set(root, [...(groups.get(root) ?? []), member]);
    }
    let occupied = 0;
    for (const members of groups.values()) {
      const owner = members.find(m => run.steps[m.id].lifecycle === "active") ?? members[0];
      const live = await runtime.exists(run, owner.id);
      const needsLater = members.some(m => run.steps[m.id].status === "pending");
      const busy = members.some(m => active.has(run.steps[m.id].status) || ["blocked", "uncertain", "failed"].includes(run.steps[m.id].status));
      if (live && !busy && !needsLater) {
        await runtime.stop(run, owner.id);
        for (const m of members) run.steps[m.id].lifecycle = "closed";
      } else if (live) {
        occupied++;
        if (!busy) for (const m of members.filter(m => finished(run.steps[m.id].status))) run.steps[m.id].lifecycle = "retained";
      }
    }
    if (!step.reuseSession && occupied + commandsRunning(run) >= run.workflow.concurrency) {
      if (!Object.values(run.steps).some(s => active.has(s.status))) {
        s.status = "blocked"; s.error = "retained/blocked workers fill concurrency slots; inspect them and use higher concurrency in a new workflow"; saveRun(run);
      }
      continue;
    }
    if (step.reuseSession && run.steps[step.reuseSession].status !== "done") {
      s.status = "blocked"; s.error = "reuseSession ancestor did not report done; no continuation"; saveRun(run); continue;
    }
    // Placement first: a continuation inherits its chain's host, where its retained worker lives.
    if (step.host && !s.remote) {
      if (!runtime.placeAgent) { s.status = "blocked"; s.error = "this runtime cannot place steps on hosts"; saveRun(run); continue; }
      let r: Awaited<ReturnType<NonNullable<SessionRuntime["placeAgent"]>>>;
      try { r = await runtime.placeAgent(run, step); } catch (e) { r = { error: (e as Error).message }; }
      if ("wait" in r) { s.error = `waiting for a host: ${r.wait}`; saveRun(run); continue; }
      if ("error" in r) { s.status = "blocked"; s.error = r.error; saveRun(run); continue; }
      delete s.error; saveRun(run);
    }
    if (step.reuseSession && (!runtime.continue || !await runtime.exists(run, step.id))) {
      s.status = "uncertain"; s.uncertainty = "worker"; s.error = "retained worker unavailable; no automatic recreation"; saveRun(run); continue;
    }
    try { await beginObservation(run, step); } catch (e) {
      s.status = "blocked"; s.error = `workspace observation failed: ${String(e)}`; saveRun(run); continue;
    }
    const assignments = rows.filter(r => r.from === sender && isTask(parseBody(r), run, step.id) && fromItsHost(run, r, step.id));
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
      try { if (runtime.remoteStep?.(run, step.id)) await runtime.sendTask!(run, step, task); else await transport.send(run.channel, task, sender); }
      catch (e) { s.status = "uncertain"; s.uncertainty = "dispatch"; s.error = String(e); saveRun(run); continue; }
    }
    s.status = "launching"; s.startedAt = Date.now(); s.prefixGroup = group; saveRun(run);
    try {
      if (step.reuseSession) await runtime.continue!(run, step); else await runtime.create(run, step);
      s.status = "starting"; s.lifecycle = "active";
    }
    catch (e) { s.status = "uncertain"; s.uncertainty = "launch"; s.error = String(e); }
    saveRun(run);
  }
  if (Object.values(run.steps).every(s => finished(s.status))) {
    run.status = "done";
    for (const step of run.workflow.steps) { await runtime.stop(run, step.id); run.steps[step.id].lifecycle = "closed"; }
    await runtime.finish?.(run);
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
