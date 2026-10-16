import { isAbsolute, resolve, dirname, basename, join } from "node:path";
import { statSync, realpathSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { AGENTS, type Agent, type Scalar, type Step, type Workflow } from "./types";

export function physical(path: string): string {
  const p = resolve(path);
  try { return realpathSync(p); } catch {
    const parent = dirname(p);
    return parent === p ? p : join(physical(parent), basename(p));
  }
}
export const ID = /^[a-z][a-z0-9-]{0,39}$/;
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected an object");
  return value as Record<string, unknown>;
}
const FIELD = /^[A-Za-z_][\w-]*(\.[A-Za-z_][\w-]*){0,3}$/;
function fields(value: unknown, where: string): Record<string, Scalar> {
  const o = object(value);
  if (!Object.keys(o).length) throw new Error(`${where}: expected at least one field`);
  for (const [k, v] of Object.entries(o)) {
    if (!FIELD.test(k)) throw new Error(`${where}: invalid field ${k} (use a path like details.verdict)`);
    if (!["string", "number", "boolean"].includes(typeof v)) throw new Error(`${where}.${k}: expected a string, number or boolean`);
  }
  return o as Record<string, Scalar>;
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
    const isCommand = s.agent === "command";
    if (!AGENTS.includes(s.agent as Agent) && !isCommand) throw new Error(`${s.id}: agent must be one of ${AGENTS.join(", ")}, or command`);
    if (isCommand) {
      if (!Array.isArray(s.command) || !s.command.length || s.command.length > 256 || s.command.some(a => typeof a !== "string" || !a || Buffer.byteLength(a) > 8192))
        throw new Error(`${s.id}: a command step needs command: ["program", "arg", …]`);
      for (const k of ["model", "worktree", "inPlace", "reuseSession"]) if (s[k] !== undefined) throw new Error(`${s.id}: ${k} does not apply to a command step`);
      if (s.allowFailure !== undefined && typeof s.allowFailure !== "boolean") throw new Error(`${s.id}: allowFailure must be boolean`);
      if (s.policy !== undefined && s.policy !== "read-only") throw new Error(`${s.id}: a command step reads a frozen copy; it cannot write the project`);
      s.prompt ??= `run ${(s.command as string[]).join(" ")}`;
    } else if (s.command !== undefined || s.artifacts !== undefined || s.allowFailure !== undefined) throw new Error(`${s.id}: command, artifacts and allowFailure belong to agent: "command" steps`);
    if (s.artifacts !== undefined && (!Array.isArray(s.artifacts) || s.artifacts.length > 64 ||
      s.artifacts.some(a => typeof a !== "string" || !a || isAbsolute(a) || a.split("/").includes("..") || a.includes("\0"))))
      throw new Error(`${s.id}: artifacts are paths inside the checkout`);
    const host = s.host === undefined ? undefined : typeof s.host === "string" ? [s.host] : s.host;
    if (host !== undefined && (!Array.isArray(host) || !host.length || host.some(h => typeof h !== "string" || !ID.test(h) || h === "local")))
      throw new Error(`${s.id}: host is a host name, a list of names, or "any"`);
    if (host && s.inPlace) throw new Error(`${s.id}: an inPlace step edits this machine's checkout; it cannot have a host`);
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
    if (s.inPlace !== undefined && typeof s.inPlace !== "boolean") throw new Error(`${s.id}: inPlace must be boolean`);
    if (s.inPlace && (policy !== "workspace-write" || s.worktree || s.workspace !== undefined)) throw new Error(`${s.id}: inPlace requires a write step without worktree/workspace`);
    if (s.inPlace) {
      const git = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
      if (git.status !== 0 || realpathSync(git.stdout.trim()) !== realpathSync(cwd)) throw new Error(`${s.id}: inPlace cwd must be the Git checkout root`);
    }
    if (host || isCommand) {
      // cwd is a path on this machine; hosts and command jobs get a frozen copy of its Git checkout,
      // so a plain directory is a configuration error, not something a host can fix.
      const git = spawnSync("git", ["-C", cwd, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"], { encoding: "utf8" });
      if (git.status !== 0) throw new Error(`${s.id}: a ${host ? "step with a host" : "command step"} runs on a snapshot of cwd's Git checkout, and ${cwd} (a path on this machine) is not inside a Git repository with a commit; use a Git checkout as cwd${host && !isCommand ? ", or drop host to run it here" : ""}`);
    }
    if (s.reuseSession !== undefined && (typeof s.reuseSession !== "string" || !ID.test(s.reuseSession))) throw new Error(`${s.id}: reuseSession must be a step id`);
    if (s.worktree !== undefined && typeof s.worktree !== "boolean") throw new Error(`${s.id}: worktree must be boolean`);
    if (s.workspace !== undefined && (typeof s.workspace !== "string" || !ID.test(s.workspace))) throw new Error(`${s.id}: workspace must be a step id`);
    if (s.workspace !== undefined && s.worktree) throw new Error(`${s.id}: use either worktree: true or workspace: <step>`);
    if (s.workspace !== undefined && policy !== "workspace-write" && !isCommand) throw new Error(`${s.id}: workspace is only for write steps (and command steps reading one)`);
    if (policy === "workspace-write" && !s.worktree && !s.inPlace && s.workspace === undefined) throw new Error(`${s.id}: write steps require worktree: true, inPlace: true (or workspace: <an earlier write step>)`);
    const when = s.when === undefined ? undefined : Object.fromEntries(Object.entries(object(s.when)).map(([dep, f]) => {
      if (!(deps as string[]).includes(dep)) throw new Error(`${s.id}: when.${dep} must name a direct dependency`);
      return [dep, fields(f, `${s.id}: when.${dep}`)];
    }));
    if (when && !Object.keys(when).length) throw new Error(`${s.id}: when needs at least one dependency`);
    const expect = s.expect === undefined ? undefined : fields(s.expect, `${s.id}: expect`);
    if (policy === "read-only" && s.worktree) throw new Error(`${s.id}: worktree is only for write steps`);
    if (policy === "read-only" || s.inPlace) {
      const project = realpathSync(cwd);
      for (const path of [process.env.SFLOW_HOME ?? resolve(homedir(), ".local/state/session-flow"), process.env.OCS_HOME ?? resolve(homedir(), ".ocs")]) {
        const root = physical(path);
        if (project === root || project.startsWith(root + "/") || root.startsWith(project + "/")) throw new Error(`${s.id}: project overlaps protocol write roots`);
      }
    }
    return { id: s.id, agent: isCommand ? "command" : s.agent as Agent, ...(isCommand ? { command: s.command as string[] } : {}),
      ...(s.artifacts ? { artifacts: s.artifacts as string[] } : {}), ...(s.allowFailure ? { allowFailure: true } : {}), ...(host ? { host: [...new Set(host as string[])].sort() } : {}), model: s.model as string | undefined, prompt: s.prompt, cwd,
      dependsOn: deps as string[], policy, worktree: s.worktree as boolean | undefined,
      ...(s.inPlace ? { inPlace: true } : {}), ...(s.reuseSession !== undefined ? { reuseSession: s.reuseSession as string } : {}),
      ...(s.workspace !== undefined ? { workspace: s.workspace as string } : {}), ...(when ? { when } : {}), ...(expect ? { expect } : {}),
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
  // One writer per worktree at a time: a step may reuse only an ancestor's worktree, and every
  // two steps writing in the same worktree must be ordered by dependencies.
  const ancestors = (id: string, seen = new Set<string>()): Set<string> => {
    for (const d of byId.get(id)!.dependsOn) if (!seen.has(d)) { seen.add(d); ancestors(d, seen); }
    return seen;
  };
  for (const s of steps.filter(s => s.workspace !== undefined)) {
    const owner = byId.get(s.workspace!);
    if (s.agent !== "command" && JSON.stringify(s.host) !== JSON.stringify(owner?.host)) throw new Error(`${s.id}: a workspace chain stays on one host; give it the same host as ${s.workspace}`);
    if (!owner) throw new Error(`${s.id}: workspace ${s.workspace} is not a step`);
    if (owner.policy !== "workspace-write") throw new Error(`${s.id}: workspace ${s.workspace} is not a write step`);
    if (!ancestors(s.id).has(owner.id)) throw new Error(`${s.id}: workspace ${owner.id} must be one of its (indirect) dependencies`);
  }
  const writers = new Map<string, string[]>();
  for (const s of steps.filter(s => s.policy === "workspace-write")) {
    const root = workspaceRoot(steps, s);
    writers.set(root, [...(writers.get(root) ?? []), s.id]);
  }
  for (const ids of writers.values()) for (const a of ids) for (const b of ids)
    if (a < b && !ancestors(a).has(b) && !ancestors(b).has(a)) throw new Error(`${a} and ${b} write in the same worktree; one must depend on the other`);
  // A command step freezes the worktree it reads; every writer of it must come before or after.
  for (const c of steps.filter(s => s.agent === "command" && s.workspace !== undefined))
    for (const w of writers.get(workspaceRoot(steps, c)) ?? [])
      if (!ancestors(c.id).has(w) && !ancestors(w).has(c.id)) throw new Error(`${c.id} reads the worktree ${w} writes; order them with dependsOn`);
  for (const s of steps) {
    if (s.reuseSession) {
      const prev = byId.get(s.reuseSession);
      if (!prev || !ancestors(s.id).has(prev.id)) throw new Error(`${s.id}: reuseSession must name an ancestor`);
      if (JSON.stringify(s.host) !== JSON.stringify(prev.host)) throw new Error(`${s.id}: a reused session stays on one host; give it the same host as ${prev.id}`);
      if (s.agent === "agy" || s.agent !== prev.agent || s.model !== prev.model || s.policy !== prev.policy || effectiveWorkspace(steps, s) !== effectiveWorkspace(steps, prev))
        throw new Error(`${s.id}: reuseSession requires the same native agent, model, policy and workspace (agy unsupported)`);
    }
  }
  for (const a of steps) for (const b of steps) {
    if (a.id >= b.id) continue;
    const inPlace = [a, b].some(s => steps.find(x => x.id === workspaceRoot(steps, s))?.inPlace);
    const path = (s: Step) => {
      const root = steps.find(x => x.id === workspaceRoot(steps, s))!;
      return realpathSync(root.inPlace ? root.cwd : s.cwd);
    };
    const pa = path(a), pb = path(b);
    if (inPlace && (pa === pb || pa.startsWith(pb + "/") || pb.startsWith(pa + "/")) &&
        [a, b].some(s => s.policy === "workspace-write") && !ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id))
      throw new Error(`${a.id} and ${b.id}: in-place readers/writers must be dependency ordered`);
    if (sessionRoot(steps, a) === sessionRoot(steps, b) && !ancestors(a.id).has(b.id) && !ancestors(b.id).has(a.id))
      throw new Error(`${a.id} and ${b.id}: reused sessions must be dependency ordered`);
  }
  return { version: 1, name: o.name, concurrency: integer(o.concurrency, 2, 1, 16), prefixWarmupMs: integer(o.prefixWarmupMs, 0, 0, 5000), steps };
}

// The step that owns the worktree a write step works in (itself, or the end of a workspace chain).
export function workspaceRoot(steps: Step[], step: Step): string {
  let current = step;
  for (let i = 0; current.workspace !== undefined && i < steps.length; i++) current = steps.find(s => s.id === current.workspace)!;
  return current.id;
}

export function sessionRoot(steps: Step[], step: Step): string {
  let s = step;
  for (let i = 0; s.reuseSession && i < steps.length; i++) s = steps.find(x => x.id === s.reuseSession)!;
  return s.id;
}
function effectiveWorkspace(steps: Step[], step: Step): string {
  const root = steps.find(s => s.id === workspaceRoot(steps, step))!;
  return step.policy === "read-only" || root.inPlace ? realpathSync(root.cwd) : `worktree:${root.id}`;
}
