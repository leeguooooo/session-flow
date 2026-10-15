import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Run, Step, TaskEvent } from "./types";
import { workspaceRoot } from "./config";
import { resolveResult } from "./results";

export const INLINE_RESULT_BYTES = 1024;
export const DEPENDENCY_CONTEXT_BYTES = 4096;
export const SUMMARY_BYTES = 384;
export function prefixGroup(step: Step): string | undefined {
  if (step.policy !== "read-only") return undefined;
  return createHash("sha256").update(JSON.stringify([step.agent, step.model ?? "configured-default", step.policy])).digest("hex").slice(0, 12);
}
function preview(text: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= SUMMARY_BYTES) return text;
  let end = SUMMARY_BYTES; while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString("utf8") + "…";
}
export function resultReference(run: Run, id: string) {
  const stored = run.steps[id].result;
  if (!stored) throw new Error(`missing result: ${id}`);
  const result = resolveResult(run, id, stored);
  if (stored.fullResultFile) return { status: result.status, summary: preview(String(result.summary ?? "")),
    resultFile: stored.fullResultFile, sha256: stored.sha256, bytes: stored.bytes };
  const body = JSON.stringify(result) + "\n", path = join(run.dir, `${id}-result.json`);
  writeFileSync(path, body, { mode: 0o600 });
  return { status: result.status ?? run.steps[id].status, summary: preview(String(result.summary ?? "")),
    resultFile: path, sha256: createHash("sha256").update(body).digest("hex"), bytes: Buffer.byteLength(body) };
}
export function buildTask(run: Run, step: Step): TaskEvent {
  const dependencies: Record<string, Record<string, unknown>> = {};
  // A skipped dependency never ran; the worker sees that instead of a result.
  const depResult = (id: string) => run.steps[id].status === "skipped" ? { status: "skipped" } : resolveResult(run, id, run.steps[id].result!);
  for (const id of step.dependsOn) {
    const result = depResult(id);
    dependencies[id] = Buffer.byteLength(JSON.stringify(result)) <= INLINE_RESULT_BYTES ? result : resultReference(run, id);
  }
  const task: TaskEvent = { type: "sflow.task", version: 1, runId: run.id, stepId: step.id, prompt: step.prompt,
    workspace: stepWorkspace(run, step), dependencies };
  if (run.steps[step.id].baseline) task.workspaceObservation = {
    baseline: run.steps[step.id].baseline!,
    dependencies: Object.fromEntries(step.dependsOn.filter(id => run.steps[id].baseline).map(id => [id,
      { baseline: run.steps[id].baseline!, ...(run.steps[id].observedEnd ? { end: run.steps[id].observedEnd } : {}) }])),
    warning: "Existing user edits are in the baseline. Compare dependency before/after snapshots, not git diff HEAD, to attribute this workflow's changes. Outside writes during a write step cannot be distinguished; ignored files are excluded."
  };
  if (Buffer.byteLength(JSON.stringify(dependencies)) > DEPENDENCY_CONTEXT_BYTES) {
    const manifest = Object.fromEntries(step.dependsOn.map(id => [id, run.steps[id].status === "skipped" ? { status: "skipped" } : resultReference(run, id)]));
    const body = JSON.stringify(manifest) + "\n", path = join(run.dir, `${step.id}-dependencies.json`);
    writeFileSync(path, body, { mode: 0o600 });
    task.dependencies = {};
    task.dependencyManifest = { path, sha256: createHash("sha256").update(body).digest("hex"), count: step.dependsOn.length };
  }
  const state = run.steps[step.id];
  state.contextBytes = Buffer.byteLength(JSON.stringify(task));
  state.dependencyBytes = Buffer.byteLength(JSON.stringify(task.dependencies)) + (task.dependencyManifest ? Buffer.byteLength(JSON.stringify(task.dependencyManifest)) : 0);
  state.fullDependencyBytes = Buffer.byteLength(JSON.stringify(Object.fromEntries(step.dependsOn.map(id => [id, depResult(id)]))));
  return task;
}

// Where a step works: its own new worktree, an earlier step's worktree, or its cwd.
export function stepWorkspace(run: Run, step: Step): string {
  if (step.policy !== "workspace-write") return step.cwd;
  const root = run.workflow.steps.find(s => s.id === workspaceRoot(run.workflow.steps, step))!;
  return root.inPlace ? root.cwd : join(run.dir, root.id, "worktree");
}
