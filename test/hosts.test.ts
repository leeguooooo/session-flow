import { test, expect, afterEach, beforeEach } from "bun:test";
import { realpathSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, readdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflow } from "../src/config";
import { tmuxTest } from "./tmux";
import { createRun, saveRun } from "../src/store";
import { tick, reconcile } from "../src/engine";
import { HostRouter } from "../src/hostrun";
import { TmuxRuntime } from "../src/runtime";
import { SshLink, parseHost, candidates, unfit, REMOTE_PROTOCOL } from "../src/hosts";
import { freezeHosts, gcSummary } from "../src/hosts-cli";
import { resolveResult } from "../src/results";
import { eventProof } from "../src/protocol";
import type { Message, Run, Transport, HostConfig } from "../src/types";

// A loopback "remote": ssh is a shim that runs the command locally with the host's own
// HOME and SFLOW_HOME, so every remote operation and git push really crosses a process boundary.
const CLI = resolve(import.meta.dir, "../src/cli.ts");
const dirs: string[] = [];
const saved = { ...process.env };
let base = "", project = "";
function git(cwd: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (r.status) throw new Error(r.stderr); return r.stdout.trim();
}
function host(name: string, extra: Partial<HostConfig> = {}): HostConfig {
  const home = join(base, `host-${name}`); mkdirSync(home, { recursive: true });
  const bin = join(home, "sflow"); writeFileSync(bin, `#!/bin/sh\nexec ${process.execPath} ${CLI} "$@"\n`); chmodSync(bin, 0o755);
  // Placement checks the agent CLI exists on the host; tests must not depend on this machine's.
  mkdirSync(join(home, "tools"), { recursive: true });
  for (const t of ["codex", "tmux", "ocs"]) { writeFileSync(join(home, "tools", t), "#!/bin/sh\nexit 0\n"); chmodSync(join(home, "tools", t), 0o755); }
  return parseHost(name, { ssh: `loop-${name}`, bin, slots: 2, maxLoad: 16, minFreeGB: 0, ...extra });
}
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "sf-hosts-")); dirs.push(base);
  process.env.SFLOW_HOME = join(base, "driver");
  process.env.SFLOW_CONFIG_HOME = join(base, "config");
  process.env.SFLOW_POLL_MS = "0";
  // The shim reads the target, then runs the remote command string under that host's state.
  const shim = join(base, "ssh");
  writeFileSync(shim, `#!/bin/sh
while [ $# -gt 1 ]; do case "$1" in -o|-J) shift 2;; -t) shift;; *) break;; esac; done
target="$1"; shift; name="\${target#loop-}"
[ -d "${base}/host-$name" ] || { echo "ssh: Could not resolve hostname $target" >&2; exit 255; }
export HOME="${base}/host-$name" SFLOW_HOME="${base}/host-$name/state" PATH="${base}/host-$name/tools:$PATH"
exec sh -c "$*"
`); chmodSync(shim, 0o755);
  process.env.SFLOW_SSH_BIN = shim;
  project = join(base, "project"); mkdirSync(project);
  git(project, "init", "-q"); git(project, "config", "user.email", "t@t"); git(project, "config", "user.name", "t");
  writeFileSync(join(project, ".gitignore"), "ignored.txt\n");
  writeFileSync(join(project, "tracked.txt"), "committed\n");
  git(project, "add", "."); git(project, "commit", "-qm", "init");
  writeFileSync(join(project, "tracked.txt"), "dirty edit\n");
  writeFileSync(join(project, "untracked.txt"), "new file\n");
  writeFileSync(join(project, "ignored.txt"), "secret\n");
});
afterEach(() => {
  for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
  Object.assign(process.env, saved);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
class NoTransport implements Transport {
  rows: Message[] = [];
  async read() { return this.rows; }
  async send(_c: string, body: unknown, as: string) { this.rows.push({ seq: this.rows.length + 1, from: as, body: JSON.stringify(body) }); }
  async whoami() { return "codex-12345678"; }
}
function setup(steps: object[], hosts: Record<string, HostConfig>, concurrency = 2): Run {
  const wf = parseWorkflow({ version: 1, name: "t", concurrency, steps: steps.map(s => ({ cwd: project, ...s })) }, base);
  const run = createRun(wf, undefined, hosts);
  dirs.push(join(run.socket, ".."));
  return run;
}
const router = () => new HostRouter(new TmuxRuntime([process.execPath, CLI]), [process.execPath, CLI]);
async function until(run: Run, rt: HostRouter, tr: Transport, done: () => boolean, ms = 30_000) {
  const end = Date.now() + ms;
  while (!done()) { if (Date.now() > end) throw new Error(`timeout: ${JSON.stringify(run.steps)}`); await tick(run, rt, tr); await Bun.sleep(50); }
}

test("a command step runs on a host against the dirty checkout and brings artifacts back", async () => {
  const before = { status: git(project, "status", "--porcelain"), head: git(project, "rev-parse", "HEAD"), objects: git(project, "count-objects") };
  const run = setup([{ id: "build", agent: "command", host: "mini",
    command: ["sh", "-c", "mkdir -p out && cat tracked.txt untracked.txt > out/r.txt && test ! -e ignored.txt && echo built"], artifacts: ["out"] }],
    { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  const s = run.steps.build;
  expect(s.status).toBe("done");
  expect(s.host).toBe("mini");
  const result = resolveResult(run, "build", s.result!) as any;
  expect(result.details.exitCode).toBe(0);
  expect(result.details.inputHead).toBe(before.head);
  expect(readFileSync(join(run.dir, "build", "artifacts", "out", "r.txt"), "utf8")).toBe("dirty edit\nnew file\n");
  expect(readFileSync(join(run.dir, "build", "log.txt"), "utf8")).toContain("built");
  // The user's checkout, index, HEAD and object store are untouched.
  expect(git(project, "status", "--porcelain")).toBe(before.status);
  expect(git(project, "rev-parse", "HEAD")).toBe(before.head);
  expect(git(project, "count-objects")).toBe(before.objects);
  // The host removed its checkout and freed the slot.
  const job = join(base, "host-mini", "state", "jobs", s.job!.id);
  expect(existsSync(join(job, "work"))).toBe(false);
  expect(readdirSync(join(base, "host-mini", "state", "slots"))).toEqual([]);
}, 60_000);

test("a failing command is failed with its exit code; it is never re-run", async () => {
  const run = setup([{ id: "test", agent: "command", host: "mini", command: ["sh", "-c", "echo x >> \"$HOME/count\"; exit 3"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.test.status).toBe("failed");
  expect((resolveResult(run, "test", run.steps.test.result!) as any).details.exitCode).toBe(3);
  // A second start of the same job id is refused by the host's journal.
  const link = new SshLink("mini", run.hosts!.mini);
  const job = run.steps.test.job!;
  const again = await link.call<{ state: string }>("job-start", { jobId: job.id, repo: job.repo, commit: job.commit, tree: job.tree, argv: ["true"], artifacts: [], slots: 2 });
  expect(again.state).toBe("exists");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
}, 60_000);

test("slots are claimed on the host; a full host makes the step wait, not run elsewhere", async () => {
  const mini = host("mini", { slots: 1 });
  const run = setup([
    { id: "a", agent: "command", host: "mini", command: ["sh", "-c", "sleep 4"] },
    { id: "b", agent: "command", host: "mini", command: ["true"] },
  ], { mini });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("running");
  expect(run.steps.b.status).toBe("pending");
  expect(run.steps.b.error).toContain("no free slot");
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("done"); expect(run.steps.b.status).toBe("done");
}, 60_000);

test("an unreachable host blocks the step with the reason; no local fallback", async () => {
  const run = setup([{ id: "a", agent: "command", host: "gone", command: ["true"] }], { gone: parseHost("gone", { ssh: "loop-gone", bin: "/x/sflow" }) });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("blocked");
  expect(run.steps.a.error).toContain("Could not resolve hostname");
  expect(run.steps.a.host).toBeUndefined();
}, 60_000);

test("a driver that crashed while starting a job asks the host by job id instead of starting again", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["sh", "-c", "echo x >> \"$HOME/count\""] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("running");
  // Pretend the start's answer was lost: the record still says "starting".
  run.steps.a.status = "launching"; run.steps.a.job!.phase = "starting"; saveRun(run);
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status as string).toBe("done");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
}, 60_000);

test("artifacts cannot leave the checkout through a symlink, and a missing one blocks", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["sh", "-c", "ln -s /etc/hosts leak"], artifacts: ["leak", "absent"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("blocked");
  const r = resolveResult(run, "a", run.steps.a.result!) as any;
  expect(r.details.artifactProblems.join(" ")).toContain("leak: resolves outside the checkout");
  expect(r.details.artifactProblems.join(" ")).toContain("absent: not found");
}, 60_000);

test("a timed-out job is cancelled by process group and the step blocks", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["sh", "-c", "sleep 30"], timeoutSeconds: 10 }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  run.steps.a.startedAt = Date.now() - 11_000;
  await until(run, rt, tr, () => run.status !== "running", 20_000);
  expect(run.steps.a.status).toBe("blocked");
  expect(run.steps.a.error).toContain("timed out");
}, 60_000);

test("a local command step uses the same journal without ssh", async () => {
  const run = setup([{ id: "a", agent: "command", command: ["sh", "-c", "cat untracked.txt"] }], {});
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("done"); expect(run.steps.a.host).toBe("local");
  expect(readFileSync(join(run.dir, "a", "log.txt"), "utf8")).toBe("new file\n");
}, 60_000);

test("a command step reads the worktree an earlier write step left", async () => {
  const run = setup([
    { id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true },
    { id: "test", agent: "command", host: "mini", workspace: "impl", dependsOn: ["impl"], command: ["cat", "made.txt"] },
  ], { mini: host("mini") });
  // Stand in for the write step: its worktree with an uncommitted file, and a done state.
  const wt = join(run.dir, "impl", "worktree");
  git(project, "worktree", "add", "-q", "-b", `sflow/${run.id}/impl`, wt, "HEAD");
  writeFileSync(join(wt, "made.txt"), "from impl\n");
  Object.assign(run.steps.impl, { status: "done", result: { status: "done", summary: "ok" }, actor: "codex-12345678" });
  const rt = router(), tr = new NoTransport();
  // The stand-in write step has no tmux session (CI runners may have no tmux at all).
  rt.local.exists = async () => false;
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.test.status).toBe("done");
  expect(readFileSync(join(run.dir, "test", "log.txt"), "utf8")).toBe("from impl\n");
}, 60_000);

test("workflow rules for hosts and command steps", () => {
  const wf = (steps: object[]) => parseWorkflow({ version: 1, name: "t", steps: steps.map(s => ({ cwd: project, prompt: "x", agent: "codex", ...s })) }, base);
  expect(() => wf([{ id: "a", policy: "workspace-write", inPlace: true, host: "mini" }])).toThrow("cannot have a host");
  expect(() => wf([{ id: "a", policy: "workspace-write", worktree: true, host: "mini" }, { id: "b", policy: "workspace-write", workspace: "a", dependsOn: ["a"] }])).toThrow("stays on one host");
  expect(() => wf([{ id: "a", agent: "command", command: ["make"], model: "x" }])).toThrow("does not apply");
  expect(() => wf([{ id: "a", agent: "command" }])).toThrow("needs command");
  expect(() => wf([{ id: "a", agent: "command", command: ["make"], artifacts: ["../x"] }])).toThrow("inside the checkout");
  expect(() => wf([{ id: "a", host: "local" }])).toThrow("host is");
  expect(() => wf([{ id: "w", policy: "workspace-write", worktree: true }, { id: "c", agent: "command", command: ["make"], workspace: "w" }])).toThrow("dependencies");
  expect(wf([{ id: "a", agent: "command", command: ["make"], host: ["b-host", "a-host", "a-host"] }]).steps[0].host).toEqual(["a-host", "b-host"]);
  expect(() => parseHost("x", { ssh: "-oProxyCommand=evil" })).toThrow("ssh must be");
  expect(() => candidates(["any"], {})).toThrow("at least one host");
  const h = parseHost("x", { ssh: "a@b", maxLoad: 0.5, minFreeGB: 10 });
  const hello = { protocol: REMOTE_PROTOCOL, version: "x", home: "/", arch: "arm64", platform: "darwin", cpus: 10, load: 4, freeGB: 3.7, tools: {}, slots: [] };
  expect(unfit("x", h, hello)).toContain("3.7 GB free");
  expect(unfit("x", h, { ...hello, load: 8, freeGB: 50 })).toContain("busy");
  expect(unfit("x", h, { ...hello, protocol: 99 })).toContain("protocol");
});

test("a step with a host needs cwd inside a Git checkout with a commit", () => {
  const plain = join(base, "plain"); mkdirSync(plain);
  const empty = join(base, "empty"); mkdirSync(empty); git(empty, "init", "-q");
  const wf = (cwd: string, extra: object = {}) => parseWorkflow({ version: 1, name: "t", steps: [{ id: "inspect", agent: "codex", prompt: "x", host: "mini", cwd, ...extra }] }, base);
  expect(() => wf(plain)).toThrow("inspect: a step with a host runs on a snapshot of cwd's Git checkout");
  expect(() => wf(empty)).toThrow("not inside a Git repository with a commit");
  expect(() => wf(plain, { agent: "command", command: ["true"], prompt: undefined })).toThrow("Git checkout");
  expect(() => wf(plain, { agent: "command", command: ["true"], prompt: undefined, host: undefined })).toThrow("inspect: a command step runs on a snapshot");
  expect(wf(join(project)).steps[0].host).toEqual(["mini"]);
  // Without a host a plain directory stays fine for a read-only step.
  expect(wf(plain, { host: undefined }).steps[0].cwd).toBe(plain);
});

test("a cwd this machine cannot snapshot blocks the step instead of waiting for a host", async () => {
  const run = setup([{ id: "inspect", agent: "codex", prompt: "x", host: "mini" }], { mini: host("mini") });
  const plain = join(base, "plain"); mkdirSync(plain);
  run.workflow.steps[0].cwd = plain;
  const rt = router(); rt.local.exists = async () => false; // no tmux needed
  await tick(run, rt, new NoTransport());
  const s = run.steps.inspect;
  expect(s.status).toBe("blocked");
  expect(s.error).toContain(`cannot snapshot ${plain} on this machine`);
  expect(s.error).not.toContain("waiting for a host");
  expect(s.host).toBeUndefined();
}, 60_000);

test("hosts named by a workflow are frozen into the run", () => {
  mkdirSync(process.env.SFLOW_CONFIG_HOME!, { recursive: true });
  writeFileSync(join(process.env.SFLOW_CONFIG_HOME!, "hosts.json"), JSON.stringify({ version: 1, hosts: { a: { ssh: "x@a" }, b: { ssh: "x@b" }, c: { ssh: "x@c" } } }));
  const wf = parseWorkflow({ version: 1, name: "t", steps: [{ id: "s", agent: "command", command: ["true"], host: ["a", "c"], cwd: project }] }, base);
  const run = createRun(wf, undefined, freezeHosts(wf)); dirs.push(join(run.socket, ".."));
  expect(Object.keys(run.hosts!)).toEqual(["a", "c"]);
  expect(run.version).toBe(4);
});

test("a remote write step's changes come back as uncommitted edits in a local worktree", async () => {
  const run = setup([{ id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true, host: "mini" }], { mini: host("mini") });
  const rt = router();
  const placed = await rt.placeAgent(run, run.workflow.steps[0]);
  expect(placed).toEqual({ ok: true });
  const s = run.steps.impl;
  expect(s.host).toBe("mini");
  // The host checked out HEAD (not the dirty edit), on its own branch, under its own home.
  const remoteCwd = s.remote!.cwd!;
  expect(remoteCwd.startsWith(join(realpathSync(base), "host-mini"))).toBe(true);
  expect(readFileSync(join(remoteCwd, "tracked.txt"), "utf8")).toBe("committed\n");
  writeFileSync(join(remoteCwd, "tracked.txt"), "agent edit\n");
  writeFileSync(join(remoteCwd, "added.bin"), Buffer.from([0, 1, 2, 255]));
  Object.assign(s, { status: "done", result: { status: "done", summary: "ok" } });
  await rt.materialize(run, run.workflow.steps[0]);
  const wt = join(run.dir, "impl", "worktree");
  expect(s.cwd).toBe(wt);
  expect(readFileSync(join(wt, "tracked.txt"), "utf8")).toBe("agent edit\n");
  expect([...readFileSync(join(wt, "added.bin"))]).toEqual([0, 1, 2, 255]);
  expect(git(wt, "status", "--porcelain").split("\n").map(l => l.trim()).sort()).toEqual(["?? added.bin", "M tracked.txt"]);
  // The mirror on the host holds only this host's token, and the user's checkout is unchanged.
  const mirror = JSON.parse(readFileSync(join(s.remote!.dir, "run.json"), "utf8"));
  expect(Object.keys(mirror.steps)).toEqual(["impl"]);
  expect(mirror.mirror).toBeTruthy();
  expect(readFileSync(join(project, "tracked.txt"), "utf8")).toBe("dirty edit\n");
  await rt.finish(run);
  // The write directory stays for the next run on this slot (agents trust it once).
  expect(existsSync(remoteCwd)).toBe(true);
  expect(remoteCwd).toMatch(/\/host-mini\/state\/workspaces\/[0-9a-f]{16}\/0$/);
  // A second run on the same host gets the same directory, fresh from HEAD; the first run's
  // changes left there are saved as a patch, and its branch is gone.
  writeFileSync(join(remoteCwd, "ignored.txt"), "build output\n");
  const second = setup([{ id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true, host: "mini" }], { mini: run.hosts!.mini });
  expect(await rt.placeAgent(second, second.workflow.steps[0])).toEqual({ ok: true });
  expect(second.steps.impl.remote!.cwd).toBe(remoteCwd);
  expect(readFileSync(join(remoteCwd, "tracked.txt"), "utf8")).toBe("committed\n");
  expect(existsSync(join(remoteCwd, "added.bin"))).toBe(false);
  expect(existsSync(join(remoteCwd, "ignored.txt"))).toBe(false);
  const ws = join(remoteCwd, "..");
  const saved = readdirSync(ws).filter(f => f.includes(".leftover-"));
  expect(saved.length).toBe(1);
  expect(readFileSync(join(ws, saved[0]), "utf8")).toContain("agent edit");
  const bare = readFileSync(join(remoteCwd, ".git"), "utf8").match(/gitdir: (.+)\/worktrees\//)![1];
  expect(git(bare, "branch", "--list", `sflow/${run.id}/impl`)).toBe("");
  // Preparing the same step again (a resumed driver) leaves its work alone.
  writeFileSync(join(remoteCwd, "work.txt"), "in progress\n");
  delete second.steps.impl.remote;
  expect(await rt.placeAgent(second, second.workflow.steps[0])).toEqual({ ok: true });
  expect(readFileSync(join(remoteCwd, "work.txt"), "utf8")).toBe("in progress\n");
}, 60_000);

test("reports for a remote step count only from that host's channel; results are fetched and hash-checked", async () => {
  const run = setup([{ id: "r", agent: "codex", prompt: "x", host: "mini" }], { mini: host("mini") });
  const rt = router();
  expect(await rt.placeAgent(run, run.workflow.steps[0])).toEqual({ ok: true });
  // A read-only reader sees the dirty checkout as a frozen copy on the host.
  expect(readFileSync(join(run.steps.r.remote!.cwd!, "tracked.txt"), "utf8")).toBe("dirty edit\n");
  expect(existsSync(join(run.steps.r.remote!.cwd!, "ignored.txt"))).toBe(false);
  run.steps.r.status = "starting";
  const token = run.steps.r.token, actor = "codex-12345678";
  const accepted = { type: "sflow.worker" as const, version: 1 as const, runId: run.id, stepId: "r", actor, status: "accepted" as const };
  const row = (e: object, host?: string): Message => ({ seq: 1, from: actor, body: JSON.stringify(e), ...(host ? { host } : {}) });
  // Same report on this machine's channel: ignored.
  reconcile(run, [row({ ...accepted, proof: eventProof(accepted, token) })]);
  expect(run.steps.r.status).toBe("starting");
  reconcile(run, [row({ ...accepted, proof: eventProof(accepted, token) }, "mini")]);
  expect(run.steps.r.status as string).toBe("running");
  // A result written on the host (as the worker's report would) is copied back before reconcile.
  const body = JSON.stringify({ status: "done", summary: "remote ok" }, null, 2) + "\n";
  const sha = new Bun.CryptoHasher("sha256").update(body).digest("hex");
  const remoteFile = join(run.steps.r.remote!.dir, ".protocol", `r-${sha}-result.json`);
  mkdirSync(join(run.steps.r.remote!.dir, ".protocol"), { recursive: true }); writeFileSync(remoteFile, body);
  const done = { ...accepted, status: "done" as const, result: { status: "done", summary: "remote ok", fullResultFile: remoteFile, sha256: sha, bytes: body.length } };
  const link = new SshLink("mini", run.hosts!.mini);
  await link.call("send", { runId: run.id, body: { ...done, proof: eventProof(done, token) } }).catch(() => {});
  // ocs may be absent in CI; feed the row directly and fetch the file the way remoteRows does.
  const fetched = join(run.dir, ".protocol", `r-${sha}-result.json`);
  mkdirSync(join(run.dir, ".protocol"), { recursive: true });
  await link.fetch("file", { runId: run.id, path: remoteFile }, fetched);
  reconcile(run, [row({ ...done, proof: eventProof(done, token) }, "mini")]);
  expect(run.steps.r.status as string).toBe("done");
  expect(run.steps.r.result!.fullResultFile).toBe(fetched);
  expect(resolveResult(run, "r", run.steps.r.result!).summary).toBe("remote ok");
  // A file outside the mirrored run is not served.
  await expect(link.fetch("file", { runId: run.id, path: "/etc/hosts" }, join(base, "x"))).rejects.toThrow("outside the run");
}, 60_000);

// ---- failure cases from review ----
import { claimSlot, gc, jobCancel, jobExec, jobStatus } from "../src/remote";
import type { SessionRuntime, Step } from "../src/types";

test("a lost start answer after gc is never started again: the tombstone makes it uncertain", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["sh", "-c", "echo x >> \"$HOME/count\""] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
  await new SshLink("mini", run.hosts!.mini).call("gc", { days: 0 });
  // The driver's record says the start was sent but never answered.
  Object.assign(run.steps.a, { status: "launching", result: undefined }); run.steps.a.job!.phase = "starting"; run.status = "running"; saveRun(run);
  await tick(run, rt, tr);
  expect(run.steps.a.status as string).toBe("uncertain");
  expect(run.steps.a.error).toContain("never started again");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
}, 60_000);

// Slots claimed over an hour ago, so a test exercises only the protection it names.
function ageSlots() {
  const dir = join(process.env.SFLOW_HOME!, "slots");
  for (const n of existsSync(dir) ? readdirSync(dir) : []) {
    const f = join(dir, n, "owner.json"), o = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...o, since: Date.now() - 2 * 3600_000 }));
  }
}
function gcRun(id: string, mirror = true): Run {
  const dir = join(process.env.SFLOW_HOME!, "runs", id), socketDir = join(base, `sf-${id.slice(0, 12)}`);
  mkdirSync(dir, { recursive: true }); mkdirSync(socketDir, { recursive: true, mode: 0o700 });
  const workflow = parseWorkflow({ version: 1, name: "gc", steps: [{ id: "a", agent: "codex", prompt: "synthetic gc worker", cwd: project }] }, base);
  const run: Run = { version: 2, id, dir, socket: join(socketDir, "tmux.sock"), channel: `sflow-${id}`,
    workflow, createdAt: Date.now(), status: "running", steps: { a: { status: "pending", token: "synthetic", session: "sf-a" } },
    ...(mirror ? { mirror: { driver: "other" } } : {}) };
  saveRun(run); return run;
}

