import { test, expect, afterEach, beforeEach } from "bun:test";
import { realpathSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, chmodSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseWorkflow } from "../src/config";
import { createRun, saveRun } from "../src/store";
import { tick, reconcile } from "../src/engine";
import { HostRouter } from "../src/hostrun";
import { TmuxRuntime } from "../src/runtime";
import { SshLink, parseHost, candidates, unfit } from "../src/hosts";
import { freezeHosts } from "../src/hosts-cli";
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
export HOME="${base}/host-$name" SFLOW_HOME="${base}/host-$name/state"
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
    { id: "a", agent: "command", host: "mini", command: ["sh", "-c", "sleep 1"] },
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
  const hello = { protocol: 1, version: "x", home: "/", arch: "arm64", platform: "darwin", cpus: 10, load: 4, freeGB: 3.7, tools: {}, slots: [] };
  expect(unfit("x", h, hello)).toContain("3.7 GB free");
  expect(unfit("x", h, { ...hello, load: 8, freeGB: 50 })).toContain("busy");
  expect(unfit("x", h, { ...hello, protocol: 99 })).toContain("protocol");
});

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
  expect(existsSync(remoteCwd)).toBe(false);
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
import { claimSlot, jobCancel, jobExec, jobStatus } from "../src/remote";
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

test("a slot whose runner died but whose command group lives is not reclaimed", async () => {
  process.env.SFLOW_HOME = join(base, "solo");
  const id = "00000000-0000-0000-0000-000000000000-a", dir = join(base, "solo", "jobs", id);
  mkdirSync(dir, { recursive: true });
  const sleeper = Bun.spawn(["sh", "-c", "sleep 20"], { stdio: ["ignore", "ignore", "ignore"], detached: true } as any);
  writeFileSync(join(dir, "runner.json"), JSON.stringify({ pid: 999_999 }));
  writeFileSync(join(dir, "started.json"), JSON.stringify({ pid: sleeper.pid, pgid: sleeper.pid }));
  expect(await claimSlot(`job:${id}`, 1)).toBe(true);
  try {
    expect(await claimSlot("job:other", 1)).toBe(false);
    expect((jobStatus({ jobId: id }) as any).state).toBe("running");
  } finally { process.kill(-sleeper.pid!, "SIGKILL"); }
  await Bun.sleep(100);
  expect(await claimSlot("job:other", 1)).toBe(true);
}, 30_000);

test("concurrent claimers on one host never share a slot", async () => {
  const home = join(base, "race");
  const script = join(base, "claim.ts");
  writeFileSync(script, `import { claimSlot } from ${JSON.stringify(resolve(import.meta.dir, "../src/remote.ts"))};\nconsole.log(await claimSlot(process.argv[2], 1));\n`);
  const procs = Array.from({ length: 8 }, (_, i) => Bun.spawn([process.execPath, script, `step:r:${i}`], { env: { ...process.env, SFLOW_HOME: home }, stdout: "pipe" }));
  const outs = await Promise.all(procs.map(p => new Response(p.stdout).text()));
  expect(outs.filter(o => o.trim() === "true").length).toBe(1);
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
