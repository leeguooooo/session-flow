import { existsSync } from "node:fs";
import { command } from "./process";
import { resolveResult } from "./results";
import type { Run, SessionRuntime } from "./types";

export interface StepReview {
  id: string; agent: string; model?: string; status: string; actor?: string; elapsed?: string; error?: string;
  // What the worker reported. sflow checked the file and hash, not the claims inside.
  reported?: { status: unknown; summary: string; resultFile?: string; sha256?: string; artifacts?: unknown; checks?: unknown; details?: unknown };
  // What sflow saw itself in a write step's worktree.
  worktree?: { path: string; branch?: string; exists: boolean; changes?: string[]; diffStat?: string };
  session: "open" | "closed";
}
export interface RunReview { runId: string; workflow: string; status: string; steps: StepReview[]; next: string[]; note: string }

function since(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; }
async function git(cwd: string, args: string[]) {
  const r = await command(["git", "-C", cwd, ...args]).catch(() => ({ code: 1, stdout: "", stderr: "" }));
  return r.code === 0 ? r.stdout.trimEnd() : undefined;
}

// One place to accept or pick up a run: per step what was claimed, what was observed, and what is
// still open. Leaves out prompts, capability tokens and terminal transcripts.
export async function reviewRun(run: Run, runtime: SessionRuntime): Promise<RunReview> {
  const steps: StepReview[] = [];
  const next: string[] = [];
  for (const step of run.workflow.steps) {
    const s = run.steps[step.id];
    const review: StepReview = { id: step.id, agent: step.agent, ...(step.model ? { model: step.model } : {}), status: s.status,
      ...(s.actor ? { actor: s.actor } : {}), ...(s.error ? { error: s.error } : {}), session: "closed" };
    if (s.startedAt) review.elapsed = since((s.finishedAt ?? Date.now()) - s.startedAt);
    try { if (await runtime.exists(run, step.id)) review.session = "open"; } catch {}
    if (s.result) {
      let full: Record<string, unknown> = s.result;
      try { full = resolveResult(run, step.id, s.result); } catch { review.error = "result file missing or does not match its hash"; }
      review.reported = { status: full.status, summary: String(full.summary ?? ""),
        ...(typeof s.result.fullResultFile === "string" ? { resultFile: s.result.fullResultFile, sha256: String(s.result.sha256) } : {}),
        ...(full.artifacts !== undefined ? { artifacts: full.artifacts } : {}), ...(full.checks !== undefined ? { checks: full.checks } : {}),
        ...(full.details !== undefined ? { details: full.details } : {}) };
    }
    if (step.worktree && s.cwd) {
      const exists = existsSync(s.cwd);
      review.worktree = { path: s.cwd, exists, branch: `sflow/${run.id}/${step.id}` };
      if (exists) {
        const status = await git(s.cwd, ["status", "--short"]);
        review.worktree.changes = status ? status.split("\n") : [];
        const stat = await git(s.cwd, ["diff", "--stat", "HEAD"]);
        if (stat) review.worktree.diffStat = stat.split("\n").pop()!.trim();
      }
    }
    steps.push(review);
    if (["blocked", "uncertain"].includes(s.status) && review.session === "open")
      next.push(`${step.id}: look with sflow logs ${run.id} ${step.id} (or sflow status ${run.id} for a waiting prompt), then sflow resume ${run.id}`);
    else if (s.status === "uncertain")
      next.push(`${step.id}: outcome unknown and never retried automatically; check its result before starting a new run`);
    else if (["failed", "blocked"].includes(s.status) && s.result)
      next.push(`${step.id}: reported ${s.status}; that is final for this run. Start a new run to retry`);
    if (review.worktree?.exists)
      next.push(`${step.id}: worktree kept at ${review.worktree.path}; review it (git -C <path> diff), then commit/merge yourself or remove it with git worktree remove`);
  }
  return { runId: run.id, workflow: run.workflow.name, status: run.status, steps, next,
    note: "reported = what the worker claimed (sflow verified the result file and hash only); worktree = what sflow observed with git. Review the actual diff and rerun checks before accepting." };
}

export function renderReview(r: RunReview): string[] {
  const lines = [`run ${r.runId} (${r.workflow}): ${r.status}`];
  for (const s of r.steps) {
    lines.push(`  ${s.id} — ${s.agent}${s.model ? ` (${s.model})` : ""}: ${s.status}${s.elapsed ? `, ${s.elapsed}` : ""}${s.session === "open" ? ", session still open" : ""}`);
    if (s.reported) {
      lines.push(`    worker reported: ${s.reported.summary}`);
      if (s.reported.checks !== undefined) lines.push(`    checks (as reported, not rerun): ${JSON.stringify(s.reported.checks).slice(0, 300)}`);
      if (s.reported.artifacts !== undefined) lines.push(`    artifacts (as reported): ${JSON.stringify(s.reported.artifacts).slice(0, 300)}`);
      if (s.reported.resultFile) lines.push(`    full result: sflow result ${r.runId} ${s.id}`);
    }
    if (s.worktree) lines.push(`    worktree: ${s.worktree.path}${s.worktree.exists ? ` — sflow sees ${s.worktree.changes?.length ?? 0} changed file(s)${s.worktree.diffStat ? ` (${s.worktree.diffStat})` : ""}` : " (gone)"}`);
    if (s.error) lines.push(`    note: ${s.error}`);
  }
  if (r.next.length) { lines.push("  next:"); for (const n of r.next) lines.push(`    - ${n}`); }
  lines.push(`  ${r.note}`);
  return lines;
}