test("gc removes old mirrors and their worktrees and releases only their slots", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const home = process.env.SFLOW_HOME, id = "00000000-0000-0000-0000-000000000001";
  const dir = join(home, "runs", id), bare = join(home, "repos", "test.git"), checkout = join(home, "checkouts", id, "work");
  mkdirSync(dir, { recursive: true }); mkdirSync(join(home, "repos"), { recursive: true });
  git(project, "clone", "--bare", ".", bare);
  git(bare, "worktree", "add", "--detach", checkout, "HEAD");
  const realCheckout = realpathSync(checkout);
  writeFileSync(join(checkout, "tracked.txt"), "left by worker\n");
  const file = join(dir, "run.json"), old = new Date(Date.now() - 8 * 86400_000);
  gcRun(id);
  utimesSync(file, old, old);
  expect(await claimSlot(`step:${id}:a`, 3)).toBe("new");
  expect(await claimSlot(`step:${id}:b`, 3)).toBe("new");
  expect(await claimSlot("step:other:a", 3)).toBe("new");
  // Claimed a minute ago: a driver may still be starting the step, so even an old mirror stays.
  expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [] });
  expect(existsSync(dir)).toBe(true);
  for (const n of readdirSync(join(home, "slots"))) {
    const f = join(home, "slots", n, "owner.json"), o = JSON.parse(readFileSync(f, "utf8"));
    writeFileSync(f, JSON.stringify({ ...o, since: Date.now() - 2 * 3600_000 }));
  }
  expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [id] });
  expect(existsSync(dir)).toBe(false);
  expect(existsSync(join(home, "checkouts", id))).toBe(false);
  expect(git(bare, "worktree", "list", "--porcelain")).not.toContain(realCheckout);
  // Moved aside under the lock, deleted after it; nothing is left behind.
  expect(readdirSync(join(home, "trash"))).toEqual([]);
  const owners = readdirSync(join(home, "slots")).map(n => JSON.parse(readFileSync(join(home, "slots", n, "owner.json"), "utf8")).owner);
  expect(owners).toEqual(["step:other:a"]);
});

