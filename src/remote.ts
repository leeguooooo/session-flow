import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
import { cpus, homedir, hostname, loadavg } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { atomicWrite, dataHome, loadRun, saveRun } from "./store";
import { checked, command } from "./process";
import { bareRepo, ensureBare, freeze, verifyCommit } from "./gitsync";
import { REMOTE_PROTOCOL, type Hello } from "./hosts";
import { OcsTransport } from "./ocs";
import { TmuxRuntime } from "./runtime";
import { sessionRoot } from "./config";
import { AGENTS, type Run, type Step, type StepState } from "./types";

// The host side of `ssh <host> sflow remote <op>`: JSON in on stdin, JSON (or raw bytes) out.
const JOB = /^[0-9a-f-]{36}-[a-z][a-z0-9-]{0,39}$/;
const RUN = /^[0-9a-f-]{36}$/;
const STEP = /^[a-z][a-z0-9-]{0,39}$/;

// ssh runs a non-login shell; tools installed per user are not on its PATH.
export function widenPath() {
  const extra = [join(homedir(), ".local/bin"), join(homedir(), ".bun/bin"), "/opt/homebrew/bin", "/usr/local/bin"];
  const have = (process.env.PATH ?? "").split(":");
  process.env.PATH = [...have, ...extra.filter(p => !have.includes(p))].join(":");
}
function freeGB(path: string): number {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const s = statfsSync(path); return (Number(s.bavail) * Number(s.bsize)) / 1e9;
}
function jobDir(id: string) { if (!JOB.test(id)) throw new Error("invalid job id"); return join(dataHome(), "jobs", id); }
function readJSON(path: string): any { try { return JSON.parse(readFileSync(path, "utf8")); } catch { return undefined; } }
function alive(pid: unknown): boolean {
  if (typeof pid !== "number" || pid < 2) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// Slots: slots/<n> claimed with an exclusive mkdir, shared by every driver using this host.
function slotsDir() { const d = join(dataHome(), "slots"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
function slotOwners(): { slot: string; owner: string; since?: number }[] {
  return readdirSync(slotsDir()).map(slot => {
    const o = readJSON(join(slotsDir(), slot, "owner.json"));
    return { slot, owner: o?.owner ?? "", since: o?.since };
  });
}
// A job slot is free again once its job has exited or its runner died; a step slot only when released.
function stale(owner: string, slot: string): boolean {
  if (!owner) return Date.now() - statSync(join(slotsDir(), slot)).mtimeMs > 60_000;
  if (!owner.startsWith("job:")) return false;
  const dir = jobDir(owner.slice(4));
  if (existsSync(join(dir, "exit.json"))) return true;
  const runner = readJSON(join(dir, "runner.json"));
  return !!runner && !alive(runner.pid);
}
export function claimSlot(owner: string, slots: number): boolean {
  const dir = slotsDir();
  if (slotOwners().some(s => s.owner === owner)) return true;
  for (let i = 0; i < slots; i++) {
    const path = join(dir, String(i));
    if (existsSync(path)) {
      const o = readJSON(join(path, "owner.json"))?.owner ?? "";
      if (!stale(o, String(i))) continue;
      rmSync(path, { recursive: true, force: true });
    }
    try { mkdirSync(path, { mode: 0o700 }); } catch { continue; }
    writeFileSync(join(path, "owner.json"), JSON.stringify({ owner, since: Date.now() }), { mode: 0o600 });
    return true;
  }
  return false;
}
export function releaseSlot(owner: string) {
  for (const s of slotOwners()) if (s.owner === owner) rmSync(join(slotsDir(), s.slot), { recursive: true, force: true });
}

export function hello(version: string): Hello {
  const tools = Object.fromEntries(["tmux", "ocs", "git", ...AGENTS].map(t => [t, Bun.which(t, { PATH: process.env.PATH })]));
  return { protocol: REMOTE_PROTOCOL, version, home: dataHome(), arch: process.arch, platform: process.platform,
    cpus: cpus().length, load: loadavg()[0], freeGB: freeGB(dataHome()), tools,
    slots: slotOwners().map(({ owner, since }) => ({ owner, since })) };
}

// ---- command jobs ----
interface JobSpec { jobId: string; repo: string; commit: string; tree: string; argv: string[]; artifacts: string[]; slots: number }
function jobSpec(o: any): JobSpec {
  if (!o || !JOB.test(o.jobId)) throw new Error("invalid job id");
  if (!Array.isArray(o.argv) || !o.argv.length || o.argv.some((a: unknown) => typeof a !== "string")) throw new Error("invalid argv");
  if (!Array.isArray(o.artifacts) || o.artifacts.some((a: unknown) => typeof a !== "string" || !safeRelative(a as string))) throw new Error("invalid artifacts");
  if (!Number.isInteger(o.slots) || o.slots < 1) throw new Error("invalid slots");
  bareRepo(dataHome(), o.repo);
  return { jobId: o.jobId, repo: o.repo, commit: o.commit, tree: o.tree, argv: o.argv, artifacts: o.artifacts, slots: o.slots };
}
export function safeRelative(p: string): boolean {
  return !!p && !isAbsolute(p) && !p.split("/").some(x => x === ".." ) && !p.includes("\0");
}
export function jobStart(input: unknown, self: string[]) {
  const spec = jobSpec(input), dir = jobDir(spec.jobId);
  if (existsSync(dir)) return { state: "exists" };
  if (!claimSlot(`job:${spec.jobId}`, spec.slots)) return { state: "busy" };
  mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
  try { mkdirSync(dir, { mode: 0o700 }); } catch { releaseSlot(`job:${spec.jobId}`); return { state: "exists" }; }
  atomicWrite(join(dir, "spec.json"), spec);
  // The runner outlives this ssh call: its own session, no inherited pipes.
  const log = openSync(join(dir, "runner.log"), "a", 0o600);
  const child = spawn(self[0], [...self.slice(1), "remote", "job-exec", spec.jobId], { detached: true, stdio: ["ignore", log, log], cwd: dir });
  closeSync(log);
  atomicWrite(join(dir, "runner.json"), { pid: child.pid });
  child.unref();
  return { state: "claimed" };
}
function hashFile(path: string) { const b = readFileSync(path); return { sha256: createHash("sha256").update(b).digest("hex"), bytes: b.length }; }
// Declared artifacts: files (or files under a directory) inside the checkout, never through a symlink out of it.
function collect(work: string, out: string, wanted: string[]) {
  const files: { path: string; sha256: string; bytes: number }[] = [], missing: { path: string; error: string }[] = [];
  const realWork = realpathSync(work);
  const add = (rel: string) => {
    const full = join(work, rel);
    let real: string;
    try { real = realpathSync(full); } catch { missing.push({ path: rel, error: "not found" }); return; }
    const inside = relative(realWork, real);
    if (inside.startsWith("..") || isAbsolute(inside)) { missing.push({ path: rel, error: "resolves outside the checkout" }); return; }
    const st = lstatSync(full);
    if (st.isSymbolicLink()) { missing.push({ path: rel, error: "is a symlink" }); return; }
    if (st.isDirectory()) { for (const e of readdirSync(full)) add(join(rel, e)); return; }
    if (!st.isFile()) { missing.push({ path: rel, error: "not a regular file" }); return; }
    const dest = join(out, rel); mkdirSync(dirname(dest), { recursive: true, mode: 0o700 }); copyFileSync(full, dest);
    files.push({ path: rel, ...hashFile(dest) });
  };
  for (const w of wanted) add(w.replace(/\/+$/, ""));
  return { files, missing };
}
export async function jobExec(id: string) {
  const dir = jobDir(id), spec = jobSpec(readJSON(join(dir, "spec.json")));
  const work = join(dir, "work"), bare = bareRepo(dataHome(), spec.repo);
  const finish = (exit: Record<string, unknown>) => { atomicWrite(join(dir, "exit.json"), { ...exit, finishedAt: Date.now() }); releaseSlot(`job:${id}`); };
  try {
    await verifyCommit(bare, spec.commit, spec.tree);
    await checked(["git", "-C", bare, "worktree", "add", "--quiet", "--detach", work, spec.commit], { timeoutMs: 600_000 });
  } catch (e) { finish({ code: null, signal: null, error: `checkout failed: ${(e as Error).message}` }); return; }
  const log = openSync(join(dir, "log.txt"), "a", 0o600);
  let child;
  try { child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: work, detached: true, stdio: ["ignore", log, log], env: process.env }); }
  finally { closeSync(log); }
  const exited = new Promise<{ code: number | null; signal: string | null; error?: string }>(res => {
    child.on("error", e => res({ code: null, signal: null, error: `cannot start ${spec.argv[0]}: ${e.message}` }));
    child.on("exit", (code, signal) => res({ code, signal }));
  });
  if (child.pid) atomicWrite(join(dir, "started.json"), { pid: child.pid, pgid: child.pid, startedAt: Date.now(), host: hostname(), arch: process.arch, platform: process.platform });
  const result = await exited;
  try {
    const out = collect(work, join(dir, "out"), spec.artifacts);
    atomicWrite(join(dir, "artifacts.json"), out);
  } catch (e) { atomicWrite(join(dir, "artifacts.json"), { files: [], missing: [{ path: "*", error: (e as Error).message }] }); }
  await command(["git", "-C", bare, "worktree", "remove", "--force", work], { timeoutMs: 300_000 }).catch(() => {});
  finish(result);
}
export function jobStatus(input: any) {
  const dir = jobDir(input?.jobId);
  if (!existsSync(dir)) return { state: "missing" };
  const exit = readJSON(join(dir, "exit.json")), started = readJSON(join(dir, "started.json")), runner = readJSON(join(dir, "runner.json"));
  const cancel = readJSON(join(dir, "cancel.json"));
  if (exit) return { state: "exited", exit, started, artifacts: readJSON(join(dir, "artifacts.json")), ...(cancel ? { cancel } : {}) };
  if (runner && !alive(runner.pid)) return { state: "lost", started, ...(cancel ? { cancel } : {}), error: "the job runner died without recording an exit" };
  return { state: started ? "running" : "claimed", started, ...(cancel ? { cancel } : {}) };
}
export function jobCancel(input: any) {
  const dir = jobDir(input?.jobId);
  if (!existsSync(dir)) return { signalled: false, state: "missing" };
  if (existsSync(join(dir, "exit.json"))) return { signalled: false, state: "exited" };
  const started = readJSON(join(dir, "started.json"));
  atomicWrite(join(dir, "cancel.json"), { at: Date.now(), reason: String(input?.reason ?? "cancelled") });
  if (!started?.pgid) return { signalled: false, state: "claimed" };
  // Only this job's own process group.
  try { process.kill(-started.pgid, input?.force ? "SIGKILL" : "SIGTERM"); return { signalled: true, state: "running" }; }
  catch { return { signalled: false, state: "running" }; }
}
export function jobFile(input: any): string {
  const dir = jobDir(input?.jobId);
  if (input?.kind === "log") return join(dir, "log.txt");
  if (input?.kind === "artifact" && typeof input.path === "string" && safeRelative(input.path)) {
    const p = join(dir, "out", input.path), st = lstatSync(p);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a collected artifact");
    return p;
  }
  throw new Error("kind must be log or artifact");
}

// ---- agent steps: a mirror of the driver's run, holding only this host's steps ----
function mirrorRun(id: string): Run {
  if (!RUN.test(id)) throw new Error("invalid run id");
  const run = loadRun(id);
  if (!run.mirror) throw new Error("not a mirrored run");
  return run;
}
function checkoutsDir(runId: string) { return join(dataHome(), "checkouts", runId); }
interface Checkout { repo: string; commit: string; tree: string; name: string; branch?: string }
async function checkout(runId: string, c: Checkout): Promise<string> {
  if (!/^[a-z0-9-]{1,80}$/.test(c.name)) throw new Error("invalid checkout name");
  const bare = bareRepo(dataHome(), c.repo), path = join(checkoutsDir(runId), c.name);
  await verifyCommit(bare, c.commit, c.tree);
  if (existsSync(path)) {
    const head = (await checked(["git", "-C", path, "rev-parse", "HEAD"])).trim();
    if (head !== c.commit) throw new Error(`${path} exists at ${head}, expected ${c.commit}`);
    return path;
  }
  mkdirSync(checkoutsDir(runId), { recursive: true, mode: 0o700 });
  const args = c.branch ? ["-b", c.branch] : ["--detach"];
  await checked(["git", "-C", bare, "worktree", "add", "--quiet", ...args, path, c.commit], { timeoutMs: 600_000 });
  return realpathSync(path);
}
export async function prepare(input: any) {
  const run = input?.run as Run, stepId = input?.stepId as string;
  if (!run || !RUN.test(run.id) || !STEP.test(stepId)) throw new Error("invalid prepare request");
  const dir = join(dataHome(), "runs", run.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketDir = join(process.env.TMPDIR ?? "/tmp", `sf-${run.id.slice(0, 12)}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const existing = existsSync(join(dir, "run.json")) ? loadRun(run.id) : undefined;
  if (existing && !existing.mirror) throw new Error("a run with this id is driven on this host; refusing to mirror over it");
  const step = run.workflow.steps.find(s => s.id === stepId);
  if (!step) throw new Error("step missing from mirror");
  const root = sessionRoot(run.workflow.steps, step);
  if (!claimSlot(`step:${run.id}:${root}`, Number(input.slots))) return { state: "busy" };
  // Checkouts the step reads or writes, then remote paths for every driver path they replace.
  const pathMap: Record<string, string> = {};
  for (const c of (input.checkouts ?? []) as (Checkout & { local: string })[]) pathMap[c.local] = await checkout(run.id, c);
  const mirror: Run = { ...existing, ...run, dir, socket: join(socketDir, "tmux.sock"), mirror: { driver: String(input.driver ?? "") },
    steps: { ...(existing?.steps ?? {}), ...run.steps } };
  mirror.workflow = { ...run.workflow, steps: run.workflow.steps.map(s => {
    const prev = existing?.workflow.steps.find(x => x.id === s.id);
    return s.id === stepId ? { ...s, cwd: pathMap[s.cwd] ?? s.cwd } : prev ?? s;
  }) };
  saveRun(mirror);
  return { state: "ready", dir, cwd: pathMap[step.cwd] ?? step.cwd, pathMap };
}
export function updateStep(input: any) {
  const run = mirrorRun(input?.runId), id = input?.stepId;
  if (!run.steps[id]) throw new Error("unknown step");
  const patch = input.state as Partial<StepState>;
  for (const k of ["status", "actor", "result", "lifecycle"] as const) if (patch[k] !== undefined) (run.steps[id] as any)[k] = patch[k];
  saveRun(run); return { ok: true };
}
export function put(input: any) {
  const run = mirrorRun(input?.runId), out: Record<string, string> = {};
  const inbound = join(run.dir, "inbound"); mkdirSync(inbound, { recursive: true, mode: 0o700 });
  for (const f of input.files ?? []) {
    if (typeof f.name !== "string" || !/^[\w.-]{1,120}$/.test(f.name)) throw new Error("invalid file name");
    const body = Buffer.from(String(f.base64), "base64");
    if (createHash("sha256").update(body).digest("hex") !== f.sha256) throw new Error(`${f.name}: hash mismatch on arrival`);
    writeFileSync(join(inbound, f.name), body, { mode: 0o600 }); out[f.name] = join(inbound, f.name);
  }
  return { paths: out };
}
export function runFile(input: any): string {
  const run = mirrorRun(input?.runId), p = resolve(String(input?.path ?? ""));
  const inside = relative(run.dir, p);
  if (inside.startsWith("..") || isAbsolute(inside)) throw new Error("path outside the run");
  const st = lstatSync(p);
  if (!st.isFile() || st.isSymbolicLink()) throw new Error("not a regular file");
  return p;
}
// The remote write step's worktree against the commit it started from, untracked files included.
export async function patchFile(input: any): Promise<string> {
  const run = mirrorRun(input?.runId), step = run.workflow.steps.find(s => s.id === input?.stepId) as Step | undefined;
  if (!step || step.policy !== "workspace-write") throw new Error("not a write step on this host");
  const root = run.workflow.steps.find(s => s.id === (function r(s: Step): string { return s.workspace ? r(run.workflow.steps.find(x => x.id === s.workspace)!) : s.id; })(step))!;
  const base = String(input.base);
  if (!/^[0-9a-f]{40,64}$/.test(base)) throw new Error("invalid base");
  const tmp = join(run.dir, "tmp"); mkdirSync(tmp, { recursive: true, mode: 0o700 });
  const frozen = await freeze(root.cwd, "", { TMPDIR: tmp });
  const out = join(run.dir, `${step.id}-${frozen.commit.slice(0, 12)}.patch`);
  const diff = await checked(["git", "-C", root.cwd, "diff", "--binary", "--no-ext-diff", "--no-textconv", base, frozen.commit], { timeoutMs: 300_000 });
  writeFileSync(out, diff, { mode: 0o600 });
  return out;
}
export async function rt(input: any, cli: string[]) {
  const run = mirrorRun(input?.runId), id = input?.stepId as string;
  if (!run.steps[id]) throw new Error("unknown step");
  const runtime = new TmuxRuntime(cli), step = run.workflow.steps.find(s => s.id === id)!;
  switch (input.action) {
    case "create": await runtime.create(run, step); saveRun(run); return { ok: true, cwd: run.steps[id].cwd };
    case "continue": await runtime.continue(run, step); saveRun(run); return { ok: true };
    case "exists": return { exists: await runtime.exists(run, id) };
    case "stop": {
      await runtime.stop(run, id);
      releaseSlot(`step:${run.id}:${sessionRoot(run.workflow.steps, step)}`);
      return { ok: true };
    }
    case "screen": return { screen: await runtime.screen(run, id) };
    case "keys": await runtime.keys(run, id, (input.keys as string[]).map(String)); return { ok: true };
    default: throw new Error("unknown runtime action");
  }
}
export async function cleanup(input: any) {
  const run = mirrorRun(input?.runId);
  for (const s of slotOwners()) if (s.owner.startsWith(`step:${run.id}:`)) releaseSlot(s.owner);
  const dir = checkoutsDir(run.id);
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const common = (await command(["git", "-C", path, "rev-parse", "--git-common-dir"])).stdout.trim();
    if (common) await command(["git", "-C", common, "worktree", "remove", "--force", path], { timeoutMs: 300_000 });
    rmSync(path, { recursive: true, force: true });
  }
  return { ok: true };
}

// The one interactive operation: ssh -t <host> sflow remote attach <run> <step>.
export async function attach(runId: string, stepId: string, cli: string[]) {
  widenPath();
  const run = mirrorRun(runId);
  if (!run.steps[stepId]) throw new Error("unknown step");
  const argv = new TmuxRuntime(cli).attachArgs(run, stepId);
  const child = spawn(argv[0], argv.slice(1), { stdio: "inherit" });
  await new Promise<void>(res => child.on("exit", c => { process.exitCode = c ?? 1; res(); }));
}
// Finished jobs older than the cutoff: their directory and the ref that carried their input.
export async function gc(input: any) {
  const days = Number(input?.days ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new Error("invalid days");
  const root = join(dataHome(), "jobs"), removed: string[] = [];
  if (!existsSync(root)) return { removed };
  for (const id of readdirSync(root)) {
    if (!JOB.test(id)) continue;
    const dir = join(root, id), exit = readJSON(join(dir, "exit.json"));
    if (!exit || Date.now() - Number(exit.finishedAt ?? 0) < days * 86400_000) continue;
    const spec = readJSON(join(dir, "spec.json"));
    if (spec?.repo) await command(["git", "-C", bareRepo(dataHome(), spec.repo), "update-ref", "-d", `refs/sflow/jobs/${id}`]).catch(() => {});
    rmSync(dir, { recursive: true, force: true }); removed.push(id);
  }
  return { removed };
}
export async function serve(op: string, version: string, cli: string[]): Promise<void> {
  widenPath();
  const input = op === "job-exec" ? undefined : JSON.parse((await Bun.stdin.text()) || "{}");
  const out = (v: unknown): void => { process.stdout.write(JSON.stringify(v) + "\n"); };
  // Bun.write(Bun.stdout, file) writes nothing into a pipe; stream it instead.
  const raw = (path: string) => new Promise<void>((res, rej) => {
    const r = createReadStream(path); r.on("error", rej); r.on("end", () => process.stdout.write("", () => res())); r.pipe(process.stdout, { end: false });
  });
  const transport = new OcsTransport();
  switch (op) {
    case "hello": return out(hello(version));
    case "repo": { const path = bareRepo(dataHome(), input.repo); await ensureBare(path); return out({ path }); }
    case "job-start": return out(jobStart(input, cli));
    case "job-exec": return jobExec(process.argv[process.argv.length - 1]);
    case "job-status": return out(jobStatus(input));
    case "job-cancel": return out(jobCancel(input));
    case "job-file": return raw(jobFile(input));
    case "prepare": return out(await prepare(input));
    case "step": return out(updateStep(input));
    case "put": return out(put(input));
    case "file": return raw(runFile(input));
    case "patch": return raw(await patchFile(input));
    case "rt": return out(await rt(input, cli));
    case "send": { const run = mirrorRun(input.runId); await transport.send(run.channel, input.body, `sflow-${run.id}`); return out({ ok: true }); }
    case "read": { const run = mirrorRun(input.runId); return out(await transport.read(run.channel, `sflow-${run.id}`)); }
    case "cleanup": return out(await cleanup(input));
    case "gc": return out(await gc(input));
    case "release": {
      if (!RUN.test(input?.runId) || !STEP.test(input?.root)) throw new Error("invalid release request");
      releaseSlot(`step:${input.runId}:${input.root}`); return out({ ok: true });
    }
    default: throw new Error(`unknown remote operation ${op}`);
  }
}
