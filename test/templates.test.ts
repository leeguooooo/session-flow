import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { builtinTemplates, parseTemplate, prepareStart, createTemplate, setDefault, removeTemplate, listTemplates, writeJSON, parsePreferences, preferences } from "../src/templates";
import { buildPreset } from "../src/presets";
import { createRun, loadRun } from "../src/store";
import { reviewRun } from "../src/review";
import { listRuns } from "../src/runs";
const env = { ...process.env }, dirs: string[] = [];
afterEach(() => { process.env = { ...env }; for (const p of dirs.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sf-template-"))); dirs.push(root);
  const cwd = join(root, "project"); mkdirSync(cwd);
  process.env.SFLOW_CONFIG_HOME = join(root, "global"); process.env.SFLOW_HOME = join(root, "state");
  return { root, cwd, global: process.env.SFLOW_CONFIG_HOME, project: join(cwd, ".sflow") };
}
function template(agent = "codex") { return { version: 1, kind: "sflow-template", name: "simple", params: {}, roles: { implement: { agent }, fix: { inherit: "implement", instructions: "own instructions" } }, steps: [{ id: "look", role: "fix", cwd: ".", prompt: "Task {{task}}" }] }; }
function saved(cwd: string, value: unknown) { const file = join(cwd, "input.json"); writeFileSync(file, JSON.stringify(value)); createTemplate("simple", file, cwd, "project"); }

test("built-in dev gives every review plan acceptance and bounded repair, and legacy repair expansion stays byte-identical", () => {
  const { cwd } = fixture();
  const p = prepareStart({ cwd, task: "feature", template: "builtin:dev", write: true });
  for (const s of p.workflow.steps.filter(s => s.id.startsWith("review-"))) { expect(s.dependsOn).toContain("plan"); expect(s.prompt).toContain("plan.details.acceptance"); }
  expect(p.workflow.steps.at(-1)?.expect).toEqual({ "details.verdict": "pass" });
  expect(p.workflow.steps.find(s => s.id === "fix-1")?.workspace).toBe("implement");
  const current = JSON.stringify(buildPreset("implement-review-fix", { task: "snapshot-task", cwd: ".", write: true, rounds: 2 })).split(process.cwd()).join("/PROJECT");
  expect(JSON.parse(current)).toEqual(JSON.parse(readFileSync(join(import.meta.dir, "fixtures/legacy-review-fix.json"), "utf8")));
  const planned = buildPreset("plan-implement-review", { task: "x", cwd, write: true }) as { steps: Record<string, unknown>[] };
  expect(planned.steps[2].dependsOn).toContain("plan"); expect(String(planned.steps[0].prompt)).toContain("--detail acceptance=");
});

test("write authorization is required on every task, including a changed default; config cannot grant it", () => {
  const { cwd } = fixture(); setDefault(cwd, "project", "builtin:review");
  expect(prepareStart({ cwd, task: "x" }).writes).toBe(false);
  setDefault(cwd, "project", "builtin:dev");
  expect(() => prepareStart({ cwd, task: "x" })).toThrow("add --write");
  expect(() => parsePreferences({ version: 1, write: true })).toThrow("unknown field write");
  expect(() => parsePreferences({ version: 1, policy: "workspace-write" })).toThrow("unknown field policy");
});

test("global, project and explicit fields merge independently; fix inherits final implement agent/model, never its instructions", () => {
  const { cwd, global, project } = fixture(); saved(cwd, template());
  writeJSON(join(global, "config.json"), { version: 1, template: "builtin:review", roles: { implement: { agent: "pi", model: "global-model" } } });
  writeJSON(join(project, "config.json"), { version: 1, template: "simple", roles: { implement: { agent: "claude" } } });
  const p = prepareStart({ cwd, task: "x", roles: { implement: { model: "cli-model" } } });
  expect(p.workflow.steps[0].agent).toBe("claude"); expect(p.workflow.steps[0].model).toBe("cli-model");
  expect(p.sources["roles.implement.agent"]).toBe(join(project, "config.json"));
  expect(p.sources["roles.implement.model"]).toBe("CLI --model");
  expect(p.origin.roles.fix.instructions).toBe("own instructions");
  expect(p.origin.roles.fix.sources["roles.fix.agent"]).toContain("inherit implement");
  expect(() => prepareStart({ cwd, task: "x", roles: { missing: { agent: "pi" } } })).toThrow("unknown role");
});

test("typed parameters have defaults and strict bounds, unknown and required checks, single-pass literal substitution", () => {
  const { cwd } = fixture(); const t = template() as any;
  t.params = { count: { type: "integer", default: 2, min: 1, max: 3 }, flag: { type: "boolean" }, text: { type: "string" } };
  t.steps[0].prompt += " {{count}} {{flag}} {{text}}"; t.roles.fix.instructions = "{{text}}"; saved(cwd, t);
  const literal = 'quotes " \' $(touch /tmp/never) `uname` {{task}}';
  const p = prepareStart({ cwd, template: "simple", task: "instance", params: { flag: "true", text: literal } });
  expect(p.workflow.steps[0].prompt).toContain("instance 2 true " + literal);
  expect(p.workflow.steps[0].prompt).toContain("Role instructions:\n" + literal);
  expect(() => prepareStart({ cwd, template: "simple", task: "x", params: { flag: true } })).toThrow("text");
  expect(() => prepareStart({ cwd, template: "simple", task: "x", params: { flag: true, text: "", count: "4" } })).toThrow("bounds");
  expect(() => prepareStart({ cwd, template: "simple", task: "x", params: { extra: "x" } })).toThrow("unknown parameter");
  expect(() => parseTemplate({ ...t, params: {} })).toThrow("undeclared parameter");
  const malformed = template() as any; malformed.steps[0].prompt = "{{BAD}}";
  expect(() => parseTemplate(malformed)).toThrow("invalid placeholder");
  expect(() => prepareStart({ cwd, task: "x", template: "simple", params: { flag: true, text: "" }, roles: { fix: { model: "" } } })).toThrow("invalid model");
});

test("templates reject unknown fields, inheritance cycles, traversal and placeholders outside prompt fields", () => {
  const { cwd, root } = fixture();
  expect(() => parseTemplate({ ...template(), bad: true })).toThrow("unknown field");
  const t = template() as any; t.roles.implement.inherit = "fix";
  expect(() => parseTemplate(t)).toThrow("cycle");
  for (const field of ["id", "cwd", "policy", "workspace", "dependsOn", "when", "expect"]) {
    const t = template() as any; t.steps[0][field] = field === "dependsOn" ? ["{{task}}"] : field === "when" || field === "expect" ? { value: "{{task}}" } : "{{task}}";
    expect(() => parseTemplate(t)).toThrow();
  }
  const escaped = template() as any; escaped.steps[0].cwd = "../outside"; expect(() => parseTemplate(escaped)).toThrow("relative path");
  const abs = template() as any; abs.steps[0].cwd = cwd; expect(() => parseTemplate(abs)).toThrow("relative path");
  const outside = join(root, "outside"); mkdirSync(outside); symlinkSync(outside, join(cwd, "link"));
  const link = template() as any; link.steps[0].cwd = "link"; saved(cwd, link);
  expect(() => prepareStart({ cwd, task: "x", template: "simple" })).toThrow("escapes");
  expect(() => createTemplate("../escape", "builtin:review", cwd, "project")).toThrow("invalid name");
});

test("template CRUD, explicit scopes and shadowing, protected default deletion, malformed config fail closed", () => {
  const { cwd, project } = fixture();
  createTemplate("review", "builtin:review", cwd, "global"); createTemplate("review", "builtin:review", cwd, "project");
  const list = listTemplates(cwd).filter(x => x.name === "review");
  expect(list.map(x => x.shadowed)).toEqual([false, true, true]);
  expect(() => createTemplate("review", "builtin:review", cwd, "project")).toThrow("exists");
  setDefault(cwd, "project", "project:review"); expect(() => removeTemplate("review", cwd, "project")).toThrow("default");
  setDefault(cwd, "project"); removeTemplate("review", cwd, "project");
  expect(prepareStart({ cwd, task: "x", template: "global:review" }).origin.scope).toBe("global");
  expect(prepareStart({ cwd, task: "x", template: "builtin:review" }).origin.scope).toBe("builtin");
  writeFileSync(join(project, "config.json"), "{bad"); expect(() => prepareStart({ cwd, task: "x", template: "builtin:review" })).toThrow();
});

test("origin is immutable in private run snapshots but public review/list omit task text", async () => {
  const { cwd } = fixture(); const plan = prepareStart({ cwd, task: "SYNTHETIC_PRIVATE_TASK", template: "builtin:review" });
  const run = createRun(plan.workflow, plan.origin); dirs.push(join(run.socket, ".."));
  setDefault(cwd, "project", "builtin:dev");
  const same = loadRun(run.id); expect(same.workflow).toEqual(run.workflow); expect(same.origin).toEqual(plan.origin);
  const runtime = { exists: async () => false } as any;
  const publicReview = await reviewRun(same, runtime);
  expect(JSON.stringify(publicReview)).not.toContain("SYNTHETIC_PRIVATE_TASK");
  expect(JSON.stringify(listRuns())).not.toContain("SYNTHETIC_PRIVATE_TASK");
  expect(publicReview.origin?.template).toBe("review");
});

test("CLI dry-run starts no agents; defaults/role overrides and template management work through actual command parsing", () => {
  const { cwd, root } = fixture();
  const run = (...args: string[]) => Bun.spawnSync(["bun", "src/cli.ts", ...args], { cwd: import.meta.dir + "/..", env: { ...process.env, SFLOW_NO_UPDATE_CHECK: "1" } });
  expect(run("template", "create", "mine", "--from", "builtin:review", "--cwd", cwd).exitCode).toBe(0);
  expect(run("template", "use", "mine", "--cwd", cwd).exitCode).toBe(0);
  const p = run("start", "--task", "test", "--cwd", cwd, "--role", "review=codex", "--model", "review=custom", "--dry-run", "--json");
  expect(p.exitCode).toBe(0); expect(JSON.parse(p.stdout.toString()).workflow.steps[0].model).toBe("custom");
  expect(() => readFileSync(join(root, "state", "runs"))).toThrow();
  expect(run("start", "--task", "x", "--cwd", cwd, "--template", "builtin:dev", "--dry-run", "--json").stderr.toString()).toContain("add --write");
  expect(run("template", "show", "mine", "--cwd", cwd, "--json").exitCode).toBe(0);
  const fileValidation = run("template", "validate", join(cwd, ".sflow/templates/mine.json"), "--cwd", cwd, "--task", "validated task", "--json");
  expect(fileValidation.exitCode).toBe(0); expect(JSON.parse(fileValidation.stdout.toString()).workflow.steps[0].prompt).toContain("validated task");
  expect(run("config", "set", "--cwd", cwd, "--model", "review=other").exitCode).toBe(0);
  expect(preferences(cwd)[1].config.roles?.review.model).toBe("other");
});


test("cross-template preferences warn and are ignored, while explicit unknown CLI fields still fail", () => {
  const { cwd, global, project } = fixture();
  writeJSON(join(global, "config.json"), { version: 1, params: { rounds: 3 }, roles: { plan: { agent: "pi" } } });
  writeJSON(join(project, "config.json"), { version: 1, params: { focus: "correctness" }, roles: { implement: { agent: "codex" } } });
  const p = prepareStart({ cwd, task: "look", template: "builtin:review" });
  expect(p.warnings.some(w => w.includes("ignored global config parameter rounds"))).toBe(true);
  expect(p.warnings.some(w => w.includes("ignored project config role implement"))).toBe(true);
  expect(p.origin.params).toEqual({ task: "look" }); expect(Object.keys(p.origin.roles)).toEqual(["review"]);
  expect(() => prepareStart({ cwd, task: "look", template: "builtin:review", params: { rounds: "3" } })).toThrow("unknown parameter");
  expect(() => prepareStart({ cwd, task: "look", template: "builtin:review", roles: { plan: { agent: "pi" } } })).toThrow("unknown role");
});


test("no implicit template: explicit selection or a user-set default is required, before any run is created", () => {
  const { cwd, root } = fixture();
  expect(() => prepareStart({ cwd, task: "look" })).toThrow("No default template");
  expect(() => prepareStart({ cwd, task: "look" })).toThrow("Available templates:");
  const r = Bun.spawnSync(["bun", "src/cli.ts", "start", "--task", "look", "--cwd", cwd], { cwd: import.meta.dir + "/..", env: { ...process.env, SFLOW_NO_UPDATE_CHECK: "1" } });
  expect(r.exitCode).not.toBe(0); expect(r.stderr.toString()).toContain("template use");
  expect(() => readFileSync(join(root, "state", "runs"))).toThrow();
  setDefault(cwd, "project", "builtin:review");
  expect(prepareStart({ cwd, task: "look" }).origin.template).toBe("review");
});

test("start requires explicit in-place authorization each time and transforms worktree owners", async () => {
  const { checked } = await import("../src/process"); const { cwd } = fixture();
  await checked(["git", "init", "-q", cwd]);
  const p = prepareStart({ cwd, task: "fixture", template: "builtin:dev", write: true, inPlace: true });
  expect(p.workflow.steps.find(s => s.id === "implement")!.inPlace).toBe(true);
  expect(p.workflow.steps.find(s => s.id === "implement")!.worktree).toBeUndefined();
  const t = { version: 1, kind: "sflow-template", name: "direct", params: {}, roles: { implement: { agent: "codex" } }, steps: [{ id: "write", role: "implement", cwd: ".", prompt: "{{task}}", policy: "workspace-write", inPlace: true }] };
  const file = join(cwd, "direct.json"); writeJSON(file, t); createTemplate("direct", file, cwd, "project");
  expect(() => prepareStart({ cwd, template: "direct", task: "fixture", write: true })).toThrow("--in-place");
  expect(prepareStart({ cwd, template: "direct", task: "fixture", write: true, inPlace: true }).workflow.steps[0].inPlace).toBe(true);
  expect(() => prepareStart({ cwd, template: "builtin:review", task: "fixture", inPlace: true })).toThrow("write template");
});

test("templates carry command steps and hosts; --host overrides a step's host", () => {
  const { cwd } = fixture();
  // A step with a host needs cwd inside a Git checkout with a commit.
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]])
    expect(Bun.spawnSync(["git", "-C", cwd, ...args]).exitCode).toBe(0);
  saved(cwd, { ...template(), steps: [
    { id: "look", role: "fix", cwd: ".", prompt: "Task {{task}}", host: "box" },
    { id: "test", cwd: ".", dependsOn: ["look"], command: ["bun", "test"], artifacts: ["out.txt"], host: ["box", "mini"] },
  ] });
  const plan = prepareStart({ cwd, task: "x", template: "simple", hosts: { test: ["mini"] } });
  const [look, run] = plan.workflow.steps;
  expect(look.host).toEqual(["box"]); expect(look.agent).toBe("codex");
  expect(run.agent).toBe("command"); expect(run.command).toEqual(["bun", "test"]); expect(run.host).toEqual(["mini"]);
  expect(plan.sources["steps.test.host"]).toBe("CLI --host");
  expect(() => prepareStart({ cwd, task: "x", template: "simple", hosts: { nope: ["mini"] } })).toThrow("unknown step nope");
  expect(() => parseTemplate({ ...template(), steps: [{ id: "c", role: "fix", cwd: ".", command: ["true"] }] })).toThrow("no role");
});

test("templates preserve explicit command input mode in the frozen workflow", () => {
  const { cwd } = fixture(), t = template() as any;
  t.steps.push({ id: "probe", command: ["uname", "-a"], input: "none", cwd: ".", dependsOn: ["look"] });
  saved(cwd, t);
  const plan = prepareStart({ cwd, task: "inspect", template: "simple" });
  expect(plan.workflow.steps[1]).toMatchObject({ agent: "command", input: "none" });
  const run = createRun(plan.workflow, plan.origin); dirs.push(join(run.socket, ".."));
  expect(run.version).toBe(5);
  expect(loadRun(run.id).workflow.steps[1].input).toBe("none");
});