test("gc keeps fresh mirrors and old runs driven on this host", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const fresh = "00000000-0000-0000-0000-000000000002", local = "00000000-0000-0000-0000-000000000003";
  for (const id of [fresh, local]) {
    const dir = join(process.env.SFLOW_HOME, "runs", id); mkdirSync(dir, { recursive: true });
    const file = join(dir, "run.json");
    gcRun(id, id === fresh);
    if (id === local) { const old = new Date(Date.now() - 8 * 86400_000); utimesSync(file, old, old); }
    expect(await claimSlot(`step:${id}:a`, 2)).toBe("new");
  }
  expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [] });
  for (const id of [fresh, local]) expect(existsSync(join(process.env.SFLOW_HOME, "runs", id))).toBe(true);
  expect(readdirSync(join(process.env.SFLOW_HOME, "slots"))).toHaveLength(2);
});

tmuxTest("gc keeps an old mirror with a real live tmux worker", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const run = gcRun("00000000-0000-0000-0000-000000000004");
  const file = join(run.dir, "run.json"), old = new Date(Date.now() - 8 * 86400_000);
  utimesSync(file, old, old);
  expect(await claimSlot(`step:${run.id}:a`, 1)).toBe("new");
  ageSlots();
  try {
    const started = spawnSync("tmux", ["-S", run.socket, "new-session", "-d", "-s", "x", "sleep", "30"], { encoding: "utf8" });
    expect(started.status).toBe(0);
    expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [] });
    expect(existsSync(file)).toBe(true);
    expect(readdirSync(join(process.env.SFLOW_HOME, "slots"))).toHaveLength(1);
  } finally { spawnSync("tmux", ["-S", run.socket, "kill-server"]); }
  // The live session alone kept it: once it is gone, the same run is collected.
  expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [run.id] });
});

