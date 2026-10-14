#!/usr/bin/env bun
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { spawn } from "node:child_process";
import { parseWorkflow } from "./config";
import { createRun, loadRun, lockRun, saveRun } from "./store";
import { OcsTransport } from "./ocs";
import { TmuxRuntime } from "./runtime";
import { drive, reconcile } from "./engine";
import { workerTask, workerReport } from "./worker";
import { checked } from "./process";
import { runMetrics } from "./metrics";
import { resolveResult } from "./results";
import { preflight, requiredTools } from "./preflight";
import { installSkill } from "./skill";
import { parseMenu, menuKeys } from "./prompt";
import { Progress, describe, type ProgressMode } from "./progress";
import { reviewRun, renderReview } from "./review";
import { doctor, renderChecks } from "./doctor";
import { maybeNotice, runUpdateCheck, upgrade, UPDATE_CHECK_COMMAND } from "./upgrade";
import pkg from "../package.json";

const cli = import.meta.path.includes("$bunfs") ? [process.execPath] : [process.execPath, import.meta.path];
const transport = new OcsTransport(), runtime = new TmuxRuntime(cli);
const args = process.argv.slice(2);
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
function publicRun(run: ReturnType<typeof loadRun>, full = false) {
  return { version: run.version, id: run.id, name: run.workflow.name, status: run.status, channel: run.channel,
    steps: Object.fromEntries(Object.entries(run.steps).map(([id, { token: _, result, ...state }]) => [id, {
      ...state, ...(result ? { result: full ? result : { status: result.status, summary: String(result.summary ?? "").slice(0, 384),
        readFullResult: `sflow result ${run.id} ${id}` } } : {}),
      ...(state.startedAt ? { elapsedMs: Math.max(0, (state.finishedAt ?? Date.now()) - state.startedAt) } : {}),
    }])) };
}
// Removes "--name value" from the argument list and returns the value.
function takeFlag(list: string[], name: string): string | undefined {
  const i = list.indexOf(name);
  if (i < 0) return undefined;
  const value = list[i + 1];
  if (value === undefined || value.startsWith("--")) throw new Error(`${name} needs a value`);
  list.splice(i, 2); return value;
}
function progressMode(list: string[]): ProgressMode {
  const mode = takeFlag(list, "--progress") ?? "text";
  if (!["text", "json", "none"].includes(mode)) throw new Error("--progress text|json|none");
  return mode as ProgressMode;
}
// stdout keeps the machine-readable JSON (run id first, final state last); progress goes to stderr.
async function driveWatched(run: ReturnType<typeof loadRun>, mode: ProgressMode) {
  const progress = new Progress(run, runtime, mode); progress.start();
  try { await drive(run, runtime, transport); } finally { await progress.stop(); }
  if (mode === "text") for (const line of renderReview(await reviewRun(run, runtime))) console.error(line);
  else if (mode === "json") console.error(JSON.stringify({ type: "review", ...await reviewRun(run, runtime) }));
}
async function main() {
  const [cmd, arg, ...rest] = args;
  maybeNotice(pkg.version, cmd, cli);
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`Session Flow ${pkg.version} — native agent sessions, connected by OCS

sflow doctor [workflow.json] [--json] check tmux, ocs, agent CLIs and their sign-in (no model calls)
sflow validate <workflow.json>       validate without starting agents
sflow run <workflow.json> [--progress text|json|none]
                                     create workers and drive the workflow; progress on stderr,
                                     typed numbers answer a worker's trust/approval prompt
sflow resume <run-id> [--progress …]  reconcile and continue; never recreate uncertain workers
sflow review <run-id> [--json]        what each step reported, what sflow saw, what is left to do
sflow status <run-id>                reconcile explicit worker reports, print JSON
sflow stats <run-id>                 message counts and context bytes (not tokens)
sflow result <run-id> <step-id>       read one complete result on demand
sflow attach <run-id> <step-id>       inspect/interact with one owned native session
sflow answer <run-id> <step-id> <prompt-id> <n>
                                     choose option n of the prompt status reported
sflow logs <run-id> <step-id>         capture its terminal output
sflow stop <run-id>                  stop only this run's workers; retain artifacts
sflow task                          worker: read assignment and report acceptance
sflow report --file <result.json>    worker: report done/blocked/failed
sflow report --json '<JSON>'         worker: report without writing a file
sflow skill install                 install the sflow skill for Claude Code, Codex, Pi and agy
sflow upgrade [--check|--json]       install the latest release and refresh the skill
sflow version

Claude/Codex authenticate through their own CLIs. No orcr or Herdr required.
Native tmux adapter currently supports macOS/Linux. Ctrl-C stops the driver,
leaves workers running, and allows resume. Keep run IDs for recovery.`); return;
  }
  if (cmd === "version" || cmd === "--version") { console.log(pkg.version); return; }
  if (cmd === UPDATE_CHECK_COMMAND) { await runUpdateCheck(); return; }
  if (cmd === "upgrade") {
    const flags = args.slice(1);
    if (flags.length > 1 || (flags[0] && !["--check", "--json"].includes(flags[0]))) throw new Error("upgrade [--check|--json]");
    process.exitCode = await upgrade(pkg.version, flags[0] === "--check" ? "check" : flags[0] === "--json" ? "json" : "install"); return;
  }
  if (cmd === "skill") {
    if (arg !== "install" || rest.length) throw new Error("skill install");
    for (const path of installSkill()) console.log(`installed ${path}`); return;
  }
  if (cmd === "doctor") {
    const list = args.slice(1), json = list.includes("--json");
    const files = list.filter(a => a !== "--json");
    if (files.length > 1) throw new Error("doctor [workflow.json] [--json]");
    const agents = files[0] ? parseWorkflow(JSON.parse(readFileSync(resolve(files[0]), "utf8")), dirname(resolve(files[0]))).steps.map(s => s.agent) : undefined;
    const checks = await doctor({ tmux: runtime.binary, ocs: transport.binary, agents });
    if (json) print(checks); else console.log(renderChecks(checks).join("\n"));
    if (checks.some(c => c.level === "fail")) process.exitCode = 1; return;
  }
  if (cmd === "task") { if (arg) throw new Error("task takes no arguments"); print(await workerTask(transport)); return; }
  if (cmd === "report") {
    if (!["--file", "--json"].includes(arg) || rest.length !== 1) throw new Error("report --file <result.json> or --json '<JSON>'");
    print(await workerReport(transport, JSON.parse(arg === "--file" ? readFileSync(rest[0], "utf8") : rest[0] === "-" ? readFileSync(0, "utf8") : rest[0]))); return;
  }
  if (cmd === "validate" || cmd === "run") {
    const mode = cmd === "run" ? progressMode(rest) : "none";
    if (!arg || rest.length) throw new Error(`${cmd} <workflow.json>${cmd === "run" ? " [--progress text|json|none]" : ""}`);
    const file = resolve(arg), workflow = parseWorkflow(JSON.parse(readFileSync(file, "utf8")), dirname(file));
    if (cmd === "validate") { for (const line of describe(workflow)) console.error(line); print({ valid: true, workflow }); return; }
    if (process.platform === "win32") throw new Error("tmux adapter requires macOS/Linux");
    await preflight(requiredTools(runtime.binary, transport.binary, workflow.steps.map(s => s.agent)));
    const run = createRun(workflow); print({ runId: run.id, channel: run.channel });
    const unlock = lockRun(run);
    try { await driveWatched(run, mode); } finally { unlock(); }
    print(publicRun(run)); if (run.status !== "done") { console.error(`Answer any prompt in sflow status (or logs/attach), then: sflow resume ${run.id}`); process.exitCode = 2; } return;
  }
  if (!arg) throw new Error("run id required");
  const run = loadRun(arg);
  if (cmd === "result") {
    if (rest.length !== 1 || !run.steps[rest[0]]) throw new Error("valid step id required");
    reconcile(run, await transport.read(run.channel, `sflow-${run.id}`));
    if (!run.steps[rest[0]].result) throw new Error("no terminal result yet");
    print(resolveResult(run, rest[0], run.steps[rest[0]].result!)); return;
  }
  if (cmd === "attach" || cmd === "logs") {
    if (rest.length !== 1 || !run.steps[rest[0]]) throw new Error("valid step id required");
    if (cmd === "logs") {
      const archive = resolve(run.dir, rest[0], "terminal.txt");
      if (!await runtime.exists(run, rest[0]) && existsSync(archive)) { console.log(readFileSync(archive, "utf8")); return; }
      console.log(await checked([runtime.binary, "-S", run.socket, "capture-pane", "-p", "-t", `${run.steps[rest[0]].session}:0.0`, "-S", "-200"])); return;
    }
    const argv = runtime.attachArgs(run, rest[0]);
    const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
    await new Promise<void>((res, rej) => { child.on("error", rej); child.on("exit", c => { process.exitCode = c ?? 1; res(); }); }); return;
  }
  if (cmd === "answer") {
    // The prompt id pins the exact question and options the user saw; a changed screen is refused.
    const [step, id, choice] = rest;
    if (rest.length !== 3 || !run.steps[step]) throw new Error("answer <run-id> <step-id> <prompt-id> <n>");
    if (!await runtime.exists(run, step)) throw new Error(`${step} has no live session`);
    const menu = parseMenu(await runtime.screen(run, step));
    if (!menu) throw new Error(`${step} is not waiting on a prompt now; check sflow status ${run.id}`);
    if (menu.id !== id) throw new Error(`${step} now shows a different prompt (${menu.id}); show it to the user again: ${JSON.stringify(menu)}`);
    const keys = menuKeys(menu, Number(choice));
    await runtime.keys(run, step, keys);
    await Bun.sleep(500);
    const after = parseMenu(await runtime.screen(run, step));
    print({ step, answered: menu.options[Number(choice) - 1], ...(after ? { nextPrompt: after } : {}) }); return;
  }
  const resumeMode = cmd === "resume" ? progressMode(rest) : "none";
  if (cmd === "review") {
    const json = rest[0] === "--json";
    if (rest.length > (json ? 1 : 0)) throw new Error("review <run-id> [--json]");
    reconcile(run, await transport.read(run.channel, `sflow-${run.id}`));
    const review = await reviewRun(run, runtime);
    if (json) print(review); else console.log(renderReview(review).join("\n"));
    return;
  }
  if (rest.length) throw new Error("unexpected arguments");
  if (cmd === "status" || cmd === "stats") {
    // Read-only observer; the driver owns durable state mutations.
    const rows = await transport.read(run.channel, `sflow-${run.id}`);
    reconcile(run, rows);
    if (cmd === "stats") { print(runMetrics(run, rows)); return; }
    const view = publicRun(run);
    for (const [step, state] of Object.entries(run.steps)) {
      if (!state.session || ["done", "failed", "blocked", "cancelled"].includes(state.status)) continue;
      try {
        if (!await runtime.exists(run, step)) continue;
        const menu = parseMenu(await runtime.screen(run, step));
        if (menu) Object.assign(view.steps[step], { prompt: { ...menu, answer: `sflow answer ${run.id} ${step} ${menu.id} <n>` } });
      } catch {}
    }
    print(view); return;
  }
  if (cmd !== "resume" && cmd !== "stop") throw new Error(`unknown command: ${cmd}`);
  if (cmd === "stop") {
    const lock = resolve(run.dir, "driver.lock");
    if (existsSync(lock)) {
      const pid = Number(readFileSync(lock, "utf8"));
      let live = false;
      try { process.kill(pid, 0); live = true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      if (live) {
        writeFileSync(resolve(run.dir, "cancel.request"), "cancel\n", { mode: 0o600 });
        for (let i = 0; i < 30; i++) {
          await Bun.sleep(500); const current = loadRun(run.id);
          if (current.status === "cancelled") { print(publicRun(current)); return; }
          try { process.kill(pid, 0); } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
            const fresh = loadRun(run.id), release = lockRun(fresh);
            try {
              for (const step of fresh.workflow.steps) { await runtime.stop(fresh, step.id); if (fresh.steps[step.id].status !== "done") fresh.steps[step.id].status = "cancelled"; }
              fresh.status = "cancelled"; saveRun(fresh); print(publicRun(fresh)); return;
            } finally { release(); }
          }
        }
        throw new Error("cancellation requested; driver has not confirmed it yet");
      }
    }
  }
  const unlock = lockRun(run);
  try {
    if (cmd === "stop") {
      for (const step of run.workflow.steps) {
        await runtime.stop(run, step.id);
        if (run.steps[step.id].status !== "done") run.steps[step.id].status = "cancelled";
      }
      run.status = "cancelled"; saveRun(run);
    } else {
      if (run.status === "cancelled") throw new Error("cancelled runs cannot be resumed");
      if (existsSync(resolve(run.dir, "cancel.request"))) throw new Error("cancellation is pending; run sflow stop to finish cancelling before starting a new run");
      run.status = "running"; await driveWatched(run, resumeMode);
    }
  } finally { unlock(); }
  print(publicRun(run)); if (String(run.status) !== "done" && cmd === "resume") { console.error(`Answer any prompt in sflow status (or logs/attach), then: sflow resume ${run.id}`); process.exitCode = 2; }
}
main().catch(e => { console.error(`sflow: ${e.message ?? e}`); process.exitCode = 1; });
