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

const cli = import.meta.path.includes("$bunfs") ? [process.execPath] : [process.execPath, import.meta.path];
const transport = new OcsTransport(), runtime = new TmuxRuntime(cli);
const args = process.argv.slice(2);
function print(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
function publicRun(run: ReturnType<typeof loadRun>) {
  return { version: run.version, id: run.id, name: run.workflow.name, status: run.status, channel: run.channel,
    steps: Object.fromEntries(Object.entries(run.steps).map(([id, { token: _, ...state }]) => [id, state])) };
}
async function main() {
  const [cmd, arg, ...rest] = args;
  if (!cmd || cmd === "help" || cmd === "--help") {
    console.log(`Session Flow 0.1.0 — native agent sessions, connected by OCS

sflow validate <workflow.json>       validate without starting agents
sflow run <workflow.json>            create workers and drive the workflow
sflow resume <run-id>                reconcile and continue; never recreate uncertain workers
sflow status <run-id>                reconcile explicit worker reports, print JSON
sflow attach <run-id> <step-id>       inspect/interact with one owned native session
sflow logs <run-id> <step-id>         capture its terminal output
sflow stop <run-id>                  stop only this run's workers; retain artifacts
sflow task                          worker: read assignment and report acceptance
sflow report --file <result.json>    worker: report done/blocked/failed
sflow report --json '<JSON>'         worker: report without writing a file
sflow version

Claude/Codex authenticate through their own CLIs. No orcr or Herdr required.
Native tmux adapter currently supports macOS/Linux. Ctrl-C stops the driver,
leaves workers running, and allows resume. Keep run IDs for recovery.`); return;
  }
  if (cmd === "version") { console.log("0.1.0"); return; }
  if (cmd === "task") { if (arg) throw new Error("task takes no arguments"); print(await workerTask(transport)); return; }
  if (cmd === "report") {
    if (!["--file", "--json"].includes(arg) || rest.length !== 1) throw new Error("report --file <result.json> or --json '<JSON>'");
    print(await workerReport(transport, JSON.parse(arg === "--file" ? readFileSync(rest[0], "utf8") : rest[0] === "-" ? readFileSync(0, "utf8") : rest[0]))); return;
  }
  if (cmd === "validate" || cmd === "run") {
    if (!arg || rest.length) throw new Error(`${cmd} <workflow.json>`);
    const file = resolve(arg), workflow = parseWorkflow(JSON.parse(readFileSync(file, "utf8")), dirname(file));
    if (cmd === "validate") { print({ valid: true, workflow }); return; }
    if (process.platform === "win32") throw new Error("tmux adapter requires macOS/Linux");
    await checked([runtime.binary, "-V"]); await checked([transport.binary, "version"]);
    for (const agent of new Set(workflow.steps.map(s => s.agent))) if (!Bun.which(agent)) throw new Error(`${agent} is not installed`);
    const run = createRun(workflow); print({ runId: run.id, channel: run.channel });
    const unlock = lockRun(run);
    try { await drive(run, runtime, transport); } finally { unlock(); }
    print(publicRun(run)); if (run.status !== "done") { console.error(`Inspect logs/attach, then: sflow resume ${run.id}`); process.exitCode = 2; } return;
  }
  if (!arg) throw new Error("run id required");
  const run = loadRun(arg);
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
  if (rest.length) throw new Error("unexpected arguments");
  if (cmd === "status") {
    // Read-only observer; the driver owns durable state mutations.
    reconcile(run, await transport.read(run.channel, `sflow-${run.id}`)); print(publicRun(run)); return;
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
      run.status = "running"; await drive(run, runtime, transport);
    }
  } finally { unlock(); }
  print(publicRun(run)); if (String(run.status) !== "done" && cmd === "resume") { console.error(`Inspect logs/attach, then: sflow resume ${run.id}`); process.exitCode = 2; }
}
main().catch(e => { console.error(`sflow: ${e.message ?? e}`); process.exitCode = 1; });