test("gc keeps corrupt but parseable mirror records", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const run = gcRun("00000000-0000-0000-0000-000000000005");
  const file = join(run.dir, "run.json"), old = new Date(Date.now() - 8 * 86400_000);
  writeFileSync(file, JSON.stringify({ ...run, socket: join(run.dir, "missing.sock") }));
  utimesSync(file, old, old);
  expect(await claimSlot(`step:${run.id}:a`, 1)).toBe("new");
  expect(await gc({ days: 7 })).toEqual({ removed: [], mirrors: [] });
  expect(existsSync(file)).toBe(true);
  expect(readdirSync(join(process.env.SFLOW_HOME, "slots"))).toHaveLength(1);
});

test("hosts gc summary includes job and mirror counts", () => {
  expect(gcSummary("mini", { removed: ["job1", "job2"], mirrors: ["mirror1"] }))
    .toBe("mini: removed 2 job(s), 1 mirror run(s)");
  expect(gcSummary("old", { removed: [] })).toBe("old: removed 0 job(s), mirror runs not collected (older sflow there)");
});

test("gc keeps a mirror while checkout preparation is in progress", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const run = gcRun("00000000-0000-0000-0000-000000000006");
  mkdirSync(join(run.dir, "preparing"));
  writeFileSync(join(run.dir, "preparing", "synthetic-operation"), "");
  expect(await claimSlot(`step:${run.id}:a`, 1)).toBe("new");
  ageSlots();
  expect(await gc({ days: 0 })).toEqual({ removed: [], mirrors: [] });
  expect(existsSync(join(run.dir, "run.json"))).toBe(true);
  expect(readdirSync(join(process.env.SFLOW_HOME, "slots"))).toHaveLength(1);
  // The marker alone kept it: once preparation ends, the same run is collected.
  rmSync(join(run.dir, "preparing"), { recursive: true });
  expect(await gc({ days: 0 })).toEqual({ removed: [], mirrors: [run.id] });
});

test("a slot whose runner died but whose command group lives is not reclaimed", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const id = "00000000-0000-0000-0000-000000000000-a", dir = join(base, "solo", "jobs", id);
  mkdirSync(dir, { recursive: true });
  const sleeper = Bun.spawn(["sh", "-c", "sleep 20"], { stdio: ["ignore", "ignore", "ignore"], detached: true } as any);
  writeFileSync(join(dir, "runner.json"), JSON.stringify({ pid: 999_999 }));
  writeFileSync(join(dir, "started.json"), JSON.stringify({ pid: sleeper.pid, pgid: sleeper.pid }));
  expect(await claimSlot(`job:${id}`, 1)).toBe("new");
  try {
    expect(await claimSlot("job:other", 1)).toBe(false);
    expect((jobStatus({ jobId: id }) as any).state).toBe("running");
  } finally { process.kill(-sleeper.pid!, "SIGKILL"); }
  await Bun.sleep(100);
  expect(await claimSlot("job:other", 1)).toBe("new");
}, 30_000);

test("concurrent claimers on one host never share a slot", async () => {
  const home = join(base, "race");
  const script = join(base, "claim.ts");
  writeFileSync(script, `import { claimSlot } from ${JSON.stringify(resolve(import.meta.dir, "../src/remote.ts"))};\nconsole.log(await claimSlot(process.argv[2], 1));\n`);
  const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, script, `step:r:${i}`], { env: { ...process.env, SFLOW_HOME: home }, stdout: "pipe" }));
  const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
  expect(outs.filter(o => o.trim() === "new").length).toBe(1);
}, 30_000);

test("a cancel recorded before the start keeps the command from ever running", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const id = "00000000-0000-0000-0000-000000000000-c", dir = join(base, "solo", "jobs", id);
  mkdirSync(dir, { recursive: true });
  const marker = join(base, "ran");
  writeFileSync(join(dir, "spec.json"), JSON.stringify({ jobId: id, repo: "0123456789abcdef", commit: "x", tree: "y", argv: ["touch", marker], artifacts: [], slots: 1 }));
  expect((await jobCancel({ jobId: id })).state).toBe("claimed");
  await jobExec(id);
  expect(existsSync(marker)).toBe(false);
  expect(JSON.parse(readFileSync(join(dir, "exit.json"), "utf8")).error).toContain("cancelled before it started");
});

