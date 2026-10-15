import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync, renameSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve, isAbsolute, relative, sep } from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { AGENTS, type Agent, type Scalar, type Workflow, type RunOrigin } from "./types";
import { parseWorkflow } from "./config";
import { buildPreset, expandReviewFix, IMPLEMENT, REVIEW } from "./presets";

export type Scope = "project" | "global" | "builtin";
export interface Role { agent?: Agent; model?: string; inherit?: string; instructions?: string }
export interface Param { type: "string" | "integer" | "boolean"; default?: Scalar; min?: number; max?: number }
export interface Template {
  version: 1; kind: "sflow-template"; name: string; description?: string;
  params: Record<string, Param>; roles: Record<string, Role>; steps: Record<string, unknown>[];
  concurrency?: number; prefixWarmupMs?: number;
}
export interface Preferences { version: 1; template?: string; roles?: Record<string, Pick<Role, "agent" | "model">>; params?: Record<string, Scalar> }
export interface Located { template: Template; scope: Scope; path: string; sha256: string }
export interface StartOptions { located?: Located; cwd: string; task: string; template?: string; params?: Record<string, unknown>; paramSources?: Record<string, string>; roles?: Record<string, { agent?: string; model?: string }>; hosts?: Record<string, string[]>; write?: boolean; inPlace?: boolean }
export interface Plan { workflow: Workflow; origin: RunOrigin; warnings: string[]; writes: boolean; project: string; templateSource: string; sources: Record<string, string> }
const ID = /^[a-z][a-z0-9-]{0,39}$/;
const PARAM = /^[a-z][a-zA-Z0-9_-]{0,39}$/;
const PLACEHOLDER = /\{\{([a-z][a-zA-Z0-9_-]{0,39})\}\}/g;
function obj(v: unknown, where: string): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where}: expected object`); return v as Record<string, unknown>; }
function keys(o: Record<string, unknown>, allowed: string[], where: string) { for (const k of Object.keys(o)) if (!allowed.includes(k)) throw new Error(`${where}: unknown field ${k}`); }
function id(s: unknown, where: string): asserts s is string { if (typeof s !== "string" || !ID.test(s)) throw new Error(`${where}: invalid name`); }
function model(v: unknown, where: string) { if (v !== undefined && (typeof v !== "string" || !v.trim() || v.startsWith("-"))) throw new Error(`${where}: invalid model`); }
function role(v: unknown, where: string, override = false): Role {
  const r = obj(v, where); keys(r, override ? ["agent", "model"] : ["agent", "model", "inherit", "instructions"], where);
  if (r.agent !== undefined && !AGENTS.includes(r.agent as Agent)) throw new Error(`${where}: unsupported agent`);
  model(r.model, where);
  forbidPlaceholders(r.model, `${where}.model`);
  if (r.inherit !== undefined) id(r.inherit, where);
  if (!override && r.agent === undefined && r.inherit === undefined) throw new Error(`${where}: agent or inherit required`);
  if (r.instructions !== undefined && typeof r.instructions !== "string") throw new Error(`${where}: instructions must be a string`);
  return r as Role;
}
function refs(s: string): string[] {
  const matches = [...s.matchAll(/\{\{([^{}]*)\}\}/g)];
  for (const m of matches) if (!PARAM.test(m[1])) throw new Error(`invalid placeholder ${m[0]}`);
  const rest = s.replace(/\{\{([^{}]*)\}\}/g, "");
  if (rest.includes("{{") || rest.includes("}}")) throw new Error("malformed placeholder");
  return matches.map(m => m[1]);
}
function forbidPlaceholders(v: unknown, where: string) {
  if (typeof v === "string" && /\{\{/.test(v)) throw new Error(`${where}: placeholders are only allowed in prompt and role.instructions`);
  if (Array.isArray(v)) v.forEach(x => forbidPlaceholders(x, where));
  else if (v && typeof v === "object") Object.values(v).forEach(x => forbidPlaceholders(x, where));
}
function paramValue(v: unknown, p: Param, where: string): Scalar {
  if (p.type === "integer" ? typeof v !== "number" || !Number.isInteger(v) : typeof v !== p.type) throw new Error(`${where}: expected ${p.type}`);
  if (typeof v === "number" && ((p.min !== undefined && v < p.min) || (p.max !== undefined && v > p.max))) throw new Error(`${where}: outside parameter bounds`);
  return v as Scalar;
}
export function parseTemplate(value: unknown): Template {
  const o = obj(value, "template"); keys(o, ["version", "kind", "name", "description", "params", "roles", "steps", "concurrency", "prefixWarmupMs"], "template");
  if (o.version !== 1 || o.kind !== "sflow-template") throw new Error("expected version 1 sflow-template");
  id(o.name, "template"); if (o.description !== undefined && typeof o.description !== "string") throw new Error("description must be a string");
  const params = obj(o.params ?? {}, "params");
  const normalized: Record<string, Param> = { task: { type: "string" } };
  for (const [k, value] of Object.entries(params)) {
    if (!PARAM.test(k)) throw new Error(`invalid parameter ${k}`);
    const p = obj(value, `params.${k}`); keys(p, ["type", "default", "min", "max"], `params.${k}`);
    if (!["string", "integer", "boolean"].includes(p.type as string)) throw new Error(`${k}: unsupported parameter type`);
    if (k === "task" && (p.type !== "string" || p.default !== undefined)) throw new Error("task is a required string without a default");
    for (const b of ["min", "max"]) if (p[b] !== undefined && (p.type !== "integer" || typeof p[b] !== "number" || !Number.isInteger(p[b]))) throw new Error(`${k}: ${b} requires an integer parameter`);
    if (p.min !== undefined && p.max !== undefined && Number(p.min) > Number(p.max)) throw new Error(`${k}: min exceeds max`);
    if (p.default !== undefined) paramValue(p.default, p as unknown as Param, k);
    normalized[k] = p as unknown as Param;
  }
  const roles = Object.fromEntries(Object.entries(obj(o.roles, "roles")).map(([k, v]) => { id(k, "role"); return [k, role(v, `roles.${k}`)]; }));
  if (!Object.keys(roles).length) throw new Error("roles cannot be empty");
  function visit(k: string, chain: string[] = []) {
    if (!Object.hasOwn(roles, k)) throw new Error(`unknown inherited role ${k}`);
    if (chain.includes(k)) throw new Error("role inheritance cycle");
    if (roles[k].inherit) visit(roles[k].inherit!, [...chain, k]);
  }
  Object.keys(roles).forEach(k => visit(k));
  if (!Array.isArray(o.steps) || !o.steps.length) throw new Error("template needs steps");
  const allowed = ["id", "role", "prompt", "cwd", "dependsOn", "policy", "worktree", "workspace", "inPlace", "reuseSession", "when", "expect", "timeoutSeconds", "readyTimeoutSeconds", "reviewFix", "host", "command", "artifacts", "allowFailure"];
  for (const value of o.steps) {
    const s = obj(value, "step"); keys(s, allowed, "step"); id(s.id, "step");
    // A command step runs a program, not an agent: it has no role, and its prompt is optional.
    if (s.command !== undefined) {
      if (s.role !== undefined || s.reviewFix !== undefined) throw new Error(`${s.id}: a command step has no role or reviewFix`);
      if (s.prompt !== undefined && (typeof s.prompt !== "string" || !s.prompt.trim())) throw new Error(`${s.id}: prompt must be text`);
    } else {
      id(s.role, `${s.id}.role`);
      if (!Object.hasOwn(roles, s.role)) throw new Error(`${s.id}: unknown role ${s.role}`);
      if (typeof s.prompt !== "string" || !s.prompt.trim()) throw new Error(`${s.id}: prompt required`);
    }
    if (typeof s.cwd !== "string" || !s.cwd || isAbsolute(s.cwd) || s.cwd.split(/[\\/]/).includes("..")) throw new Error(`${s.id}: cwd must be a relative path without ..`);
    for (const [k, v] of Object.entries(s)) if (k !== "prompt" && k !== "reviewFix") forbidPlaceholders(v, `${s.id}.${k}`);
    if (s.reviewFix !== undefined) {
      const f = obj(s.reviewFix, "reviewFix"); keys(f, ["fixRole", "workspace", "rounds"], "reviewFix"); id(f.fixRole, "reviewFix.fixRole"); id(f.workspace, "reviewFix.workspace");
      if (!Object.hasOwn(roles, f.fixRole as string)) throw new Error("unknown fixRole");
      const r = obj(f.rounds, "reviewFix.rounds"); keys(r, ["param"], "reviewFix.rounds");
      if (typeof r.param !== "string" || normalized[r.param]?.type !== "integer") throw new Error("reviewFix.rounds must reference an integer parameter");
      forbidPlaceholders(f, "reviewFix");
      if (!Array.isArray(s.dependsOn) || !s.dependsOn.includes(f.workspace)) throw new Error("reviewFix workspace must be a direct dependency");
      if (s.when !== undefined || s.expect !== undefined || s.policy === "workspace-write" || s.worktree !== undefined || s.workspace !== undefined) throw new Error("reviewFix belongs to an unconditional read-only review step");
    }
    for (const k of refs(String(s.prompt ?? ""))) if (!Object.hasOwn(normalized, k)) throw new Error(`${s.id}: undeclared parameter ${k}`);
  }
  for (const [k, r] of Object.entries(roles)) for (const p of refs(r.instructions ?? "")) if (!Object.hasOwn(normalized, p)) throw new Error(`roles.${k}: undeclared parameter ${p}`);
  for (const [k, min, max] of [["concurrency", 1, 16], ["prefixWarmupMs", 0, 5000]] as const)
    if (o[k] !== undefined && (!Number.isInteger(o[k]) || Number(o[k]) < min || Number(o[k]) > max)) throw new Error(`invalid ${k}`);
  return { ...o, params: normalized, roles } as unknown as Template;
}
export function configHome(): string { return resolve(process.env.SFLOW_CONFIG_HOME ?? join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "sflow")); }
export function projectRoot(cwd: string): string {
  const root = realpathSync(resolve(cwd));
  const r = spawnSync("git", ["-C", root, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return r.status === 0 ? realpathSync(r.stdout.trim()) : root;
}
export function scopeDir(scope: "project" | "global", cwd: string): string { return scope === "global" ? configHome() : join(projectRoot(cwd), ".sflow"); }
export function parsePreferences(v: unknown): Preferences {
  const o = obj(v, "config"); keys(o, ["version", "template", "roles", "params"], "config");
  if (o.version !== 1) throw new Error("config version must be 1");
  if (o.template !== undefined && (typeof o.template !== "string" || !/^(?:(project|global|builtin):)?[a-z][a-z0-9-]{0,39}$/.test(o.template))) throw new Error("invalid default template");
  if (o.roles !== undefined) for (const [k, r] of Object.entries(obj(o.roles, "config.roles"))) { id(k, "role"); role(r, `config.roles.${k}`, true); }
  if (o.params !== undefined) for (const [k, v] of Object.entries(obj(o.params, "config.params"))) {
    if (!PARAM.test(k) || k === "task" || !["string", "number", "boolean"].includes(typeof v) || (typeof v === "number" && !Number.isInteger(v))) throw new Error(`invalid config parameter ${k}`);
  }
  return o as unknown as Preferences;
}
export function preferences(cwd: string): { scope: "project" | "global"; path: string; config: Preferences }[] {
  return (["global", "project"] as const).map(scope => {
    const path = join(scopeDir(scope, cwd), "config.json");
    return { scope, path, config: existsSync(path) ? parsePreferences(JSON.parse(readFileSync(path, "utf8"))) : { version: 1 } as Preferences };
  });
}
export function writeJSON(path: string, value: unknown, force = false) {
  mkdirSync(resolve(path, ".."), { recursive: true });
  if (!force && existsSync(path)) throw new Error(`${path} exists; use --force to replace`);
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // link creates without replacement, avoiding a concurrent creator being silently overwritten.
    if (!force) { const { linkSync } = require("node:fs") as typeof import("node:fs"); linkSync(tmp, path); }
    else renameSync(tmp, path);
  } finally { if (existsSync(tmp)) unlinkSync(tmp); }
}
export function setDefault(cwd: string, scope: "project" | "global", name?: string) {
  const path = join(scopeDir(scope, cwd), "config.json");
  const p = existsSync(path) ? parsePreferences(JSON.parse(readFileSync(path, "utf8"))) : { version: 1 } as Preferences;
  if (name) { locateTemplate(name, cwd); p.template = name; } else delete p.template;
  writeJSON(path, p, true); return path;
}
export function builtinTemplates(): Record<string, Template> {
  const basic = (name: string, preset: string): Template => {
    const w = buildPreset(preset, { task: "{{task}}", cwd: "." }) as { steps: Record<string, unknown>[]; concurrency: number };
    const roles: Record<string, Role> = {}, steps = w.steps.map(s => {
      const { agent, model: _, ...rest } = s; const name = String(s.id); roles[name] = { agent: agent as Agent };
      return { ...rest, cwd: ".", role: name };
    });
    return parseTemplate({ version: 1, kind: "sflow-template", name, description: `Built-in ${name} workflow`, params: {}, roles, steps, concurrency: w.concurrency });
  };
  return {
    review: basic("review", "review"), investigate: basic("investigate", "fan-out"), "fan-out": basic("fan-out", "fan-out"),
    dev: parseTemplate({ version: 1, kind: "sflow-template", name: "dev", description: "Plan, implement, review and repair in one worktree", params: { rounds: { type: "integer", default: 2, min: 1, max: 5 } },
      roles: { plan: { agent: "claude" }, implement: { agent: "codex" }, review: { agent: "claude" }, fix: { inherit: "implement" } },
      steps: [
        { id: "plan", role: "plan", cwd: ".", prompt: "Task: {{task}}\nRead the relevant code and propose the smallest implementation. Report the plan, and --detail acceptance='<explicit acceptance criteria>'. Do not edit files." },
        { id: "implement", role: "implement", cwd: ".", dependsOn: ["plan"], policy: "workspace-write", worktree: true, prompt: IMPLEMENT("{{task}}") + "\nFollow the plan dependency and preserve its acceptance criteria." },
        { id: "review", role: "review", cwd: ".", dependsOn: ["implement", "plan"], prompt: REVIEW("{{task}}", "implement"), reviewFix: { fixRole: "fix", workspace: "implement", rounds: { param: "rounds" } } }
      ] })
  };
}
export function locateTemplate(name: string, cwd: string): Located {
  const m = /^(?:(project|global|builtin):)?([a-z][a-z0-9-]{0,39})$/.exec(name); if (!m) throw new Error("invalid template name");
  const order: Scope[] = m[1] ? [m[1] as Scope] : ["project", "global", "builtin"];
  for (const scope of order) {
    const path = scope === "builtin" ? `builtin:${m[2]}` : join(scopeDir(scope, cwd), "templates", `${m[2]}.json`);
    if (scope !== "builtin" && !existsSync(path)) continue;
    const value = scope === "builtin" ? builtinTemplates()[m[2]] : JSON.parse(readFileSync(path, "utf8"));
    if (!value) continue;
    const template = parseTemplate(value), sha256 = createHash("sha256").update(scope === "builtin" ? JSON.stringify(value) : readFileSync(path)).digest("hex");
    return { template, scope, path, sha256 };
  }
  throw new Error(`template ${name} not found; use sflow template list`);
}
export function listTemplates(cwd: string) {
  const names: { name: string; scope: Scope; path: string; description?: string; shadowed: boolean; error?: string }[] = [];
  const seen = new Set<string>();
  for (const scope of ["project", "global", "builtin"] as const) {
    const dir = scope === "builtin" ? "" : join(scopeDir(scope, cwd), "templates");
    const ids = scope === "builtin" ? Object.keys(builtinTemplates()) : existsSync(dir) ? readdirSync(dir).filter(f => /^[a-z][a-z0-9-]{0,39}\.json$/.test(f)).map(f => f.slice(0, -5)) : [];
    for (const name of ids.sort()) {
      const entry = { name, scope, path: scope === "builtin" ? `builtin:${name}` : join(dir, name + ".json"), shadowed: seen.has(name) };
      seen.add(name);
      try { names.push({ ...entry, description: locateTemplate(`${scope}:${name}`, cwd).template.description }); }
      catch (e) { names.push({ ...entry, error: (e as Error).message }); }
    }
  }
  return names;
}
export function createTemplate(name: string, from: string, cwd: string, scope: "project" | "global", force = false): string {
  id(name, "template"); let value: unknown;
  if (existsSync(from)) {
    value = JSON.parse(readFileSync(from, "utf8"));
    const o = obj(value, "import");
    if (o.kind !== "sflow-template") {
      // Existing workflows can be imported without making instance paths reusable defaults.
      const wf = parseWorkflow(o, resolve(from, ".."));
      const root = realpathSync(resolve(cwd));
      for (const step of wf.steps) { const rel = relative(root, realpathSync(step.cwd)); if (isAbsolute(rel) || rel.split(sep).includes("..")) throw new Error("imported workflow cwd must be within --cwd; choose the correct project root"); }
      const roles: Record<string, Role> = {};
      value = { version: 1, kind: "sflow-template", name, params: {}, concurrency: wf.concurrency, prefixWarmupMs: wf.prefixWarmupMs,
        roles, steps: wf.steps.map(s => {
          const { agent, model, ...step } = s, rel = relative(root, realpathSync(s.cwd)) || ".";
          if (agent === "command") return { ...step, cwd: rel };
          roles[s.id] = { agent, ...(model ? { model } : {}) }; return { ...step, cwd: rel, role: s.id };
        }) };
    }
  } else value = locateTemplate(from, cwd).template;
  const template = parseTemplate({ ...obj(value, "template"), name });
  const path = join(scopeDir(scope, cwd), "templates", name + ".json"); writeJSON(path, template, force); return path;
}
export function removeTemplate(name: string, cwd: string, scope: "project" | "global") {
  id(name, "template"); const path = join(scopeDir(scope, cwd), "templates", name + ".json");
  if (!existsSync(path)) throw new Error(`template ${name} not found in ${scope}`);
  for (const p of preferences(cwd)) if (p.config.template) {
    const located = locateTemplate(p.config.template, cwd);
    if (located.path === path) throw new Error(`template is the ${p.scope} default; use template clear-default first`);
  }
  unlinkSync(path); return path;
}
export function prepareStart(o: StartOptions): Plan {
  if (!o.task?.trim()) throw new Error("--task is required");
  const cwd = realpathSync(resolve(o.cwd)), prefs = preferences(cwd), sources: Record<string, string> = {};
  let name: string | undefined, templateSource = "";
  for (const p of prefs) if (p.config.template) { name = p.config.template; templateSource = p.path; }
  if (o.template) { name = o.template; templateSource = "CLI --template"; }
  if (o.located) { name = o.located.template.name; templateSource = `CLI template file ${o.located.path}`; }
  if (!name) {
    const available = listTemplates(cwd).map(t => `${t.scope}:${t.name}`).join(", ");
    throw new Error(`No default template is configured. Use sflow start --template <name> --task ...; to omit it later, use sflow template use <name> --project|--global. Available templates: ${available}`);
  }
  const located = o.located ?? locateTemplate(name, cwd), t = located.template, warnings: string[] = [];
  sources.template = templateSource;
  const values: Record<string, unknown> = {}, overrides: Record<string, { agent?: string; model?: string }> = {};
  for (const [k, p] of Object.entries(t.params)) if (p.default !== undefined) { values[k] = p.default; sources[`params.${k}`] = located.path; }
  for (const p of prefs) {
    for (const [k, v] of Object.entries(p.config.params ?? {})) {
      if (!Object.hasOwn(t.params, k)) { warnings.push(`ignored ${p.scope} config parameter ${k}: template ${name} has no such parameter (${p.path})`); continue; }
      values[k] = v; sources[`params.${k}`] = p.path;
    }
    for (const [k, v] of Object.entries(p.config.roles ?? {})) {
      if (!Object.hasOwn(t.roles, k)) { warnings.push(`ignored ${p.scope} config role ${k}: template ${name} has no such role (${p.path})`); continue; }
      for (const [field, x] of Object.entries(v)) { (overrides[k] ??= {})[field as "agent" | "model"] = x; sources[`roles.${k}.${field}`] = p.path; }
    }
  }
  for (const [k, v] of Object.entries(o.params ?? {})) { if (k === "task") throw new Error("use --task instead of --param task"); values[k] = v; sources[`params.${k}`] = o.paramSources?.[k] ?? "CLI --param"; }
  values.task = o.task; sources["params.task"] = "CLI --task";
  for (const k of Object.keys(values)) if (!Object.hasOwn(t.params, k)) throw new Error(`unknown parameter ${k} for template ${name}`);
  const params: Record<string, Scalar> = {};
  for (const [k, p] of Object.entries(t.params)) {
    let value = values[k];
    if (sources[`params.${k}`] === "CLI --param" && typeof value === "string" && p.type !== "string") {
      if (p.type === "boolean" && ["true", "false"].includes(value)) value = value === "true";
      else if (p.type === "integer" && /^-?\d+$/.test(value)) value = Number(value);
    }
    params[k] = paramValue(value, p, `parameter ${k}`);
  }
  for (const [k, v] of Object.entries(o.roles ?? {})) {
    for (const [field, x] of Object.entries(v)) { (overrides[k] ??= {})[field as "agent" | "model"] = x; sources[`roles.${k}.${field}`] = `CLI --${field === "agent" ? "role" : "model"}`; }
  }
  for (const k of Object.keys(overrides)) if (!Object.hasOwn(t.roles, k)) throw new Error(`unknown role ${k} for template ${name}`);
  const replace = (s: string) => s.replace(PLACEHOLDER, (_, k: string) => String(params[k]));
  const roles: Record<string, { agent: Agent; model?: string; instructions?: string }> = Object.create(null);
  function bind(k: string): typeof roles[string] {
    if (roles[k]) return roles[k];
    const r = t.roles[k], inherited = r.inherit ? bind(r.inherit) : undefined;
    const agent = overrides[k]?.agent ?? r.agent ?? inherited?.agent;
    const m = overrides[k]?.model ?? r.model ?? inherited?.model;
    const checked = role({ agent, ...(m !== undefined ? { model: m } : {}) }, `role ${k}`);
    for (const field of ["agent", "model"] as const) if (!sources[`roles.${k}.${field}`]) sources[`roles.${k}.${field}`] = r[field] !== undefined || !inherited ? located.path : `inherit ${r.inherit} (${sources[`roles.${r.inherit}.${field}`]})`;
    if (r.instructions !== undefined) sources[`roles.${k}.instructions`] = located.path;
    return roles[k] = { agent: checked.agent!, ...(m !== undefined ? { model: m } : {}), ...(r.instructions !== undefined ? { instructions: replace(r.instructions) } : {}) };
  }
  Object.keys(t.roles).forEach(bind);
  const used = new Set(t.steps.flatMap(s => refs(String(s.prompt ?? ""))));
  for (const r of Object.values(t.roles)) refs(r.instructions ?? "").forEach(k => used.add(k));
  const expanded: Record<string, unknown>[] = [];
  for (const s of t.steps) {
    const { reviewFix, ...first } = s;
    if (reviewFix) {
      const f = reviewFix as { fixRole: string; workspace: string; rounds: { param: string } }; used.add(f.rounds.param);
      const rounds = params[f.rounds.param]; if (typeof rounds !== "number" || rounds < 1 || rounds > 5) throw new Error("reviewFix rounds must be 1..5");
      expanded.push(...expandReviewFix(first, { role: f.fixRole }, f.workspace, rounds, "{{task}}"));
    } else expanded.push(first);
  }
  for (const k of Object.keys(o.hosts ?? {})) if (!expanded.some(s => s.id === k)) throw new Error(`unknown step ${k} for --host (template ${name})`);
  const steps: Record<string, unknown>[] = expanded.map(s => {
    const { role: key, ...step } = s;
    const path = resolve(cwd, String(s.cwd)), physical = realpathSync(path);
    if (physical !== cwd && !physical.startsWith(cwd + sep)) throw new Error(`${s.id}: cwd escapes --cwd`);
    const host = o.hosts?.[String(s.id)];
    if (host) sources[`steps.${s.id}.host`] = "CLI --host"; else if (s.host !== undefined) sources[`steps.${s.id}.host`] = located.path;
    const placed = host ? { host } : {};
    if (s.command !== undefined) return { ...step, ...placed, cwd: physical, agent: "command", ...(s.prompt !== undefined ? { prompt: replace(String(s.prompt)) } : {}) };
    const r = roles[String(key)];
    return { ...step, ...placed, cwd: physical, agent: r.agent, ...(r.model ? { model: r.model } : {}), prompt: replace(String(s.prompt)) + (r.instructions ? `\n\nRole instructions:\n${r.instructions}` : "") };
  });
  const writes = steps.some(s => s.policy === "workspace-write");
  if (writes && !o.write) throw new Error(`template ${name} writes code; add --write for this task (defaults cannot authorize writing)`);
  if (steps.some(s => s.inPlace) && !o.inPlace) throw new Error(`template ${name} writes directly in the project checkout; add --in-place and --write for this task`);
  if (o.inPlace) {
    if (!writes) throw new Error("--in-place requires a write template and --write");
    for (const s of steps.filter(s => s.worktree)) { delete s.worktree; s.inPlace = true; s.prompt += "\nWrite directly in the existing project checkout. Preserve all pre-existing user edits; never reset, stash or clean."; }
  }
  const workflow = parseWorkflow({ version: 1, name: t.name, concurrency: t.concurrency ?? 2, prefixWarmupMs: t.prefixWarmupMs ?? 0, steps }, cwd);
  return { workflow, writes, project: projectRoot(cwd), templateSource, warnings: [...warnings, ...Object.keys(t.params).filter(k => !used.has(k)).map(k => `parameter ${k} is declared but unused`)], sources,
    origin: { template: t.name, scope: located.scope, path: located.path, sha256: located.sha256, params, roles: Object.fromEntries(Object.entries(roles).map(([k, v]) => [k, { ...v, sources: Object.fromEntries(Object.entries(sources).filter(([f]) => f.startsWith(`roles.${k}.`)) ) }])) } };
}
