import { isAbsolute, resolve } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import type { Step, Workflow } from "./types";

const ID = /^[a-z][a-z0-9-]{0,39}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
function integer(value: unknown, fallback: number, min: number, max: number): number {
  const v = value ?? fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw new Error(`expected integer ${min}..${max}`);
  return v;
}
export function parseWorkflow(value: unknown, base: string): Workflow {
  const o = object(value);
  if (o.version !== 1) throw new Error("workflow version must be 1");
  if (typeof o.name !== "string" || !ID.test(o.name)) throw new Error("invalid workflow name");
  if (!Array.isArray(o.steps) || !o.steps.length || o.steps.length > 100) throw new Error("expected 1..100 steps");
  const steps: Step[] = o.steps.map((value) => {
    const s = object(value);
    if (typeof s.id !== "string" || !ID.test(s.id)) throw new Error("invalid step id");
    if (s.agent !== "claude" && s.agent !== "codex") throw new Error(`${s.id}: agent must be claude or codex`);
    if (typeof s.prompt !== "string" || !s.prompt.trim() || Buffer.byteLength(s.prompt) > 64 * 1024) throw new Error(`${s.id}: invalid prompt`);
    if (s.model !== undefined && (typeof s.model !== "string" || !s.model.trim() || s.model.startsWith("-"))) throw new Error(`${s.id}: invalid model`);
    if (typeof s.cwd !== "string" || !s.cwd) throw new Error(`${s.id}: cwd is required`);
    const cwd = isAbsolute(s.cwd) ? s.cwd : resolve(base, s.cwd);
    if (!statSync(cwd).isDirectory()) throw new Error(`${s.id}: cwd is not a directory`);
    const deps = s.dependsOn ?? [];
    if (!Array.isArray(deps) || deps.some(d => typeof d !== "string")) throw new Error(`${s.id}: invalid dependsOn`);
    if (new Set(deps).size !== deps.length) throw new Error(`${s.id}: duplicate dependency`);
    const policy = s.policy ?? "read-only";
    if (policy !== "read-only" && policy !== "workspace-write") throw new Error(`${s.id}: unsupported policy`);
    if (s.worktree !== undefined && typeof s.worktree !== "boolean") throw new Error(`${s.id}: worktree must be boolean`);
    if (policy === "workspace-write" && !s.worktree) throw new Error(`${s.id}: write steps require worktree: true`);
    if (policy === "read-only" && s.worktree) throw new Error(`${s.id}: worktree is only for write steps`);
    if (policy === "read-only") {
      const project = realpathSync(cwd);
      for (const path of [process.env.SFLOW_HOME ?? resolve(homedir(), ".local/state/session-flow"), process.env.OCS_HOME ?? resolve(homedir(), ".ocs")]) {
        let root = resolve(path); try { root = realpathSync(root); } catch {}
        if (project === root || project.startsWith(root + "/") || root.startsWith(project + "/")) throw new Error(`${s.id}: read-only project overlaps protocol write roots`);
      }
    }
    return { id: s.id, agent: s.agent, model: s.model as string | undefined, prompt: s.prompt, cwd,
      dependsOn: deps as string[], policy, worktree: s.worktree as boolean | undefined,
      timeoutSeconds: integer(s.timeoutSeconds, 1800, 10, 86400),
      readyTimeoutSeconds: integer(s.readyTimeoutSeconds, 90, 5, 600) };
  });
  const byId = new Map(steps.map(s => [s.id, s]));
  if (byId.size !== steps.length) throw new Error("duplicate step id");
  const visited = new Set<string>(), visiting = new Set<string>();
  function visit(id: string) {
    if (visiting.has(id)) throw new Error("dependency cycle");
    if (visited.has(id)) return;
    const step = byId.get(id);
    if (!step) throw new Error(`unknown dependency: ${id}`);
    visiting.add(id); step.dependsOn.forEach(visit); visiting.delete(id); visited.add(id);
  }
  steps.forEach(s => visit(s.id));
  return { version: 1, name: o.name, concurrency: integer(o.concurrency, 2, 1, 16), prefixWarmupMs: integer(o.prefixWarmupMs, 0, 0, 5000), steps };
}
