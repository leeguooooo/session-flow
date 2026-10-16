import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/config";
import { createRun } from "../src/store";
import { TmuxRuntime } from "../src/runtime";
import { cleanEnv, command } from "../src/process";
import { parseMenu, menuKeys } from "../src/prompt";
import { tmuxWorks } from "./tmux";

const cleanup: string[] = [];
const oldPath = process.env.PATH;
// The fake agent writes its argv after tmux starts it; wait for the file instead of a fixed sleep.
async function readWhenWritten(path: string): Promise<string> {
  for (let i = 0; i < 100; i++) { try { const text = readFileSync(path, "utf8"); if (text) return text; } catch {} await Bun.sleep(50); }
  return readFileSync(path, "utf8");
}
afterEach(() => { process.env.PATH = oldPath; delete process.env.SFLOW_HOME; for (const dir of cleanup.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("inherited runtime identity is removed without discarding auth/config", () => {
  const keys = { TMUX: "existing", TMUX_PANE: "%1", CLAUDECODE: "1", CODEX_THREAD_ID: "parent", SFLOW_TOKEN: "parent", CODEX_HOME: "/config" };
  const original = Object.fromEntries(Object.keys(keys).map(k => [k, process.env[k]])); Object.assign(process.env, keys);
  try { const e = cleanEnv(); expect(e.TMUX).toBeUndefined(); expect(e.CODEX_THREAD_ID).toBeUndefined(); expect(e.SFLOW_TOKEN).toBeUndefined(); expect(e.CODEX_HOME).toBe("/config"); }
  finally { for (const k of Object.keys(keys)) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } }
});
test.skipIf(!tmuxWorks)("real tmux sessions forward model safely and isolate per-worker context", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-runtime-")); cleanup.push(root);
  const bin = join(root, "bin"), project = join(root, "project"); mkdirSync(bin); mkdirSync(project);
  process.env.SFLOW_HOME = join(root, "state"); process.env.PATH = bin + ":" + oldPath;
  const fake = join(bin, "codex");
  writeFileSync(fake, '#!/bin/sh\nprintf "%s\\n" "$@" > "argv-$$.txt"\nwhile :; do sleep 1; done\n'); chmodSync(fake, 0o700);
  const run = createRun(parseWorkflow({ version: 1, name: "native-test", steps: ["first", "second"].map(id => ({ id, agent: "codex", model: "model;$(touch should-not-exist)", cwd: project, prompt: "test" })) }, root));
  cleanup.push(join(run.socket, ".."));
  const rt = new TmuxRuntime(["/bin/true"]);
  try {
    for (const step of run.workflow.steps) { run.steps[step.id].status = "launching"; await rt.create(run, step); }
    await Bun.sleep(100);
    for (const step of run.workflow.steps) {
      expect(await rt.exists(run, step.id)).toBe(true);
      const pid = (await command(["tmux", "-S", run.socket, "display-message", "-p", "-t", run.steps[step.id].session, "#{pane_pid}"])).stdout.trim();
      const argv = await readWhenWritten(join(run.steps[step.id].cwd!, `argv-${pid}.txt`));
      expect(argv).toContain("model;$(touch should-not-exist)"); expect(argv).not.toContain("dangerously");
      const wrapper = readFileSync(join(run.dir, step.id, "worker"), "utf8");
      expect(wrapper).toContain(`SFLOW_STEP_ID='${step.id}'`);
      expect(wrapper).toContain(run.steps[step.id].token);
      expect(wrapper).not.toContain(run.steps[step.id === "first" ? "second" : "first"].token);
      const env = await command(["tmux", "-S", run.socket, "show-environment", "-t", run.steps[step.id].session]);
      expect(env.stdout).not.toContain("SFLOW_TOKEN");
    }
    expect(run.steps.first.cwd).toBe(run.steps.second.cwd);
    const firstPrompt = readFileSync(join(run.dir, "first", "bootstrap.txt"), "utf8");
    expect(firstPrompt).toContain(join(run.dir, "first", "worker"));
    expect(firstPrompt).not.toContain(join(run.dir, "second", "worker"));
  } finally { for (const step of run.workflow.steps) await rt.stop(run, step.id); }
});

test.skipIf(!tmuxWorks)("pi and agy start their native TUIs with the step's model and policy", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-runtime-")); cleanup.push(root);
  const bin = join(root, "bin"), project = join(root, "project"); mkdirSync(bin); mkdirSync(project);
  process.env.SFLOW_HOME = join(root, "state"); process.env.PATH = bin + ":" + oldPath;
  for (const name of ["pi", "agy"]) { writeFileSync(join(bin, name), '#!/bin/sh\nprintf "%s\\n" "$@" > "argv-$$.txt"\nwhile :; do sleep 1; done\n'); chmodSync(join(bin, name), 0o700); }
  const run = createRun(parseWorkflow({ version: 1, name: "native-test", steps: [
    { id: "p", agent: "pi", model: "provider/model", cwd: project, prompt: "test" },
    { id: "a", agent: "agy", model: "flash", cwd: project, prompt: "test" }] }, root));
  cleanup.push(join(run.socket, ".."));
  const rt = new TmuxRuntime(["/bin/true"]);
  try {
    for (const step of run.workflow.steps) { run.steps[step.id].status = "launching"; await rt.create(run, step); }
    await Bun.sleep(150);
    const argv = async (id: string) => {
      const pid = (await command(["tmux", "-S", run.socket, "display-message", "-p", "-t", run.steps[id].session, "#{pane_pid}"])).stdout.trim();
      return (await readWhenWritten(join(run.steps[id].cwd!, `argv-${pid}.txt`))).split("\n");
    };
    const p = await argv("p"), a = await argv("a");
    expect(p.slice(0, 5)).toEqual(["--exclude-tools", "edit,write", "--model", "provider/model", "--"]);
    expect(a).toContain("--prompt-interactive"); expect(a.slice(a.indexOf("--model"), a.indexOf("--model") + 2)).toEqual(["--model", "flash"]);
    expect(a).toContain(join(run.dir, "a")); expect(a.join(" ")).not.toContain("dangerously");
  } finally { for (const step of run.workflow.steps) await rt.stop(run, step.id); }
});

