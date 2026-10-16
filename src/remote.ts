import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, closeSync, copyFileSync, renameSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, statfsSync, writeFileSync } from "node:fs";
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

// One lock per host serialises every journal and slot decision: claims, starts, cancels, releases.
// flock(2) on a file that is never removed: the kernel drops it when its holder exits, so there
// is no stale-lock reclaim (and no reclaim race). Our fds are close-on-exec, so spawned jobs do not
// inherit it.
let libc: { flock(fd: number, op: number): number } | undefined;
function flock(fd: number, op: number): number {
  if (!libc) {
    const { dlopen, FFIType } = require("bun:ffi") as typeof import("bun:ffi");
    const lib = dlopen(process.platform === "darwin" ? "/usr/lib/libSystem.B.dylib" : "libc.so.6",
      { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
    libc = { flock: (f, o) => lib.symbols.flock(f, o) as number };
  }
  return libc.flock(fd, op);
}
const LOCK_EX = 2, LOCK_NB = 4, LOCK_UN = 8;
export async function withLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const dir = join(dataHome(), "locks"); mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = openSync(join(dir, "journal.lock"), "a", 0o600), deadline = Date.now() + 60_000;
  try {
    while (flock(fd, LOCK_EX | LOCK_NB) !== 0) {
      if (Date.now() > deadline) throw new Error("the host's sflow journal lock is held too long; try again");
      await Bun.sleep(15);
    }
    try { return await fn(); } finally { flock(fd, LOCK_UN); }
  } finally { closeSync(fd); }
}
function groupAlive(pgid: unknown): boolean {
  if (typeof pgid !== "number" || pgid < 2) return false;
  try { process.kill(-pgid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === "EPERM"; }
}

// Slots: slots/<n>, changed only under the journal lock, shared by every driver using this host.
function slotsDir() { const d = join(dataHome(), "slots"); mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
function slotOwners(): { slot: string; owner: string; since?: number }[] {
  return readdirSync(slotsDir()).filter(slot => /^\d+$/.test(slot)).map(slot => {
    const o = readJSON(join(slotsDir(), slot, "owner.json"));
    return { slot, owner: o?.owner ?? "", since: o?.since };
  });
}
// A job's slot is free only when its exit is recorded, or when neither its runner nor the command's
// process group is alive. Anything unknown keeps the slot; a step's slot is freed only by release.
function stale(owner: string): boolean {
  if (!owner.startsWith("job:")) return false;
  const dir = jobDir(owner.slice(4));
  if (existsSync(join(dir, "exit.json")) || existsSync(join(dir, "tombstone.json"))) return true;
  const runner = readJSON(join(dir, "runner.json")), started = readJSON(join(dir, "started.json"));
  if (!runner || alive(runner.pid)) return false;
  if (started) return !groupAlive(started.pgid);
  // The runner died; a command may have started after its last record. Only a cancel recorded
  // before any start proves nothing runs.
  return existsSync(join(dir, "cancel.json"));
}
// "held": this owner already had a slot (a retained session); "new": claimed now; false: none free.
type Claim = { kind: "held" | "new"; slot: number };
// prefer: slot numbers to try first (where this project already has a trusted write directory).
function claimLocked(owner: string, slots: number, prefer: number[] = []): Claim | false {
  const mine = slotOwners().find(s => s.owner === owner);
  if (mine) {
    // A renewed claim restarts gc's grace period: the driver is using this slot again.
    writeFileSync(join(slotsDir(), mine.slot, "owner.json"), JSON.stringify({ owner, since: Date.now() }), { mode: 0o600 });
    return { kind: "held", slot: Number(mine.slot) };
  }
  const order = [...new Set([...prefer.filter(n => Number.isInteger(n) && n >= 0 && n < slots), ...Array.from({ length: slots }, (_, n) => n)])];
  for (const i of order) {
    const path = join(slotsDir(), String(i));
    if (existsSync(path)) {
      if (!stale(readJSON(join(path, "owner.json"))?.owner ?? "")) continue;
      rmSync(path, { recursive: true, force: true });
    }
    mkdirSync(path, { mode: 0o700 });
    writeFileSync(join(path, "owner.json"), JSON.stringify({ owner, since: Date.now() }), { mode: 0o600 });
    return { kind: "new", slot: i };
  }
  return false;
}
export async function claimSlot(owner: string, slots: number) { const c = await withLock(() => claimLocked(owner, slots)); return c ? c.kind : false; }
function claimSlotAt(owner: string, slots: number, prefer: number[]) { return withLock(() => claimLocked(owner, slots, prefer)); }
function releaseLocked(owner: string) {
  for (const s of slotOwners()) if (s.owner === owner) rmSync(join(slotsDir(), s.slot), { recursive: true, force: true });
}
export function releaseSlot(owner: string) { return withLock(() => releaseLocked(owner)); }

export function hello(version: string): Hello {
  const tools = Object.fromEntries(["tmux", "ocs", "git", ...AGENTS].map(t => [t, Bun.which(t, { PATH: process.env.PATH })]));
  return { protocol: REMOTE_PROTOCOL, capabilities: ["command-input-none", "command-check"], version, home: dataHome(), arch: process.arch, platform: process.platform,
    cpus: cpus().length, load: loadavg()[0], freeGB: freeGB(dataHome()), tools,
    slots: slotOwners().map(({ owner, since }) => ({ owner, since })) };
}

// ---- command jobs ----
interface JobSpec { jobId: string; input?: "none" | "snapshot"; repo?: string; commit?: string; tree?: string; argv: string[]; artifacts: string[]; slots: number; cwd: string }
function jobSpec(o: any): JobSpec {
  if (!o || !JOB.test(o.jobId)) throw new Error("invalid job id");
  if (!Array.isArray(o.argv) || !o.argv.length || o.argv.some((a: unknown) => typeof a !== "string")) throw new Error("invalid argv");
  if (!Array.isArray(o.artifacts) || o.artifacts.some((a: unknown) => typeof a !== "string" || !safeRelative(a as string))) throw new Error("invalid artifacts");
  if (!Number.isInteger(o.slots) || o.slots < 1) throw new Error("invalid slots");
  const cwd = o.cwd ?? ".";
  if (typeof cwd !== "string" || (cwd !== "." && !safeRelative(cwd))) throw new Error("invalid cwd");
  if (o.input !== undefined && o.input !== "snapshot" && o.input !== "none") throw new Error("invalid input mode");
  if (o.input === "none") {
    if (o.repo !== undefined || o.commit !== undefined || o.tree !== undefined || o.artifacts.length || cwd !== ".") throw new Error("input: none needs an empty directory, without snapshot or artifacts");
    return { jobId: o.jobId, input: "none", argv: o.argv, artifacts: [], slots: o.slots, cwd: "." };
  }
  bareRepo(dataHome(), o.repo);
  return { jobId: o.jobId, repo: o.repo, commit: o.commit, tree: o.tree, argv: o.argv, artifacts: o.artifacts, slots: o.slots, cwd };
}
export function safeRelative(p: string): boolean {
  return !!p && !isAbsolute(p) && !p.split("/").some(x => x === "..") && !p.includes("\0");
}
// Claims the job id and a slot together; a job id is started at most once, ever (gc keeps a tombstone).
export async function jobStart(input: unknown, self: string[]) {
  const spec = jobSpec(input), dir = jobDir(spec.jobId);
  return withLock(() => {
    if (existsSync(dir)) return { state: "exists" };
    if (!claimLocked(`job:${spec.jobId}`, spec.slots)) return { state: "busy" };
    mkdirSync(dirname(dir), { recursive: true, mode: 0o700 });
    mkdirSync(dir, { mode: 0o700 });
    atomicWrite(join(dir, "spec.json"), spec);
    // The runner outlives this ssh call: its own session, no inherited pipes.
    const log = openSync(join(dir, "runner.log"), "a", 0o600);
    const child = spawn(self[0], [...self.slice(1), "remote", "job-exec", spec.jobId], { detached: true, stdio: ["ignore", log, log], cwd: dir });
    closeSync(log);
    atomicWrite(join(dir, "runner.json"), { pid: child.pid });
    child.unref();
    return { state: "claimed" };
  });
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
  const work = join(dir, "work"), bare = spec.input === "none" ? undefined : bareRepo(dataHome(), spec.repo!);
  const clean = async () => {
    if (bare) await command(["git", "-C", bare, "worktree", "remove", "--force", work], { timeoutMs: 300_000 }).catch(() => {});
    else rmSync(work, { recursive: true, force: true });
  };
  const finish = (exit: Record<string, unknown>) => withLock(() => { atomicWrite(join(dir, "exit.json"), { ...exit, finishedAt: Date.now() }); releaseLocked(`job:${id}`); });
  const cancelled = () => readJSON(join(dir, "cancel.json"));
  if (cancelled()) return finish({ code: null, signal: null, error: "cancelled before it started" });
  try {
    if (bare) {
      await verifyCommit(bare, spec.commit!, spec.tree!);
      await checked(["git", "-C", bare, "worktree", "add", "--quiet", "--detach", work, spec.commit!], { timeoutMs: 600_000 });
    } else mkdirSync(work, { mode: 0o700 });
  } catch (e) { return finish({ code: null, signal: null, error: `checkout failed: ${(e as Error).message}` }); }
  const cwd = join(work, spec.cwd);
  const inside = relative(realpathSync(work), (() => { try { return realpathSync(cwd); } catch { return cwd; } })());
  if (inside.startsWith("..") || isAbsolute(inside) || !existsSync(cwd)) return finish({ code: null, signal: null, error: `working directory ${spec.cwd} is not in the checkout` });
  // A cancel and the start are ordered by the lock: either the cancel sees started.json and
  // signals the group, or the start sees cancel.json and never spawns.
  // Wrapped: a promise returned from the locked section would hold the lock until the command exits.
  const exited = await withLock(() => {
    if (cancelled()) return null;
    const log = openSync(join(dir, "log.txt"), "a", 0o600);
    let child;
    try { child = spawn(spec.argv[0], spec.argv.slice(1), { cwd, detached: true, stdio: ["ignore", log, log], env: process.env }); }
    finally { closeSync(log); }
    const done = new Promise<{ code: number | null; signal: string | null; error?: string }>(res => {
      child.on("error", e => res({ code: null, signal: null, error: `cannot start ${spec.argv[0]}: ${e.message}` }));
      child.on("exit", (code, signal) => res({ code, signal }));
    });
    if (child.pid) atomicWrite(join(dir, "started.json"), { pid: child.pid, pgid: child.pid, cwd, startedAt: Date.now(), host: hostname(), arch: process.arch, platform: process.platform });
    return { done };
  });
  if (!exited) {
    await clean();
    return finish({ code: null, signal: null, error: "cancelled before it started" });
  }
  const result = await exited.done;
  try {
    const out = spec.input === "none" ? { files: [], missing: [] } : collect(cwd, join(dir, "out"), spec.artifacts);
    atomicWrite(join(dir, "artifacts.json"), out);
  } catch (e) { atomicWrite(join(dir, "artifacts.json"), { files: [], missing: [{ path: "*", error: (e as Error).message }] }); }
  await clean();
  await finish(result);
}
export function jobStatus(input: any) {
  const dir = jobDir(input?.jobId);
  if (!existsSync(dir)) return { state: "missing" };
  const tomb = readJSON(join(dir, "tombstone.json"));
  if (tomb) return { state: "removed", exit: tomb.exit, error: "this job finished and its records were removed by sflow hosts gc" };
  const spec = readJSON(join(dir, "spec.json")), exit = readJSON(join(dir, "exit.json")), started = readJSON(join(dir, "started.json"));
  const runner = readJSON(join(dir, "runner.json")), cancel = readJSON(join(dir, "cancel.json"));
  const extra = { spec, started, ...(cancel ? { cancel } : {}) };
  if (exit) return { state: "exited", exit, artifacts: readJSON(join(dir, "artifacts.json")), ...extra };
  if (runner && !alive(runner.pid)) {
    if (started && groupAlive(started.pgid)) return { state: "running", runnerLost: true, ...extra };
    return { state: "lost", ...extra, error: "the job runner died without recording an exit" };
  }
  return { state: started ? "running" : "claimed", ...extra };
}
export async function jobCancel(input: any) {
  const dir = jobDir(input?.jobId);
  return withLock(() => {
    if (!existsSync(dir)) return { signalled: false, state: "missing" };
    if (existsSync(join(dir, "exit.json"))) return { signalled: false, state: "exited" };
    const prior = readJSON(join(dir, "cancel.json"));
    atomicWrite(join(dir, "cancel.json"), { at: prior?.at ?? Date.now(), reason: prior?.reason ?? String(input?.reason ?? "cancelled"), ...(input?.force ? { forcedAt: Date.now() } : {}) });
    const started = readJSON(join(dir, "started.json"));
    if (!started?.pgid) return { signalled: false, state: "claimed" };
    // Only this job's own process group.
    try { process.kill(-started.pgid, input?.force ? "SIGKILL" : "SIGTERM"); return { signalled: true, state: "running" }; }
    catch { return { signalled: false, state: groupAlive(started.pgid) ? "running" : "gone" }; }
  });
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
// A write step's directory is fixed per project and host slot, so an agent's per-folder trust is
// asked once per slot instead of once per run. Reuse starts it fresh from the new commit (ignored
// files too, as a new worktree would); unfinished changes another run left there are saved first.
async function workspace(c: Checkout, slot: number): Promise<string> {
  const bare = bareRepo(dataHome(), c.repo), root = join(dataHome(), "workspaces", c.repo), path = join(root, String(slot));
  await verifyCommit(bare, c.commit, c.tree);
  if (!c.branch || !/^sflow\/[0-9a-f-]{36}\/[a-z][a-z0-9-]{0,39}$/.test(c.branch)) throw new Error("invalid workspace branch");
  if (!existsSync(path)) {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    await checked(["git", "-C", bare, "worktree", "prune"]).catch(() => "");
    await checked(["git", "-C", bare, "worktree", "add", "--quiet", "-b", c.branch, path, c.commit], { timeoutMs: 600_000 });
    return realpathSync(path);
  }
  const common = realpathSync(resolve(path, (await checked(["git", "-C", path, "rev-parse", "--git-common-dir"])).trim()));
  if (common !== realpathSync(bare)) throw new Error(`${path} is not a workspace of ${bare}; inspect it`);
  const current = (await checked(["git", "-C", path, "rev-parse", "--abbrev-ref", "HEAD"])).trim();
  // The same step preparing again (a resumed driver): its work is in there; leave it.
  if (current === c.branch) return realpathSync(path);
  const left = await freeze(path, "", { TMPDIR: root });
  const head = (await checked(["git", "-C", path, "rev-parse", "HEAD"])).trim();
  if (left.tree !== (await checked(["git", "-C", path, "rev-parse", "HEAD^{tree}"])).trim()) {
    const diff = await checked(["git", "-C", path, "diff", "--binary", "--no-ext-diff", head, left.commit], { timeoutMs: 300_000 });
    writeFileSync(join(root, `${slot}.leftover-${current.replace(/\//g, "_")}-${Date.now()}.patch`), diff, { mode: 0o600 });
  }
  await checked(["git", "-C", path, "checkout", "--quiet", "-f", "-B", c.branch, c.commit], { timeoutMs: 600_000 });
  await checked(["git", "-C", path, "clean", "-ffdxq"], { timeoutMs: 600_000 });
  if (/^sflow\//.test(current)) await command(["git", "-C", bare, "branch", "-D", current]).catch(() => {});
  return realpathSync(path);
}
async function checkout(runId: string, c: Checkout, slot: number): Promise<string> {
  if (!/^[a-z0-9-]{1,80}$/.test(c.name)) throw new Error("invalid checkout name");
  if (c.branch) return workspace(c, slot);
  const bare = bareRepo(dataHome(), c.repo), path = join(checkoutsDir(runId), c.name);
  await verifyCommit(bare, c.commit, c.tree);
  if (existsSync(path)) {
    const head = (await checked(["git", "-C", path, "rev-parse", "HEAD"])).trim();
    if (head !== c.commit) throw new Error(`${path} exists at ${head}, expected ${c.commit}`);
    return path;
  }
  mkdirSync(checkoutsDir(runId), { recursive: true, mode: 0o700 });
  await checked(["git", "-C", bare, "worktree", "add", "--quiet", "--detach", path, c.commit], { timeoutMs: 600_000 });
  return realpathSync(path);
}
export async function prepare(input: any) {
  const run = input?.run as Run, stepId = input?.stepId as string;
  if (!run || !RUN.test(run.id) || !STEP.test(stepId)) throw new Error("invalid prepare request");
  const dir = join(dataHome(), "runs", run.id);
  const preparing = join(dir, "preparing", randomUUID());
  await withLock(() => {
    if (existsSync(join(dir, "run.json"))) mirrorRun(run.id);
    mkdirSync(dirname(preparing), { recursive: true, mode: 0o700 });
    // Retained after a crash: an unfinished checkout must not be collected.
    writeFileSync(preparing, "", { mode: 0o600 });
  });
  try { return await prepareMirror(input); }
  finally { await withLock(() => { rmSync(preparing, { force: true }); }); }
}
async function prepareMirror(input: any) {
  const run = input.run as Run, stepId = input.stepId as string;
  const dir = join(dataHome(), "runs", run.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const socketDir = join(process.env.TMPDIR ?? "/tmp", `sf-${run.id.slice(0, 12)}`);
  mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const step = run.workflow.steps.find(s => s.id === stepId);
  if (!step) throw new Error("step missing from mirror");
  const root = sessionRoot(run.workflow.steps, step), owner = `step:${run.id}:${root}`;
  const writes = (input.checkouts ?? []).find((c: Checkout) => c.branch) as Checkout | undefined;
  const known = writes && /^[0-9a-f]{16}$/.test(writes.repo) && existsSync(join(dataHome(), "workspaces", writes.repo))
    ? readdirSync(join(dataHome(), "workspaces", writes.repo)).filter(n => /^\d+$/.test(n)).map(Number) : [];
  const claim = await claimSlotAt(owner, Number(input.slots), known);
  if (!claim) return { state: "busy" };
  // Checkouts the step reads or writes, then remote paths for every driver path they replace.
  const pathMap: Record<string, string> = {};
  try {
    for (const c of (input.checkouts ?? []) as (Checkout & { local: string; sub?: string })[]) {
      if (c.sub !== undefined && c.sub !== "." && !safeRelative(c.sub)) throw new Error("invalid checkout subdirectory");
      pathMap[c.local] = join(await checkout(run.id, c, claim.slot), c.sub ?? ".");
    }
    return await publishMirror(run, stepId, step, dir, socketDir, pathMap, input);
  } catch (e) {
    // A slot this call claimed goes back; one a retained session already held stays with it.
    if (claim.kind === "new") await releaseSlot(owner);
    throw e;
  }
}
function publishMirror(run: Run, stepId: string, step: Step, dir: string, socketDir: string, pathMap: Record<string, string>, input: any) {
  return withLock(() => {
    const existing = existsSync(join(dir, "run.json")) ? mirrorRun(run.id) : undefined;
    const mirror: Run = { ...existing, ...run, dir, socket: join(socketDir, "tmux.sock"), mirror: { driver: String(input.driver ?? "") },
      steps: { ...(existing?.steps ?? {}), ...run.steps } };
    mirror.workflow = { ...run.workflow, steps: run.workflow.steps.map(s => {
      const prev = existing?.workflow.steps.find(x => x.id === s.id);
      return s.id === stepId ? { ...s, cwd: pathMap[s.cwd] ?? s.cwd } : prev ?? s;
    }) };
    saveRun(mirror);
    return { state: "ready", dir, cwd: pathMap[step.cwd] ?? step.cwd, pathMap };
  });
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
    // rel: evidence of a dependency, kept at its run-relative path so pathMap finds it here.
    if (f.rel !== undefined ? typeof f.rel !== "string" || !safeRelative(f.rel) || !/^[a-z][a-z0-9-]{0,39}\//.test(f.rel)
      : typeof f.name !== "string" || !/^[\w.-]{1,120}$/.test(f.name)) throw new Error("invalid file name");
    const body = Buffer.from(String(f.base64), "base64");
    if (createHash("sha256").update(body).digest("hex") !== f.sha256) throw new Error(`${f.rel ?? f.name}: hash mismatch on arrival`);
    const dest = f.rel !== undefined ? join(run.dir, f.rel) : join(inbound, f.name);
    mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
    writeFileSync(dest, body, { mode: 0o600 }); out[f.rel ?? f.name] = dest;
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
export async function patchFile(input: any) {
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
  const body = readFileSync(out);
  return { path: out, sha256: createHash("sha256").update(body).digest("hex"), bytes: body.length, base, commit: frozen.commit, tree: frozen.tree };
}
export async function rt(input: any, cli: string[]) {
  if (input.action === "create" || input.action === "continue") return withLock(() => runtimeAction(input, cli));
  return runtimeAction(input, cli);
}
async function runtimeAction(input: any, cli: string[]) {
  const run = mirrorRun(input?.runId), id = input?.stepId as string;
  if (!run.steps[id]) throw new Error("unknown step");
  const runtime = new TmuxRuntime(cli), step = run.workflow.steps.find(s => s.id === id)!;
  switch (input.action) {
    case "create": await runtime.create(run, step); saveRun(run); return { ok: true, cwd: run.steps[id].cwd };
    case "continue": await runtime.continue(run, step); saveRun(run); return { ok: true };
    case "exists": return { exists: await runtime.exists(run, id) };
    case "stop": {
      await runtime.stop(run, id);
      await releaseSlot(`step:${run.id}:${sessionRoot(run.workflow.steps, step)}`);
      return { ok: true };
    }
    case "screen": return { screen: await runtime.screen(run, id) };
    case "keys": await runtime.keys(run, id, (input.keys as string[]).map(String)); return { ok: true };
    default: throw new Error("unknown runtime action");
  }
}
export async function cleanup(input: any) {
  const run = mirrorRun(input?.runId);
  await withLock(() => { for (const s of slotOwners()) if (s.owner.startsWith(`step:${run.id}:`)) releaseLocked(s.owner); });
  await removeCheckouts(run.id);
  return { ok: true };
}
// Removed checkouts are gone from disk; pruning drops their registration from each bare repository.
async function emptyTrash(trash: string) {
  const repos = new Set<string>();
  const checkouts = join(trash, "checkouts");
  for (const name of existsSync(checkouts) ? readdirSync(checkouts) : []) {
    let gitfile: RegExpMatchArray | null = null;
    try { gitfile = readFileSync(join(checkouts, name, ".git"), "utf8").match(/^gitdir: (.+)\/worktrees\/[^/]+\s*$/m); } catch {}
    if (gitfile) repos.add(gitfile[1]);
  }
  rmSync(trash, { recursive: true, force: true });
  for (const repo of repos) await command(["git", "-C", repo, "worktree", "prune"], { timeoutMs: 300_000 }).catch(() => {});
}
async function removeCheckouts(runId: string) {
  const dir = checkoutsDir(runId);
  if (existsSync(dir)) for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const common = (await command(["git", "-C", path, "rev-parse", "--git-common-dir"])).stdout.trim();
    if (common) await command(["git", "-C", common, "worktree", "remove", "--force", path], { timeoutMs: 300_000 });
    rmSync(path, { recursive: true, force: true });
  }
  rmSync(dir, { recursive: true, force: true });
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
// Finished jobs keep tombstones; old mirrors without live workers can be removed entirely.
export async function gc(input: any) {
  const days = Number(input?.days ?? 7);
  if (!Number.isFinite(days) || days < 0) throw new Error("invalid days");
  const root = join(dataHome(), "jobs"), removed: string[] = [], mirrors: string[] = [], doomed: string[] = [];
  for (const id of existsSync(root) ? readdirSync(root) : []) {
    if (!JOB.test(id)) continue;
    const dir = join(root, id), exit = readJSON(join(dir, "exit.json"));
    if (existsSync(join(dir, "tombstone.json")) || !exit || Date.now() - Number(exit.finishedAt ?? 0) < days * 86400_000) continue;
    const spec = readJSON(join(dir, "spec.json"));
    if (spec?.repo) await command(["git", "-C", bareRepo(dataHome(), spec.repo), "update-ref", "-d", `refs/sflow/jobs/${id}`]).catch(() => {});
    // The directory stays as a tombstone so the same job id can never be started again.
    await withLock(() => {
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { recursive: true, force: true });
      atomicWrite(join(dir, "tombstone.json"), { removedAt: Date.now(), exit });
    });
    removed.push(id);
  }
  const runs = join(dataHome(), "runs");
  for (const id of existsSync(runs) ? readdirSync(runs) : []) {
    if (!RUN.test(id)) continue;
    await withLock(async () => {
      const dir = join(runs, id), file = join(dir, "run.json");
      let run: Run;
      try {
        run = loadRun(id);
        const preparing = join(dir, "preparing");
        if (existsSync(preparing) && readdirSync(preparing).length) return;
        if (!run.mirror || (days > 0 && Date.now() - statSync(file).mtimeMs < days * 86400_000)) return;
        // Only this mirror's private socket; either tmux answer can prove a worker is live.
        let socketExists = true;
        try { lstatSync(run.socket); } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ENOENT") return;
          socketExists = false;
        }
        if (socketExists) {
          const absent = (r: Awaited<ReturnType<typeof command>>) => r.code === 1 && !r.stdout.trim()
            && /no server running|no sessions|error connecting to .*\((No such file or directory|Connection refused)\)/.test(r.stderr);
          // Under the lock on purpose (a worker could start between an unlocked probe and the delete);
          // bounded, and a probe that times out keeps the run.
          const has = await command(["tmux", "-S", run.socket, "has-session"], { timeoutMs: 3000 });
          if (!absent(has)) return;
          const list = await command(["tmux", "-S", run.socket, "list-sessions"], { timeoutMs: 3000 });
          if (!absent(list)) return;
        }
      } catch { return; } // Invalid records and inconclusive probes are kept.
      // A slot claimed in the last hour means a driver is placing or starting a step there (prepare
      // finishes before the session exists); even --days 0 waits for that.
      if (slotOwners().some(x => x.owner.startsWith(`step:${id}:`) && Date.now() - Number(x.since ?? 0) < 3600_000)) return;
      for (const s of slotOwners()) if (s.owner.startsWith(`step:${id}:`)) releaseLocked(s.owner);
      // Under the lock only renames: the run and its checkouts leave their names at once, so a later
      // prepare starts a fresh mirror. The slow deletion happens after the lock is released.
      const trash = join(dataHome(), "trash", `${id}-${randomUUID()}`);
      mkdirSync(trash, { recursive: true, mode: 0o700 });
      renameSync(dir, join(trash, "run"));
      if (existsSync(checkoutsDir(id))) renameSync(checkoutsDir(id), join(trash, "checkouts"));
      doomed.push(trash);
      mirrors.push(id);
    });
  }
  for (const trash of doomed) await emptyTrash(trash);
  // Changes saved when a reused workspace was cleared, past the same cutoff.
  const spaces = join(dataHome(), "workspaces");
  for (const repo of existsSync(spaces) ? readdirSync(spaces) : [])
    for (const f of readdirSync(join(spaces, repo)).filter(f => /^\d+\.leftover-.*\.patch$/.test(f))) {
      const p = join(spaces, repo, f);
      if (Date.now() - statSync(p).mtimeMs >= days * 86400_000) rmSync(p, { force: true });
    }
  return { removed, mirrors };
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
    case "command-check": {
      if (typeof input.program !== "string" || !input.program || (!isAbsolute(input.program) && input.program.includes("/"))) throw new Error("expected a program on PATH or an absolute path");
      return out({ path: Bun.which(input.program) });
    }
    case "repo": { const path = bareRepo(dataHome(), input.repo); await ensureBare(path); return out({ path }); }
    case "job-start": return out(await jobStart(input, cli));
    case "job-exec": return jobExec(process.argv[process.argv.length - 1]);
    case "job-status": return out(jobStatus(input));
    case "job-cancel": return out(await jobCancel(input));
    case "job-file": return raw(jobFile(input));
    case "prepare": return out(await prepare(input));
    case "step": return out(updateStep(input));
    case "put": return out(put(input));
    case "file": return raw(runFile(input));
    case "patch": return out(await patchFile(input));
    case "rt": return out(await rt(input, cli));
    case "send": { const run = mirrorRun(input.runId); await transport.send(run.channel, input.body, `sflow-${run.id}`); return out({ ok: true }); }
    case "read": { const run = mirrorRun(input.runId); return out(await transport.read(run.channel, `sflow-${run.id}`)); }
    case "cleanup": return out(await cleanup(input));
    case "gc": return out(await gc(input));
    case "release": {
      if (!RUN.test(input?.runId) || !STEP.test(input?.root)) throw new Error("invalid release request");
      await releaseSlot(`step:${input.runId}:${input.root}`); return out({ ok: true });
    }
    default: throw new Error(`unknown remote operation ${op}`);
  }
}