test("a command runs in its cwd inside the repository, not at the root", async () => {
  mkdirSync(join(project, "sub")); writeFileSync(join(project, "sub", "marker"), "in sub\n");
  const run = setup([{ id: "a", agent: "command", host: "mini", cwd: join(project, "sub"), command: ["cat", "marker"], artifacts: ["marker"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("done");
  expect(readFileSync(join(run.dir, "a", "log.txt"), "utf8")).toBe("in sub\n");
}, 60_000);

test("expect gates a command step like an agent's report", async () => {
  const run = setup([{ id: "a", agent: "command", command: ["true"], expect: { "details.exitCode": 99 } }], {});
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("blocked");
  expect(run.steps.a.error).toContain("details.exitCode");
}, 60_000);

test("missing evidence (no log, no artifact list, a different job record) blocks a zero exit", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["true"], artifacts: ["required.bin"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  const s = run.steps.a;
  Object.assign(s, { status: "running", host: "mini", startedAt: Date.now(), job: { id: `${run.id}-a`, phase: "running", commit: "c1", tree: "t1", cwd: "." } });
  const fake = { name: "mini", gitUrl: () => "", gitEnv: () => ({}),
    call: async (op: string) => op === "job-status" ? { state: "exited", exit: { code: 0, finishedAt: Date.now() }, spec: { commit: "other", tree: "t1", argv: ["true"], artifacts: ["required.bin"] } } : {},
    fetch: async () => { throw new Error("connection reset"); } };
  (rt as any).links.set(`${run.id}:mini`, fake);
  await rt.pollCommand(run, run.workflow.steps[0]);
  expect(s.status).toBe("blocked");
  const r = resolveResult(run, "a", s.result!) as any;
  expect(r.details.evidenceProblems.join(" ")).toContain("does not match");
  expect(r.details.evidenceProblems.join(" ")).toContain("log unavailable");
  expect(r.details.evidenceProblems.join(" ")).toContain("no artifact list");
});

test("concurrency counts agent sessions and command jobs together", async () => {
  const run = setup([{ id: "agent", agent: "codex", prompt: "x" }, { id: "cmd", agent: "command", command: ["true"] }], {}, 1);
  const order: string[] = [];
  const rt: SessionRuntime = {
    async create(r: Run, st: Step) { order.push(st.id); r.steps[st.id].cwd = st.cwd; },
    async exists(r: Run, id: string) { return order.includes(id) && run.workflow.steps.find(x => x.id === id)!.agent !== "command"; },
    async stop() {},
    async startCommand(r: Run, st: Step) { order.push(st.id); r.steps[st.id].status = "running"; r.steps[st.id].job = { id: "j", phase: "running" }; return { ok: true as const }; },
    async pollCommand() {},
  };
  await tick(run, rt, new NoTransport());
  expect(order).toEqual(["agent"]);
  await tick(run, rt, new NoTransport());
  expect(order).toEqual(["agent"]);
});

test("a continuation round takes its chain's host before looking for the retained worker there", async () => {
  const run = setup([{ id: "a", agent: "codex", prompt: "x", host: "mini" }, { id: "b", agent: "codex", prompt: "y", host: "mini", reuseSession: "a", dependsOn: ["a"] }], { mini: host("mini") });
  Object.assign(run.steps.a, { status: "done", host: "mini", remote: { dir: "/r" }, actor: "codex-12345678", result: { status: "done", summary: "ok" }, lifecycle: "retained" });
  const calls: string[] = [];
  const rt: SessionRuntime = {
    async create() { calls.push("create"); },
    async continue() { calls.push("continue"); },
    async exists(r: Run, id: string) { calls.push(`exists:${id}:${r.steps[id].host ?? "local"}`); return r.steps[id].host === "mini"; },
    async stop() {},
    remoteStep: (r: Run, id: string) => !!r.steps[id].host,
    async placeAgent(r: Run, st: Step) { calls.push("place"); r.steps[st.id].host = r.steps.a.host; r.steps[st.id].remote = { dir: "/r", cwd: "/r/c" }; return { ok: true as const }; },
    async sendTask() { calls.push("send"); },
  };
  await tick(run, rt, new NoTransport());
  expect(calls.indexOf("place")).toBeLessThan(calls.indexOf("exists:b:mini"));
  expect(calls).not.toContain("exists:b:local");
  expect(calls).toContain("continue");
  expect(calls).not.toContain("create");
});

test("bringing a remote worktree back refuses to overwrite local edits made since", async () => {
  const run = setup([{ id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true, host: "mini" }], { mini: host("mini") });
  const rt = router();
  expect(await rt.placeAgent(run, run.workflow.steps[0])).toEqual({ ok: true });
  writeFileSync(join(run.steps.impl.remote!.cwd!, "a.txt"), "one\n");
  Object.assign(run.steps.impl, { status: "done", result: { status: "done", summary: "ok" } });
  await rt.materialize(run, run.workflow.steps[0]);
  const wt = join(run.dir, "impl", "worktree");
  writeFileSync(join(wt, "a.txt"), "edited by a person\n");
  run.steps.impl.remote!.materialized = false;
  await expect(rt.materialize(run, run.workflow.steps[0])).rejects.toThrow("changed since sflow last wrote it");
  expect(readFileSync(join(wt, "a.txt"), "utf8")).toBe("edited by a person\n");
}, 60_000);

test("a finished agent session is closed so a later command step starts (concurrency 1)", async () => {
  const run = setup([{ id: "a", agent: "codex", prompt: "x" }, { id: "b", agent: "command", command: ["true"], dependsOn: ["a"] }], {}, 1);
  const live = new Set<string>(), started: string[] = [];
  const rt: SessionRuntime = {
    async create(r: Run, st: Step) { live.add(st.id); r.steps[st.id].cwd = st.cwd; },
    async exists(_r: Run, id: string) { return live.has(id); },
    async stop(_r: Run, id: string) { live.delete(id); },
    async startCommand(r: Run, st: Step) { started.push(st.id); r.steps[st.id].status = "running"; r.steps[st.id].job = { id: "j", phase: "running" }; return { ok: true as const }; },
    async pollCommand() {},
  };
  const tr = new NoTransport();
  await tick(run, rt, tr);
  expect(live.has("a")).toBe(true);
  Object.assign(run.steps.a, { status: "done", actor: "codex-12345678", result: { status: "done", summary: "ok" } });
  for (let i = 0; i < 3 && !started.length; i++) await tick(run, rt, tr);
  expect(started).toEqual(["b"]);
  expect(live.has("a")).toBe(false);
  expect(run.steps.a.lifecycle).toBe("closed");
});

test("a retained session that fills the only slot blocks a command step instead of leaving it pending", async () => {
  const run = setup([
    { id: "a", agent: "codex", prompt: "x" },
    { id: "b", agent: "command", command: ["true"], dependsOn: ["a"] },
    { id: "c", agent: "codex", prompt: "y", reuseSession: "a", dependsOn: ["b"] },
  ], {}, 1);
  const live = new Set<string>(["a"]);
  Object.assign(run.steps.a, { status: "done", actor: "codex-12345678", result: { status: "done", summary: "ok" }, lifecycle: "active" });
  const rt: SessionRuntime = {
    async create() {}, async exists(_r: Run, id: string) { return live.has(id); }, async stop(_r: Run, id: string) { live.delete(id); },
    async startCommand() { throw new Error("must not start"); },
  };
  await tick(run, rt, new NoTransport());
  expect(live.has("a")).toBe(true);
  expect(run.steps.a.lifecycle).toBe("retained");
  expect(run.steps.b.status).toBe("blocked");
  expect(run.steps.b.error).toContain("fill concurrency slots");
});

test("a busy host keeps the run going; the step waits up to its timeout, then is blocked with the reasons", async () => {
  const run = setup([{ id: "build", agent: "command", host: "mini", command: ["true"], timeoutSeconds: 60 }], { mini: host("mini") });
  const answers: ({ wait: string } | { ok: true })[] = [{ wait: "mini has no free slot" }, { wait: "mini has no free slot" }, { ok: true }];
  const rt: SessionRuntime = {
    async create() {}, async exists() { return false; }, async stop() {},
    async startCommand(r: Run) { const a = answers.shift()!; if ("ok" in a) Object.assign(r.steps.build, { status: "running" }); return a; },
    async pollCommand() {},
  };
  await tick(run, rt, new NoTransport());
  // One refusal used to end the whole run as blocked while the step still said pending.
  expect(run.status).toBe("running");
  expect(run.steps.build).toMatchObject({ status: "pending", error: "waiting for a host: mini has no free slot" });
  const since = run.steps.build.hostWaitSince!;
  await tick(run, rt, new NoTransport());
  expect(run.steps.build.hostWaitSince).toBe(since);
  await tick(run, rt, new NoTransport());
  expect(run.steps.build.status).toBe("running");
  expect(run.steps.build.hostWaitSince).toBeUndefined();
  // Waiting longer than the step's timeout ends it, with the last reason.
  const late = setup([{ id: "build", agent: "command", host: "mini", command: ["true"], timeoutSeconds: 60 }], { mini: host("mini") });
  const busy: SessionRuntime = { async create() {}, async exists() { return false; }, async stop() {}, async startCommand() { return { wait: "mini is busy (load 9.1 per core)" }; } };
  await tick(late, busy, new NoTransport());
  late.steps.build.hostWaitSince = Date.now() - 61_000;
  await tick(late, busy, new NoTransport());
  expect(late.steps.build).toMatchObject({ status: "blocked", error: "no host could take this step within 60s: mini is busy (load 9.1 per core)" });
  expect(late.status).toBe("blocked");
});

test("an agent step waiting for a host keeps the run going and is placed once a host frees up", async () => {
  const run = setup([{ id: "r", agent: "codex", prompt: "x", host: "mini" }], { mini: host("mini") });
  let free = false, placed = 0;
  const rt: SessionRuntime = {
    async create() {}, async exists() { return false; }, async stop() {},
    async placeAgent(r: Run) { if (!free) return { wait: "mini has no free slot" }; placed++; r.steps.r.host = "mini"; r.steps.r.remote = { dir: "/r", cwd: "/r/c" }; return { ok: true as const }; },
  };
  await tick(run, rt, new NoTransport());
  expect(run.status).toBe("running");
  expect(run.steps.r).toMatchObject({ status: "pending", error: "waiting for a host: mini has no free slot" });
  free = true;
  try { await tick(run, rt, new NoTransport()); } catch {}
  expect(placed).toBe(1);
  expect(run.steps.r.hostWaitSince).toBeUndefined();
});

test("the host lock is mutual exclusion across processes and dies with its holder", async () => {
  const home = join(base, "lock"), log = join(base, "lock.log");
  const remote = JSON.stringify(resolve(import.meta.dir, "../src/remote.ts"));
  // A leftover empty lock directory from an older layout must not matter.
  mkdirSync(join(home, "locks", "journal"), { recursive: true });
  const worker = join(base, "crit.ts");
  writeFileSync(worker, `import { withLock } from ${remote};\nimport { appendFileSync } from "node:fs";\nawait withLock(async () => { appendFileSync(${JSON.stringify(log)}, "in\\n"); await Bun.sleep(40); appendFileSync(${JSON.stringify(log)}, "out\\n"); });\n`);
  // A holder killed inside the critical section: the kernel releases its lock.
  const holder = join(base, "hold.ts");
  writeFileSync(holder, `import { withLock } from ${remote};\nawait withLock(async () => { console.log("held"); await Bun.sleep(60_000); });\n`);
  const h = Bun.spawn([process.execPath, holder], { env: { ...process.env, SFLOW_HOME: home }, stdout: "pipe" });
  const reader = h.stdout.getReader(); await reader.read();
  h.kill("SIGKILL"); await h.exited;
  const procs = Array.from({ length: 8 }, () => Bun.spawn([process.execPath, worker], { env: { ...process.env, SFLOW_HOME: home } }));
  expect((await Promise.all(procs.map(p => p.exited))).every(c => c === 0)).toBe(true);
  expect(readFileSync(log, "utf8")).toBe("in\nout\n".repeat(8));
}, 60_000);

test("a remote step gets copies of the logs and artifacts its dependencies' results name", async () => {
  const run = setup([
    { id: "c", agent: "command", command: ["sh", "-c", "echo evidence; mkdir -p o && echo art > o/a.txt"], artifacts: ["o"] },
    { id: "r", agent: "codex", prompt: "review", host: "mini", dependsOn: ["c"] },
  ], { mini: host("mini") });
  const rt = router();
  const c = run.workflow.steps[0], r = run.workflow.steps[1];
  run.steps.c.status = "launching"; run.steps.c.startedAt = Date.now();
  expect(await rt.startCommand(run, c)).toEqual({ ok: true });
  for (let i = 0; i < 200 && (run.steps.c.status as string) === "running"; i++) { await rt.pollCommand(run, c); await Bun.sleep(50); }
  expect(run.steps.c.status as string).toBe("done");
  expect(await rt.placeAgent(run, r)).toEqual({ ok: true });
  const { buildTask } = await import("../src/context");
  const task = await rt.remoteTask(run, r, buildTask(run, r));
  const map = (p: string) => { for (const [k, v] of Object.entries(task.pathMap!)) if (p.startsWith(k + "/")) return v + p.slice(k.length); return p; };
  const full = resolveResult(run, "c", run.steps.c.result!) as any;
  expect(full.artifacts.length).toBe(2);
  for (const a of full.artifacts as string[]) {
    expect(map(a)).not.toBe(a);
    expect(readFileSync(map(a))).toEqual(readFileSync(a));
  }
}, 60_000);

test("a prepare that fails after claiming a new slot gives the slot back", async () => {
  const run = setup([{ id: "r", agent: "codex", prompt: "x", host: "mini" }], { mini: host("mini") });
  const link = new SshLink("mini", run.hosts!.mini);
  const mirror = { version: run.version, id: run.id, channel: run.channel, createdAt: run.createdAt, status: "running", workflow: run.workflow,
    steps: { r: { status: "starting", token: run.steps.r.token, session: run.steps.r.session } } };
  await expect(link.call("prepare", { run: mirror, stepId: "r", slots: 1, driver: "t",
    checkouts: [{ repo: "0123456789abcdef", commit: "a".repeat(40), tree: "b".repeat(40), name: "r", local: project }] })).rejects.toThrow();
  const slots = join(base, "host-mini", "state", "slots");
  expect(existsSync(slots) ? readdirSync(slots) : []).toEqual([]);
}, 60_000);

test("evidence behind a symlink out of the step's directory is never sent to a host", async () => {
  const run = setup([{ id: "x", agent: "codex", prompt: "x" }, { id: "r", agent: "codex", prompt: "r", host: "mini", dependsOn: ["x"] }], { mini: host("mini") });
  const outside = join(base, "outside"); mkdirSync(outside); writeFileSync(join(outside, "secret"), "do not send\n");
  mkdirSync(join(run.dir, "x"), { recursive: true }); symlinkSync(outside, join(run.dir, "x", "link"));
  writeFileSync(join(run.dir, "x", "ok.txt"), "fine\n");
  Object.assign(run.steps.x, { status: "done", actor: "codex-12345678",
    result: { status: "done", summary: "x", artifacts: [join(run.dir, "x", "link", "secret"), join(run.dir, "x", "ok.txt")] } });
  const rt = router();
  expect(await rt.placeAgent(run, run.workflow.steps[1])).toEqual({ ok: true });
  const { buildTask } = await import("../src/context");
  const task = await rt.remoteTask(run, run.workflow.steps[1], buildTask(run, run.workflow.steps[1]));
  const remoteDir = run.steps.r.remote!.dir;
  expect(existsSync(join(remoteDir, "x", "link", "secret"))).toBe(false);
  expect(readFileSync(join(remoteDir, "x", "ok.txt"), "utf8")).toBe("fine\n");
  expect(task.evidenceNotCopied).toEqual([join(run.dir, "x", "link", "secret")]);
}, 60_000);

test("a failed prepare for a continuation round never releases the retained worker's slot", async () => {
  const run = setup([{ id: "a", agent: "codex", prompt: "x", host: "mini" }, { id: "b", agent: "codex", prompt: "y", host: "mini", reuseSession: "a", dependsOn: ["a"] }], { mini: host("mini") });
  Object.assign(run.steps.a, { status: "done", host: "mini", remote: { dir: "/r", cwd: "/r/c" }, actor: "codex-12345678", result: { status: "done", summary: "ok" } });
  const rt = router(), calls: string[] = [];
  (rt as any).links.set(`${run.id}:mini`, { name: "mini", gitUrl: () => "", gitEnv: () => ({}), fetch: async () => {},
    call: async (op: string) => { calls.push(op); if (op === "prepare") throw new Error("checkout failed"); if (op === "repo") return { path: "/x" }; return {}; } });
  (rt as any).freezeLocal = async () => ({ root: project, head: "h", commit: "c", tree: "t", repo: "0123456789abcdef" });
  (rt as any).send = async () => {};
  const r = await rt.placeAgent(run, run.workflow.steps[1]);
  expect("error" in r).toBe(true);
  expect(calls).toContain("prepare");
  expect(calls).not.toContain("release");
});

test("an assignment that was never sent blocks the step and gives a first round's host slot back", async () => {
  const run = setup([{ id: "r", agent: "codex", prompt: "x", host: "mini" }], { mini: host("mini") });
  const { NotSent } = await import("../src/hostrun");
  const stopped: string[] = [];
  const rt: SessionRuntime = {
    async create() { throw new Error("must not create"); }, async exists() { return false; },
    async stop(_r: Run, id: string) { stopped.push(id); },
    remoteStep: () => true,
    async placeAgent(r: Run, st: Step) { r.steps[st.id].host = "mini"; r.steps[st.id].remote = { dir: "/r", cwd: "/r/c" }; return { ok: true as const }; },
    async sendTask() { throw new NotSent("evidence upload failed"); },
  };
  await tick(run, rt, new NoTransport());
  expect(run.steps.r.status as string).toBe("blocked");
  expect(run.steps.r.error).toContain("assignment not sent");
  expect(stopped).toContain("r");
});

test("claiming a slot the owner already holds renews its time", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  expect(await claimSlot("step:x:a", 1)).toBe("new");
  const f = join(base, "solo", "slots", "0", "owner.json");
  writeFileSync(f, JSON.stringify({ owner: "step:x:a", since: 1 }));
  expect(await claimSlot("step:x:a", 1)).toBe("held");
  expect(Date.now() - JSON.parse(readFileSync(f, "utf8")).since).toBeLessThan(10_000);
});

test("an assignment that cannot be built also gives a first round's host slot back", async () => {
  const run = setup([{ id: "d", agent: "codex", prompt: "d" }, { id: "r", agent: "codex", prompt: "x", host: "mini", dependsOn: ["d"] }], { mini: host("mini") });
  // A done dependency whose result file reference is broken: the task cannot be built.
  Object.assign(run.steps.d, { status: "done", actor: "codex-12345678", result: { status: "done", summary: "d", fullResultFile: "/nope", sha256: "0".repeat(64), bytes: 1 } });
  const stopped: string[] = [];
  const rt: SessionRuntime = {
    async create() { throw new Error("must not create"); }, async exists() { return false; },
    async stop(_r: Run, id: string) { stopped.push(id); },
    remoteStep: (r: Run, id: string) => !!r.steps[id].host,
    async placeAgent(r: Run, st: Step) { r.steps[st.id].host = "mini"; r.steps[st.id].remote = { dir: "/r", cwd: "/r/c" }; return { ok: true as const }; },
    async sendTask() { throw new Error("must not send"); },
  };
  await tick(run, rt, new NoTransport());
  expect(run.steps.r.status as string).toBe("blocked");
  expect(stopped).toContain("r");
});

test("allowFailure passes a failing command on as a done result with its exit code", async () => {
  const run = setup([{ id: "t", agent: "command", command: ["sh", "-c", "echo boom; exit 2"], allowFailure: true }], {});
  const rt = router(), tr = new NoTransport();
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.t.status).toBe("done");
  const r = resolveResult(run, "t", run.steps.t.result!) as any;
  expect(r.details.exitCode).toBe(2);
  expect(r.summary).toContain("failure allowed");
  expect(() => parseWorkflow({ version: 1, name: "t", steps: [{ id: "a", agent: "codex", prompt: "x", cwd: project, allowFailure: true }] }, base)).toThrow("belong to");
}, 60_000);

test("a write step prefers a slot whose directory this project already has", async () => {
  const run = setup([{ id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true, host: "mini" }], { mini: host("mini", { slots: 3 }) });
  const rt = router();
  // Slot 0 is busy with something else, so the first run lands on slot 1.
  process.env.SFLOW_HOME = join(base, "host-mini", "state");
  expect(await claimSlot("step:other:x", 3)).toBe("new");
  delete process.env.SFLOW_HOME; process.env.SFLOW_HOME = join(base, "driver");
  expect(await rt.placeAgent(run, run.workflow.steps[0])).toEqual({ ok: true });
  const first = run.steps.impl.remote!.cwd!;
  expect(first.endsWith("/1")).toBe(true);
  await rt.stop(run, "impl").catch(() => {});
  await new SshLink("mini", run.hosts!.mini).call("release", { runId: run.id, root: "impl" });
  process.env.SFLOW_HOME = join(base, "host-mini", "state");
  await (await import("../src/remote")).releaseSlot("step:other:x");
  process.env.SFLOW_HOME = join(base, "driver");
  // Slot 0 is free now, but the next run goes back to the directory it already trusted.
  const second = setup([{ id: "impl", agent: "codex", prompt: "x", policy: "workspace-write", worktree: true, host: "mini" }], { mini: run.hosts!.mini });
  expect(await rt.placeAgent(second, second.workflow.steps[0])).toEqual({ ok: true });
  expect(second.steps.impl.remote!.cwd).toBe(first);
}, 60_000);

for (const target of ["local", "mini"]) test(`input none on ${target} starts empty, returns honest evidence and cleans its directory`, async () => {
  const plain = join(base, "plain"); mkdirSync(plain); writeFileSync(join(plain, "private"), "not an input");
  const run = setup([{ id: "probe", cwd: plain, agent: "command", input: "none", ...(target === "mini" ? { host: "mini" } : {}),
    command: ["sh", "-c", 'test -z "$(ls -A)" && pwd && touch temporary-output'] }], target === "mini" ? { mini: host("mini") } : {});
  const rt = router(), tr = new NoTransport();
  expect(run.version).toBe(5);
  // No call may freeze the source or ask any host to receive code.
  (rt as any).freezeLocal = async () => { throw new Error("must not freeze"); };
  (rt as any).send = async () => { throw new Error("must not transfer"); };
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.probe.status).toBe("done");
  const r = resolveResult(run, "probe", run.steps.probe.result!) as any;
  expect(r.details).toMatchObject({ input: "none", inputCommit: null, inputTree: null, inputHead: null, exitCode: 0 });
  expect(r.details.argvSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.details.log.sha256).toMatch(/^[a-f0-9]{64}$/);
  expect(r.details.workingDirectory).toContain(`/jobs/${run.steps.probe.job!.id}/work`);
  expect(existsSync(r.details.workingDirectory)).toBe(false);
  expect(readdirSync(plain)).toEqual(["private"]);
  expect(existsSync(join(run.dir, "objects"))).toBe(false);
  if (target === "mini") expect(existsSync(join(base, "host-mini", "state", "repos"))).toBe(false);
});

test("input none is explicit and cannot borrow a workspace, return artifacts or apply to an agent", () => {
  const plain = join(base, "plain"); mkdirSync(plain);
  const wf = (extra: object) => parseWorkflow({ version: 1, name: "t", steps: [{ id: "a", agent: "command", command: ["true"], cwd: plain, ...extra }] }, base);
  expect(wf({ input: "none" }).steps[0].input).toBe("none");
  // Context-only cwd can contain the state roots: it is never sent or executed in.
  expect(wf({ input: "none", cwd: base }).steps[0].cwd).toBe(base);
  for (const extra of [{}, { input: "snapshot" }]) expect(() => wf(extra)).toThrow("Git checkout");
  expect(() => wf({ input: "wrong" })).toThrow("input must");
  expect(() => wf({ input: "none", workspace: "x" })).toThrow("cannot use workspace or artifacts");
  expect(() => wf({ input: "none", artifacts: [] })).toThrow("cannot use workspace or artifacts");
  expect(() => wf({ input: "none", agent: "codex", prompt: "x", command: undefined })).toThrow("belong to agent");
});

test("input none adopts a lost start answer without starting another command", async () => {
  const run = setup([{ id: "a", agent: "command", input: "none", host: "mini", command: ["sh", "-c", 'echo x >> "$HOME/count"'] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("running");
  run.steps.a.status = "launching"; run.steps.a.job!.phase = "starting"; saveRun(run);
  const recovered = (await import("../src/store")).loadRun(run.id);
  await until(recovered, router(), tr, () => recovered.status !== "running");
  expect(recovered.steps.a.status).toBe("done");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
});

test("input none with an unknown start stays uncertain and is never sent to another host", async () => {
  const run = setup([{ id: "a", agent: "command", input: "none", host: ["mini", "other"], command: ["true"] }], { mini: host("mini"), other: host("other") });
  const rt = router(), tr = new NoTransport();
  let starts = 0;
  for (const name of ["mini", "other"]) {
    const link = rt.link(run, name), call = link.call.bind(link);
    link.call = async (op, input, timeout) => { if (op === "job-start") { starts++; throw new Error("connection lost"); } return call(op, input, timeout); };
  }
  await tick(run, rt, tr); await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("uncertain");
  expect(starts).toBe(1);
});

test("input none rejects snapshot receipts and older remote protocols", async () => {
  const run = setup([{ id: "a", agent: "command", input: "none", host: "mini", command: ["true"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  const link = rt.link(run, "mini"), call = link.call.bind(link);
  link.call = async (op, input, timeout) => {
    const r = await call<any>(op, input, timeout);
    return op === "job-status" && r.spec ? { ...r, spec: { ...r.spec, input: "snapshot" } } : r;
  };
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("blocked");
  expect(run.steps.a.error).toContain("does not match");
  const old = setup([{ id: "a", agent: "command", input: "none", host: "mini", command: ["true"] }], { mini: host("mini") });
  const oldRt = router(), oldLink = oldRt.link(old, "mini"), oldCall = oldLink.call.bind(oldLink);
  oldLink.call = async (op, input, timeout) => { const r = await oldCall<any>(op, input, timeout); return op === "hello" ? { ...r, protocol: REMOTE_PROTOCOL - 1 } : r; };
  await tick(old, oldRt, tr);
  expect(old.steps.a.status).toBe("blocked");
  expect(old.steps.a.error).toContain("protocol");
});

test("doctor checks a remote command on its host without executing it or asking for an AI login", async () => {
  const { doctor } = await import("../src/doctor");
  const { saveHosts } = await import("../src/hosts");
  saveHosts({ mini: host("mini") });
  const tmux = join(base, "tmux-version"), ocs = join(base, "ocs-version");
  for (const [p, out] of [[tmux, "tmux 3.5"], [ocs, "ocs 0.8.3"]]) { writeFileSync(p, `#!/bin/sh\necho '${out}'\n`); chmodSync(p, 0o700); }
  const workflow = parseWorkflow({ version: 1, name: "doctor-command", steps: [
    { id: "probe", agent: "command", host: "mini", cwd: project, command: ["sh", "-c", `touch '${join(base, "should-not-exist")}'`] },
    { id: "missing", agent: "command", input: "none", cwd: project, command: ["no-such-sflow-command"] }
  ] }, base);
  const checks = await doctor({ tmux, ocs, workflow });
  expect(checks.find(c => c.name === "probe command")).toMatchObject({ level: "ok", detail: expect.stringContaining("found, not executed") });
  expect(checks.find(c => c.name === "missing command")).toMatchObject({ level: "fail" });
  expect(checks.some(c => /login|codex|^command$/.test(c.name))).toBe(false);
  expect(existsSync(join(base, "should-not-exist"))).toBe(false);
  expect(existsSync(join(base, "host-mini", "state", "jobs"))).toBe(false);
});

test("input none cancellation closes its process group, cleans work and retains a no-restart tombstone", async () => {
  const run = setup([{ id: "a", agent: "command", input: "none", host: "mini", command: ["sh", "-c", 'echo x >> "$HOME/count"; sleep 30'] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport();
  await tick(run, rt, tr);
  const link = rt.link(run, "mini"), jobId = run.steps.a.job!.id;
  let started = false;
  const count = join(base, "host-mini", "count");
  for (let i = 0; i < 100 && !started; i++) {
    const state = await link.call<any>("job-status", { jobId });
    // started.json is written after spawn, before the child necessarily executes echo.
    started = !!state.started && existsSync(count) && readFileSync(count, "utf8") === "x\n";
    if (!started) await Bun.sleep(30);
  }
  expect(started).toBe(true);
  await rt.cancelCommand(run, run.workflow.steps[0], "manual test cancellation");
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("failed");
  expect(existsSync(join(base, "host-mini", "state", "jobs", jobId, "work"))).toBe(false);
  expect(readdirSync(join(base, "host-mini", "state", "slots"))).toEqual([]);
  await link.call("gc", { days: 0 });
  expect((await link.call<any>("job-status", { jobId })).state).toBe("removed");
  expect((await link.call<any>("job-start", { jobId, input: "none", argv: ["true"], artifacts: [], slots: 2 })).state).toBe("exists");
  expect(readFileSync(join(base, "host-mini", "count"), "utf8")).toBe("x\n");
});

test("protocol-3 hosts without new capabilities keep snapshot commands, but refuse input none before dispatch", async () => {
  const run = setup([{ id: "a", agent: "command", host: "mini", command: ["true"] }], { mini: host("mini") });
  const rt = router(), tr = new NoTransport(), link = rt.link(run, "mini"), call = link.call.bind(link);
  link.call = async (op, input, timeout) => {
    const r = await call<any>(op, input, timeout);
    if (op === "hello") delete r.capabilities;
    return r;
  };
  await until(run, rt, tr, () => run.status !== "running");
  expect(run.steps.a.status).toBe("done");
  const none = setup([{ id: "a", agent: "command", input: "none", host: "mini", command: ["true"] }], { mini: host("mini") });
  const nr = router(), nl = nr.link(none, "mini"), nc = nl.call.bind(nl);
  let starts = 0;
  nl.call = async (op, input, timeout) => { if (op === "job-start") starts++; const r = await nc<any>(op, input, timeout); if (op === "hello") delete r.capabilities; return r; };
  await tick(none, nr, tr);
  expect(none.steps.a.status).toBe("blocked");
  expect(none.steps.a.error).toContain("sflow hosts upgrade mini");
  expect(starts).toBe(0);
});

test("a record-5 workflow sends only a record-4 native-agent mirror to a legacy host", async () => {
  const run = setup([{ id: "env", agent: "command", input: "none", command: ["true"] },
    { id: "look", agent: "codex", host: "mini", prompt: "inspect" }], { mini: host("mini") });
  expect(run.version).toBe(5);
  const rt = router(), link = rt.link(run, "mini"), call = link.call.bind(link);
  let mirrorVersion: number | undefined;
  link.call = async (op, input: any, timeout) => {
    if (op === "prepare") { mirrorVersion = input.run.version; if (mirrorVersion !== 4) throw new Error("legacy host rejects record 5"); }
    const r = await call<any>(op, input, timeout); if (op === "hello") delete r.capabilities; return r;
  };
  expect(await rt.placeAgent(run, run.workflow.steps[1])).toEqual({ ok: true });
  expect(mirrorVersion).toBe(4);
});

test("doctor defers command lookup on an older protocol-3 host instead of rejecting its executable", async () => {
  const { doctor } = await import("../src/doctor"), { saveHosts } = await import("../src/hosts");
  saveHosts({ mini: host("mini") });
  const tmux = join(base, "tmux-version"), ocs = join(base, "ocs-version");
  for (const [p, out] of [[tmux, "tmux 3.5"], [ocs, "ocs 0.8.3"]]) { writeFileSync(p, `#!/bin/sh\necho '${out}'\n`); chmodSync(p, 0o700); }
  const workflow = parseWorkflow({ version: 1, name: "old-host", steps: [{ id: "probe", agent: "command", host: "mini", cwd: project, command: ["sh", "-c", "true"] }] }, base);
  const original = SshLink.prototype.call; let lookups = 0;
  SshLink.prototype.call = async function(op, input, timeout) {
    if (op === "command-check") { lookups++; throw new Error("old host has no such operation"); }
    const r: any = await original.call(this, op, input, timeout); if (op === "hello") delete r.capabilities; return r;
  };
  try {
    const checks = await doctor({ tmux, ocs, workflow });
    expect(checks.some(c => c.level === "fail")).toBe(false);
    expect(checks.find(c => c.name === "probe command")).toMatchObject({ level: "skip", detail: expect.stringContaining("sflow hosts upgrade mini") });
    expect(lookups).toBe(0);
  } finally { SshLink.prototype.call = original; }
});