test("workflows accept pi and agy steps and reject unknown agents", () => {
  const root = mkdtempSync(join(tmpdir(), "sf-config-")); cleanup.push(root);
  const wf = (agent: string) => parseWorkflow({ version: 1, name: "agents", steps: [{ id: "s", agent, cwd: root, prompt: "x" }] }, root);
  expect(wf("pi").steps[0].agent).toBe("pi");
  expect(wf("agy").steps[0].agent).toBe("agy");
  expect(() => wf("hermes")).toThrow("agent must be one of claude, codex, pi, agy");
});

test.skipIf(!tmuxWorks)("a waiting menu is read from the pane and answered with keys", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-runtime-")); cleanup.push(root);
  const bin = join(root, "bin"), project = join(root, "project"); mkdirSync(bin); mkdirSync(project);
  process.env.SFLOW_HOME = join(root, "state"); process.env.PATH = bin + ":" + oldPath;
  writeFileSync(join(bin, "agy"), `#!/bin/sh\nprintf 'Run this command?\\n> 1. Yes, run command\\n  2. No, cancel\\n\\n  Navigate\\n'\nIFS= read -r line\nprintf '%s' "$line" > answered.txt\nwhile :; do sleep 1; done\n`);
  chmodSync(join(bin, "agy"), 0o700);
  const run = createRun(parseWorkflow({ version: 1, name: "native-test", steps: [{ id: "a", agent: "agy", cwd: project, prompt: "test" }] }, root));
  cleanup.push(join(run.socket, ".."));
  const rt = new TmuxRuntime(["/bin/true"]);
  try {
    run.steps.a.status = "launching"; await rt.create(run, run.workflow.steps[0]);
    let menu = null;
    for (let i = 0; i < 100 && !menu; i++) { menu = parseMenu(await rt.screen(run, "a")); if (!menu) await Bun.sleep(50); }
    expect(menu!.options).toEqual(["Yes, run command", "No, cancel"]);
    await rt.keys(run, "a", menuKeys(menu!, 2));
    // A shell `read` sees the arrow as its escape sequence; the TUIs move their selection with it.
    expect(await readWhenWritten(join(run.steps.a.cwd!, "answered.txt"))).toContain("[B");
  } finally { await rt.stop(run, "a"); }
});

