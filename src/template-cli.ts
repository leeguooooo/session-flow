import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { prepareStart, listTemplates, locateTemplate, createTemplate, removeTemplate, parseTemplate, preferences, scopeDir, writeJSON, setDefault, parsePreferences, type Preferences, type StartOptions, type Plan, type Located } from "./templates";
import { describe } from "./progress";

export function originSummary(origin: import("./types").RunOrigin) { return { template: origin.template, scope: origin.scope, path: origin.path, sha256: origin.sha256 }; }
function print(v: unknown) { console.log(JSON.stringify(v, null, 2)); }
function take(args: string[], flag: string) {
  const i = args.indexOf(flag); if (i < 0) return undefined;
  const value = args[i + 1]; if (value === undefined || value.startsWith("--")) throw new Error(`${flag} needs a value`);
  args.splice(i, 2); return value;
}
function bool(args: string[], flag: string) { const i = args.indexOf(flag); if (i < 0) return false; args.splice(i, 1); return true; }
function pairs(args: string[], flag: string): Record<string, string> {
  const result: Record<string, string> = {};
  while (args.includes(flag)) {
    const v = take(args, flag)!, i = v.indexOf("=");
    if (i < 1) throw new Error(`${flag} needs name=value`);
    const key = v.slice(0, i); if (Object.hasOwn(result, key)) throw new Error(`duplicate ${flag} ${key}`); result[key] = v.slice(i + 1);
  }
  return result;
}
function roles(args: string[]) {
  const r: NonNullable<StartOptions["roles"]> = {};
  for (const [k, v] of Object.entries(pairs(args, "--role"))) r[k] = { agent: v };
  for (const [k, v] of Object.entries(pairs(args, "--model"))) (r[k] ??= {}).model = v;
  return r;
}
function assertEmpty(args: string[]) { if (args.length) throw new Error(`unexpected arguments: ${args.join(" ")}`); }
function scalar(v: string): import("./types").Scalar { try { const x = JSON.parse(v); if (["string", "number", "boolean"].includes(typeof x)) return x; } catch {} return v; }
export function startPlan(args: string[], located?: Located): { plan: Plan; dryRun: boolean; json: boolean; progress: string } {
  const list = [...args], cwd = resolve(take(list, "--cwd") ?? "."), task = take(list, "--task") ?? "", template = take(list, "--template");
  const write = bool(list, "--write"), inPlace = bool(list, "--in-place"), dryRun = bool(list, "--dry-run"), json = bool(list, "--json"), progress = take(list, "--progress") ?? "text";
  if (!dryRun && json) throw new Error("--json is for start --dry-run (run stdout already uses JSON)");
  if (!["text", "json", "none"].includes(progress)) throw new Error("--progress text|json|none");
  const roleValues = roles(list), cliParams = pairs(list, "--param"), file = take(list, "--params-file");
  const hosts = Object.fromEntries(Object.entries(pairs(list, "--host")).map(([k, v]) => [k, v.split(",").map(x => x.trim()).filter(Boolean)]));
  let fileParams: Record<string, unknown> = {};
  if (file) { const value = JSON.parse(readFileSync(file, "utf8")); if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("--params-file must contain a parameter object"); fileParams = value; }
  assertEmpty(list);
  return { plan: prepareStart({ cwd, task, template, write, inPlace, located, roles: roleValues, hosts, params: { ...fileParams, ...cliParams }, paramSources: { ...Object.fromEntries(Object.keys(fileParams).map(k => [k, `CLI --params-file ${resolve(file!)}`])), ...Object.fromEntries(Object.keys(cliParams).map(k => [k, "CLI --param"])) } }), dryRun, json, progress };
}
export function describePlan(p: Plan): string[] {
  return [`template ${p.origin.template} (${p.origin.scope}), from ${p.origin.path}`, `selected by ${p.templateSource}; project ${p.project}; ${p.workflow.steps.some(s => s.inPlace) ? "writes directly in project checkout (--write --in-place supplied)" : p.writes ? "writes in isolated worktrees (--write supplied)" : "read-only"}`,
    ...Object.entries(p.origin.roles).map(([k, r]) => `  role ${k}: ${r.agent}${r.model ? ` / ${r.model}` : " / native default model"}`),
    ...Object.entries(p.sources).map(([k, v]) => `  ${k} from ${v}`), ...p.warnings.map(w => `warning: ${w}`), ...describe(p.workflow)];
}
export function templateCommand(input: string[]) {
  const args = [...input], cmd = args.shift();
  if (!cmd || cmd === "help") {
    console.log(`sflow template list [--cwd dir] [--json]
sflow template show <name> [--cwd dir] [--json]
sflow template create <name> --from <file|name> [--project|--global] [--cwd dir] [--force]
sflow template validate <name|file> [--cwd dir] [--task text] [--param key=value] [--write] [--in-place] [--json]
sflow template use <name> [--project|--global] [--cwd dir]
sflow template clear-default [--project|--global] [--cwd dir]
sflow template remove <name> [--project|--global] [--cwd dir]
Edit the saved JSON to customize roles, models, instructions and the DAG. show --json exports it.`); return;
  }
  const cwd = resolve(take(args, "--cwd") ?? "."), json = bool(args, "--json");
  const global = bool(args, "--global"), project = bool(args, "--project"); if (global && project) throw new Error("choose --project or --global");
  const scope = global ? "global" : "project";
  if (cmd === "list") { if (global || project) throw new Error("list shows all scopes; filter by the displayed scope"); assertEmpty(args); const entries = listTemplates(cwd); if (json) print(entries); else console.log(entries.map(t => `${t.scope}:${t.name}${t.shadowed ? " (shadowed)" : ""}  ${t.error ?? t.description ?? ""}\n  ${t.path}`).join("\n")); return; }
  if (cmd === "clear-default") { assertEmpty(args); console.log(setDefault(cwd, scope)); return; }
  const name = args.shift(); if (!name) throw new Error(`template ${cmd} needs a name`);
  if (cmd === "show") { if (global || project) throw new Error("show uses name prefixes (project:/global:/builtin:)"); assertEmpty(args); const t = locateTemplate(name, cwd); if (!json) console.error(`from ${t.path}`); print(t.template); return; }
  if (cmd === "create") { if (json) throw new Error("create does not take --json"); const from = take(args, "--from"); if (!from) throw new Error("create needs --from <file|name>"); const force = bool(args, "--force"); assertEmpty(args); console.log(createTemplate(name, from, cwd, scope, force)); return; }
  if (cmd === "use") { assertEmpty(args); console.log(setDefault(cwd, scope, name)); return; }
  if (cmd === "remove") { assertEmpty(args); console.log(removeTemplate(name, cwd, scope)); return; }
  if (cmd === "validate") {
    if (global || project) throw new Error("validate uses name prefixes");
    const task = take(args, "--task");
    let located: Located | undefined;
    if (existsSync(name)) {
      const content = readFileSync(name), t = parseTemplate(JSON.parse(content.toString()));
      located = { template: t, scope: "project", path: resolve(name), sha256: createHash("sha256").update(content).digest("hex") };
      if (!task) { assertEmpty(args); print({ valid: true, phase: "template structure", template: t.name, note: "Use validate --task with parameters or start --dry-run to validate the expanded workflow" }); return; }
    } else if (!task) { const t = locateTemplate(name, cwd); assertEmpty(args); print({ valid: true, phase: "template structure", template: t.template.name, note: "Use start --dry-run to validate an actual task" }); return; }
    const result = startPlan(["--cwd", cwd, "--template", name, "--task", task, "--dry-run", ...args], located);
    if (!json) describePlan(result.plan).forEach(l => console.error(l)); print({ valid: true, ...result.plan }); return;
  }
  throw new Error(`unknown template command: ${cmd}`);
}
export function configCommand(input: string[]) {
  const args = [...input], cmd = args.shift() ?? "show", cwd = resolve(take(args, "--cwd") ?? "."), json = bool(args, "--json");
  if (cmd === "show") {
    assertEmpty(args); const configs = preferences(cwd); const effective: Preferences = { version: 1, roles: {}, params: {} }, sources: Record<string, string> = {};
    for (const p of configs) {
      if (p.config.template) { effective.template = p.config.template; sources.template = p.path; }
      for (const [k, r] of Object.entries(p.config.roles ?? {})) for (const [f, v] of Object.entries(r)) { (effective.roles![k] ??= {})[f as "agent" | "model"] = v as never; sources[`roles.${k}.${f}`] = p.path; }
      for (const [k, v] of Object.entries(p.config.params ?? {})) { effective.params![k] = v; sources[`params.${k}`] = p.path; }
    }
    print({ effective, sources, configs, note: "Template field defaults and role inheritance are resolved by start --dry-run" }); return;
  }
  if (cmd !== "set" && cmd !== "clear") throw new Error("config show|set|clear");
  if (json) throw new Error("--json only applies to config show");
  const global = bool(args, "--global"), project = bool(args, "--project"); if (global && project) throw new Error("choose --project or --global");
  const path = join(scopeDir(global ? "global" : "project", cwd), "config.json");
  const p = existsSync(path) ? parsePreferences(JSON.parse(readFileSync(path, "utf8"))) : { version: 1 } as Preferences;
  if (cmd === "set") {
    const t = take(args, "--template"); if (t) { locateTemplate(t, cwd); p.template = t; }
    const r = roles(args); p.roles = { ...p.roles }; for (const [k, v] of Object.entries(r)) p.roles[k] = { ...p.roles[k], ...v } as NonNullable<Preferences["roles"]>[string];
    p.params = { ...p.params, ...Object.fromEntries(Object.entries(pairs(args, "--param")).map(([k, v]) => [k, scalar(v)])) };
  } else {
    const t = bool(args, "--template"), r = take(args, "--role"), param = take(args, "--param");
    if (!t && !r && !param) throw new Error("config clear needs --template, --role <name> or --param <name>");
    if (t) delete p.template; if (r) delete p.roles?.[r]; if (param) delete p.params?.[param];
  }
  assertEmpty(args); parsePreferences(p); writeJSON(path, p, true); console.log(path);
}