test.skipIf(!tmuxWorks)("a read-only Claude step starts in the shared workspace with its project as a working directory", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-runtime-")); cleanup.push(root);
  const bin = join(root, "bin"), project = join(root, "project"); mkdirSync(bin); mkdirSync(project);
  process.env.SFLOW_HOME = join(root, "state"); process.env.PATH = bin + ":" + oldPath;
  writeFileSync(join(bin, "claude"), '#!/bin/sh\nwhile :; do sleep 1; done\n'); chmodSync(join(bin, "claude"), 0o700);
  const run = createRun(parseWorkflow({ version: 1, name: "claude-dirs", steps: [{ id: "look", agent: "claude", cwd: project, prompt: "p" }] }, root));
  cleanup.push(join(run.socket, ".."));
  const rt = new TmuxRuntime(["/bin/true"]);
  try {
    run.steps.look.status = "launching"; await rt.create(run, run.workflow.steps[0]);
    expect(run.steps.look.cwd).toBe(join(root, "state", "workspaces", "claude"));
    const start = readFileSync(join(run.dir, "look", "start.sh"), "utf8");
    expect(start).toContain(`'--add-dir' '${project}'`);
    expect(start).toContain(`'--add-dir' '${run.dir}'`);
  } finally { await rt.stop(run, "look"); }
});

test("Claude may run its worker command with the path quoted or bare", async () => {
  const { allowWorker } = await import("../src/runtime");
  expect(allowWorker("/s/runs/r/look/worker", "'/s/runs/r/look/worker'")).toBe(
    "Bash('/s/runs/r/look/worker' task),Bash('/s/runs/r/look/worker' report *),Bash(/s/runs/r/look/worker task),Bash(/s/runs/r/look/worker report *)");
  expect(allowWorker("/a b/worker", "'/a b/worker'")).toBe("Bash('/a b/worker' task),Bash('/a b/worker' report *)");
});

test.skipIf(!tmuxWorks)("continuation sends the new wrapper to the same native process without creating another session", async () => {
  const root = mkdtempSync(join(tmpdir(), "sf-continue-")); cleanup.push(root);
  const bin = join(root, "bin"), project = join(root, "project"); mkdirSync(bin); mkdirSync(project);
  process.env.SFLOW_HOME = join(root, "state"); process.env.PATH = bin + ":" + oldPath;
  writeFileSync(join(bin, "codex"), '#!/bin/sh\nprintf "%s" "$$" > native-pid\nIFS= read -r line\nprintf "%s" "$line" > continued.txt\nwhile :; do sleep 1; done\n'); chmodSync(join(bin, "codex"), 0o700);
  const r = createRun(parseWorkflow({ version: 1, name: "retained", steps: [
    { id: "first", agent: "codex", cwd: project, prompt: "first" },
    { id: "second", agent: "codex", cwd: project, prompt: "second", dependsOn: ["first"], reuseSession: "first" }] }, root));
  cleanup.push(join(r.socket, "..")); const rt = new TmuxRuntime(["/bin/true"]);
  try {
    r.steps.first.status = "launching"; await rt.create(r, r.workflow.steps[0]);
    const pid = await readWhenWritten(join(r.steps.first.cwd!, "native-pid"));
    r.steps.first.status = "done"; r.steps.second.status = "launching"; await rt.continue(r, r.workflow.steps[1]);
    expect(await readWhenWritten(join(r.steps.second.cwd!, "continued.txt"))).toContain(join(r.dir, "second", "worker"));
    expect(readFileSync(join(r.steps.first.cwd!, "native-pid"), "utf8")).toBe(pid);
    const sessions = await command(["tmux", "-S", r.socket, "list-sessions", "-F", "#{session_name}"]); expect(sessions.stdout.trim().split("\n")).toEqual(["sf-first"]);
    const wrapper = readFileSync(join(r.dir, "second", "worker"), "utf8"); expect(wrapper).toContain(r.steps.second.token); expect(wrapper).not.toContain(r.steps.first.token);
    await rt.stop(r, "second");
    expect(readFileSync(join(r.dir, "first", "terminal.txt"), "utf8")).toContain("Next Session Flow round");
    expect(readFileSync(join(r.dir, "second", "terminal.txt"), "utf8")).toContain("Next Session Flow round");
  } finally { await rt.stop(r, "second"); }
});
