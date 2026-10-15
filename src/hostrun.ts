import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { dirname, join, relative } from "node:path";
import { checked } from "./process";
import { saveRun } from "./store";
import { sessionRoot, workspaceRoot } from "./config";
import { candidates, LocalLink, SshLink, unfit, type Hello, type Link } from "./hosts";
import { freeze, push, type Frozen } from "./gitsync";
import { resolveResult, resultFile, storeResult } from "./results";
import { field, parseBody } from "./engine";
import { safeRelative } from "./remote";
import type { Menu } from "./prompt";
import { diagnoseScreen, parseMenu } from "./prompt";
import type { Message, Run, SessionRuntime, Step, TaskEvent, WorkerEvent } from "./types";
import type { TmuxRuntime } from "./runtime";

const POLL_MS = Number(process.env.SFLOW_POLL_MS ?? 3000);
type Outcome = { ok: true } | { wait: string } | { error: string };

// Steps placed on other machines, and command steps anywhere. Local agent steps go to tmux unchanged.
export class HostRouter implements SessionRuntime {
  private links = new Map<string, Link>();
  private hellos = new Map<string, { at: number; hello?: Hello; error?: string }>();
  private polled = new Map<string, number>();
  constructor(readonly local: TmuxRuntime, readonly cli: string[]) {}
  get binary() { return this.local.binary; }

  link(run: Run, name: string): Link {
    const key = `${run.id}:${name}`;
    let l = this.links.get(key);
    if (!l) {
      if (name === "local") l = new LocalLink(this.cli);
      else {
        const config = run.hosts?.[name];
        if (!config) throw new Error(`host ${name} is not frozen in this run`);
        l = new SshLink(name, config);
      }
      this.links.set(key, l);
    }
    return l;
  }
  async probe(run: Run, name: string): Promise<{ hello?: Hello; error?: string }> {
    const cached = this.hellos.get(name);
    if (cached && Date.now() - cached.at < 10_000) return cached;
    let entry: { at: number; hello?: Hello; error?: string };
    try {
      const hello = await this.link(run, name).call<Hello>("hello", {}, 20_000);
      const why = name === "local" ? null : unfit(name, run.hosts![name], hello);
      entry = { at: Date.now(), hello, ...(why ? { error: why } : {}) };
    } catch (e) { entry = { at: Date.now(), error: (e as Error).message }; }
    this.hellos.set(name, entry); return entry;
  }
  // Fit hosts first, least loaded per core; the rest with their reasons.
  private async ranked(run: Run, step: Step, need?: string) {
    const names = candidates(step.host!, run.hosts ?? {});
    const fit: { name: string; hello: Hello }[] = [], reasons: string[] = [];
    let hard = 0;
    for (const name of names) {
      const p = await this.probe(run, name);
      if (p.hello && need && !p.hello.tools[need]) { reasons.push(`${name} has no ${need}`); hard++; continue; }
      if (p.error || !p.hello) { reasons.push(p.error ?? `${name}: no answer`); if (!p.hello || p.error?.includes("protocol")) hard++; continue; }
      fit.push({ name, hello: p.hello });
    }
    fit.sort((a, b) => a.hello.load / a.hello.cpus - b.hello.load / b.hello.cpus);
    return { fit, reasons, allHard: hard === names.length };
  }
  private objects(run: Run) { return join(run.dir, "objects"); }
  private async send(run: Run, link: Link, frozen: Frozen, commit: string, ref: string) {
    const { path } = await link.call<{ path: string }>("repo", { repo: frozen.repo });
    await push(frozen.root, this.objects(run), link.gitUrl(path), commit, ref, link.gitEnv());
  }
  // What a reader on another machine sees: the files of a checkout or worktree, frozen now.
  private async freezeLocal(run: Run, cwd: string) { return freeze(cwd, this.objects(run)); }
  private hostOf(run: Run, step: Step): string | undefined {
    // Chains stay where they started.
    const anchor = step.reuseSession ? sessionRoot(run.workflow.steps, step) : step.workspace ? workspaceRoot(run.workflow.steps, step) : undefined;
    return anchor && anchor !== step.id ? run.steps[anchor].host : run.steps[step.id].host;
  }
  remoteStep(run: Run, id: string): boolean {
    const s = run.steps[id], step = run.workflow.steps.find(x => x.id === id)!;
    return step.agent !== "command" && !!s.host && s.host !== "local";
  }

  // ---- agent steps on a host ----
  async placeAgent(run: Run, step: Step): Promise<Outcome> {
    const s = run.steps[step.id];
    const fixed = this.hostOf(run, step);
    const tries = fixed ? [fixed] : s.host ? [s.host] : null;
    let names: string[], reasons: string[] = [], allHard = false;
    if (tries) names = tries;
    else { const r = await this.ranked(run, step, step.agent); names = r.fit.map(f => f.name); reasons = r.reasons; allHard = r.allHard; }
    for (const name of names) {
      s.host = name; saveRun(run);
      try {
        const r = await this.prepare(run, step, name);
        if (r === "ready") return { ok: true };
        reasons.push(`${name} has no free slot`);
      } catch (e) {
        reasons.push((e as Error).message);
        // Only a first round may give its session's slot back; a continuation's slot belongs to the
        // retained worker it continues.
        if (sessionRoot(run.workflow.steps, step) === step.id)
          await this.link(run, name).call("release", { runId: run.id, root: step.id }).catch(() => {});
        if (tries) { s.error = `preparing on ${name} failed: ${(e as Error).message}`; return { error: s.error }; }
      }
      if (!tries) { delete s.host; delete s.remote; saveRun(run); }
    }
    if (tries) return { wait: reasons.join("; ") };
    return allHard ? { error: `no host can run this step: ${reasons.join("; ")}` } : { wait: reasons.join("; ") || "no host available" };
  }
  private mirror(run: Run, name: string, step: Step) {
    const ids = new Set([step.id, ...run.workflow.steps.filter(x => run.steps[x.id].host === name && run.steps[x.id].remote).map(x => x.id)]);
    const steps = run.workflow.steps.filter(x => ids.has(x.id)).map(x => {
      const { host: _h, ...rest } = x;
      const writeRoot = x.policy === "workspace-write" && x.workspace === undefined;
      return writeRoot ? { ...rest, worktree: undefined, inPlace: true } : rest;
    });
    return { version: run.version, id: run.id, channel: run.channel, createdAt: run.createdAt, status: "running",
      workflow: { ...run.workflow, steps },
      steps: Object.fromEntries([...ids].map(id => [id, { status: "starting", token: run.steps[id].token, session: run.steps[id].session,
        ...(run.steps[id].actor ? { actor: run.steps[id].actor } : {}) }])) };
  }
  private async prepare(run: Run, step: Step, name: string): Promise<"ready" | "busy"> {
    const link = this.link(run, name), s = run.steps[step.id];
    const checkouts: Record<string, unknown>[] = [];
    let base: string | undefined;
    if (step.policy === "workspace-write" && step.workspace === undefined) {
      // A write step starts from HEAD, as a local worktree does.
      const frozen = await this.freezeLocal(run, step.cwd);
      base = frozen.head;
      const tree = (await checked(["git", "-C", frozen.root, "rev-parse", `${base}^{tree}`])).trim();
      await this.send(run, link, frozen, base, `refs/sflow/${run.id}/${step.id}-base`);
      checkouts.push({ repo: frozen.repo, commit: base, tree, name: step.id, branch: `sflow/${run.id}/${step.id}`, local: step.cwd });
    } else if (step.policy === "read-only") {
      const frozen = await this.freezeLocal(run, step.cwd);
      await this.send(run, link, frozen, frozen.commit, `refs/sflow/${run.id}/${step.id}`);
      checkouts.push({ repo: frozen.repo, commit: frozen.commit, tree: frozen.tree, name: step.id, local: step.cwd,
        sub: relative(frozen.root, realpathSync(step.cwd)) || "." });
      // Worktrees earlier write steps left on the driver, so dependency paths resolve there too.
      for (const anc of ancestors(run, step)) {
        const wt = join(run.dir, anc, "worktree");
        if (!existsSync(wt)) continue;
        const f = await this.freezeLocal(run, wt);
        await this.send(run, link, f, f.commit, `refs/sflow/${run.id}/${step.id}-${anc}`);
        checkouts.push({ repo: f.repo, commit: f.commit, tree: f.tree, name: `${step.id}-${anc}`, local: wt });
      }
    }
    const r = await link.call<{ state: string; dir: string; cwd: string; pathMap: Record<string, string> }>("prepare",
      { run: this.mirror(run, name, step), stepId: step.id, slots: run.hosts![name].slots, checkouts, driver: hostname() }, 900_000);
    if (r.state !== "ready") return "busy";
    s.remote = { dir: r.dir, cwd: r.cwd, pathMap: { [run.dir]: r.dir, ...r.pathMap }, ...(base ? { base } : {}) };
    saveRun(run); return "ready";
  }
  // The assignment as the remote worker must read it: its paths, and copies of the result files it names.
  async remoteTask(run: Run, step: Step, task: TaskEvent): Promise<TaskEvent> {
    const s = run.steps[step.id], link = this.link(run, s.host!);
    const root = run.workflow.steps.find(x => x.id === workspaceRoot(run.workflow.steps, step))!;
    const workspace = step.policy === "workspace-write" ? run.steps[root.id].remote?.cwd ?? s.remote!.cwd! : s.remote!.cwd!;
    const files: { name: string; base64: string; sha256: string; local: string }[] = [];
    const upload = (path: string) => {
      const body = readFileSync(path), name = path.split("/").pop()!;
      files.push({ name, base64: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex"), local: path });
    };
    const refs: Record<string, unknown>[] = [];
    for (const dep of Object.values(task.dependencies)) if (typeof dep.resultFile === "string") { upload(dep.resultFile); refs.push(dep); }
    let manifest: Record<string, any> | undefined;
    if (task.dependencyManifest) {
      manifest = JSON.parse(readFileSync(task.dependencyManifest.path, "utf8"));
      for (const v of Object.values(manifest!)) if (typeof v?.resultFile === "string") upload(v.resultFile);
    }
    const { paths } = files.length ? await link.call<{ paths: Record<string, string> }>("put", { runId: run.id, files: files.map(({ local: _, ...f }) => f) }) : { paths: {} };
    // Logs and artifacts a dependency's result names inside this run go along at the same relative
    // path, so the run-directory entry in pathMap leads to real files there.
    const evidence: { rel: string; base64: string; sha256: string }[] = [], skipped: string[] = [];
    for (const id of step.dependsOn) {
      if (run.steps[id].status === "skipped" || !run.steps[id].result) continue;
      let full: Record<string, unknown>;
      try { full = resolveResult(run, id, run.steps[id].result!); } catch { continue; }
      let own: string; try { own = realpathSync(join(run.dir, id)); } catch { continue; }
      for (const a of Array.isArray(full.artifacts) ? full.artifacts : []) {
        if (typeof a !== "string" || !a.startsWith(join(run.dir, id) + "/")) continue;
        // The resolved file, not the spelling, must be inside the step's own directory: a symlink in a
        // worktree must not send this machine's other files to the host.
        let real: string; try { real = realpathSync(a); } catch { continue; }
        if (!real.startsWith(own + "/")) { skipped.push(a); continue; }
        let st; try { st = lstatSync(real); } catch { continue; }
        if (!st.isFile()) continue;
        if (st.size > 32 * 1024 * 1024) { skipped.push(a); continue; }
        const body = readFileSync(real);
        evidence.push({ rel: relative(run.dir, a), base64: body.toString("base64"), sha256: createHash("sha256").update(body).digest("hex") });
      }
    }
    // Batches by size, not count: one ssh call carries at most ~16 MB of files (one file may exceed it alone).
    for (let i = 0; i < evidence.length;) {
      const batch = [evidence[i++]];
      let bytes = batch[0].base64.length;
      while (i < evidence.length && bytes + evidence[i].base64.length <= 16 * 1024 * 1024) { bytes += evidence[i].base64.length; batch.push(evidence[i++]); }
      await link.call("put", { runId: run.id, files: batch }, 300_000);
    }
    const moved = (p: string) => paths[p.split("/").pop()!] ?? p;
    const out: TaskEvent = { ...task, workspace, pathMap: s.remote?.pathMap, ...(skipped.length ? { evidenceNotCopied: skipped } : {}) };
    delete out.workspaceObservation;
    out.dependencies = Object.fromEntries(Object.entries(task.dependencies).map(([k, v]) => [k, typeof v.resultFile === "string" ? { ...v, resultFile: moved(v.resultFile) } : v]));
    if (manifest) {
      const body = JSON.stringify(Object.fromEntries(Object.entries(manifest).map(([k, v]) => [k, typeof v?.resultFile === "string" ? { ...v, resultFile: moved(v.resultFile) } : v]))) + "\n";
      const b = Buffer.from(body), name = `${step.id}-dependencies.json`, sha256 = createHash("sha256").update(b).digest("hex");
      const r = await link.call<{ paths: Record<string, string> }>("put", { runId: run.id, files: [{ name, base64: b.toString("base64"), sha256 }] });
      out.dependencyManifest = { path: r.paths[name], sha256, count: task.dependencyManifest!.count };
    }
    return out;
  }
  async sendTask(run: Run, step: Step, task: TaskEvent) {
    let body: TaskEvent;
    // Before anything is sent the outcome is known: nothing reached the worker's channel.
    try { body = await this.remoteTask(run, step, task); } catch (e) { throw new NotSent((e as Error).message); }
    // Remote paths can make the assignment longer than the one checked before placement.
    if (Buffer.byteLength(JSON.stringify(body)) > 99000) throw new NotSent("assignment exceeds the OCS message limit once paths are mapped to the host");
    await this.link(run, run.steps[step.id].host!).call("send", { runId: run.id, body });
  }
  // Each host's channel, tagged; terminal results are copied next to local ones and hash-checked.
  async remoteRows(run: Run): Promise<Message[]> {
    const hosts = new Set(run.workflow.steps.filter(x => this.remoteStep(run, x.id) && run.steps[x.id].remote).map(x => run.steps[x.id].host!));
    const rows: Message[] = [];
    for (const name of hosts) {
      const link = this.link(run, name);
      const got = await link.call<Message[]>("read", { runId: run.id });
      for (const row of got) {
        rows.push({ ...row, host: name });
        const e = parseBody(row) as WorkerEvent | null;
        const ref = e?.result as Record<string, unknown> | undefined;
        if (!e || e.type !== "sflow.worker" || e.runId !== run.id || !run.steps[e.stepId] || run.steps[e.stepId].host !== name) continue;
        if (!ref || typeof ref.fullResultFile !== "string" || typeof ref.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(ref.sha256)) continue;
        const local = resultFile(run, e.stepId, ref.sha256);
        if (existsSync(local)) continue;
        mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
        const temp = `${local}.fetch`;
        try {
          await link.fetch("file", { runId: run.id, path: ref.fullResultFile }, temp, 60_000);
          const body = readFileSync(temp);
          if (body.length <= 128 * 1024 && createHash("sha256").update(body).digest("hex") === ref.sha256) writeFileSync(local, body, { mode: 0o600 });
        } catch {} finally { rmSync(temp, { force: true }); }
      }
    }
    return rows;
  }
  // A remote write step's changes, as uncommitted edits in the run-owned local worktree.
  async materialize(run: Run, step: Step) {
    const s = run.steps[step.id];
    if (!this.remoteStep(run, step.id) || step.policy !== "workspace-write" || !s.result || s.remote?.materialized) return;
    const rootId = workspaceRoot(run.workflow.steps, step), root = run.workflow.steps.find(x => x.id === rootId)!;
    const base = run.steps[rootId].remote?.base;
    if (!base) throw new Error("remote write step has no recorded base commit");
    // The host freezes its worktree and names the patch by hash; the copy here must match it.
    const link = this.link(run, s.host!);
    const made = await link.call<{ path: string; sha256: string; bytes: number; base: string; commit: string; tree: string }>("patch", { runId: run.id, stepId: step.id, base }, 600_000);
    if (made.base !== base) throw new Error("the host made its patch against another base");
    const patch = join(run.dir, step.id, `remote-${made.sha256.slice(0, 16)}.patch`);
    mkdirSync(dirname(patch), { recursive: true, mode: 0o700 });
    await link.fetch("file", { runId: run.id, path: made.path }, patch, 600_000);
    const got = readFileSync(patch);
    if (got.length !== made.bytes || createHash("sha256").update(got).digest("hex") !== made.sha256) throw new Error("the patch changed in transfer (hash mismatch)");
    const wt = join(run.dir, rootId, "worktree");
    if (existsSync(wt)) {
      // Replace only what sflow itself put there last time; any later edit is someone's work.
      const now = (await freeze(wt, this.objects(run))).tree, last = run.steps[rootId].remote?.localTree;
      if (!last || now !== last) throw new Error(`${wt} changed since sflow last wrote it; inspect it, then remove it yourself before resuming`);
      await checked(["git", "-C", root.cwd, "worktree", "remove", "--force", wt]);
    }
    await checked(["git", "-C", root.cwd, "worktree", "add", "--quiet", "-B", `sflow/${run.id}/${rootId}`, wt, base]);
    if (got.length) await checked(["git", "-C", wt, "apply", "--binary", "--whitespace=nowarn", patch], { timeoutMs: 300_000 });
    const tree = (await freeze(wt, this.objects(run))).tree;
    if (tree !== made.tree) throw new Error(`applying the patch gave tree ${tree}, the host had ${made.tree}`);
    run.steps[rootId].remote = { ...run.steps[rootId].remote!, localTree: tree };
    s.remote = { ...s.remote!, materialized: true };
    if (rootId !== step.id) run.steps[rootId].cwd = wt;
    s.cwd = wt; saveRun(run);
  }
  async finish(run: Run) {
    const hosts = new Set(Object.values(run.steps).filter(s => s.remote && s.host && s.host !== "local").map(s => s.host!));
    for (const name of hosts) await this.link(run, name).call("cleanup", { runId: run.id }, 600_000).catch(() => {});
  }

  // ---- SessionRuntime, routed ----
  async create(run: Run, step: Step) {
    if (!this.remoteStep(run, step.id)) return this.local.create(run, step);
    const r = await this.link(run, run.steps[step.id].host!).call<{ cwd: string }>("rt", { runId: run.id, stepId: step.id, action: "create" }, 900_000);
    run.steps[step.id].cwd = r.cwd;
  }
  async continue(run: Run, step: Step) {
    if (!this.remoteStep(run, step.id)) return this.local.continue(run, step);
    const link = this.link(run, run.steps[step.id].host!), prev = run.steps[step.reuseSession!];
    // The mirror needs the previous round's outcome, not this machine's path to its result file.
    await link.call("step", { runId: run.id, stepId: step.reuseSession, state: { status: prev.status, actor: prev.actor,
      result: prev.result ? { status: prev.result.status, summary: prev.result.summary } : undefined } });
    await link.call("rt", { runId: run.id, stepId: step.id, action: "continue" });
  }
  async exists(run: Run, id: string) {
    const step = run.workflow.steps.find(x => x.id === id)!;
    if (step.agent === "command") return false;
    if (!this.remoteStep(run, id)) return this.local.exists(run, id);
    if (!run.steps[id].remote) return false;
    return (await this.link(run, run.steps[id].host!).call<{ exists: boolean }>("rt", { runId: run.id, stepId: id, action: "exists" })).exists;
  }
  async stop(run: Run, id: string) {
    const step = run.workflow.steps.find(x => x.id === id)!;
    if (step.agent === "command") return this.cancelCommand(run, step, "cancelled");
    if (!this.remoteStep(run, id)) return this.local.stop(run, id);
    const s = run.steps[id];
    if (!s.remote) return;
    const link = this.link(run, s.host!);
    await link.call("rt", { runId: run.id, stepId: id, action: "stop" });
    // The host archived the screen on stop; keep a copy where sflow logs looks for it.
    const local = join(run.dir, id, "terminal.txt");
    mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
    await link.fetch("file", { runId: run.id, path: join(s.remote.dir, id, "terminal.txt") }, local, 60_000).catch(() => {});
  }
  async screen(run: Run, id: string): Promise<string> {
    if (!this.remoteStep(run, id)) return this.local.screen(run, id);
    return (await this.link(run, run.steps[id].host!).call<{ screen: string }>("rt", { runId: run.id, stepId: id, action: "screen" })).screen;
  }
  async keys(run: Run, id: string, keys: string[]) {
    if (!this.remoteStep(run, id)) return this.local.keys(run, id, keys);
    await this.link(run, run.steps[id].host!).call("rt", { runId: run.id, stepId: id, action: "keys", keys });
  }
  async waitingOnPrompt(run: Run, id: string): Promise<Menu | null> {
    try { return parseMenu(await this.screen(run, id)); } catch { return null; }
  }
  async diagnose(run: Run, id: string) {
    try { return diagnoseScreen(await this.screen(run, id)); } catch { return null; }
  }
  attachArgs(run: Run, id: string): string[] {
    if (!this.remoteStep(run, id)) return this.local.attachArgs(run, id);
    const link = this.link(run, run.steps[id].host!) as SshLink;
    const bin = link.config.bin.startsWith("~/") ? `"$HOME"/${link.config.bin.slice(2)}` : link.config.bin;
    return [process.env.SFLOW_SSH_BIN ?? "ssh", "-t", link.config.ssh, `${bin} remote attach ${run.id} ${id}`];
  }

  // ---- command steps: a job journal on a host (or this machine) ----
  async startCommand(run: Run, step: Step): Promise<Outcome> {
    const s = run.steps[step.id];
    s.job ??= { id: `${run.id}-${step.id}`, phase: "placing" };
    // A start that was already sent is only ever looked up by its job id, never sent again.
    if (s.job.phase === "starting" && s.host) return this.adopt(run, step, this.link(run, s.host), "a previous start's answer was lost");
    if (!s.job.commit) {
      const source = step.workspace !== undefined ? join(run.dir, workspaceRoot(run.workflow.steps, step), "worktree") : step.cwd;
      const f = await this.freezeLocal(run, source);
      Object.assign(s.job, { commit: f.commit, tree: f.tree, head: f.head, repo: f.repo, source: f.root,
        cwd: step.workspace !== undefined ? "." : relative(f.root, realpathSync(step.cwd)) || "." });
      saveRun(run);
    }
    const job = s.job;
    let names: string[], reasons: string[] = [], allHard = false;
    if (s.host && job.phase !== "placing") names = [s.host];
    else if (!step.host) names = ["local"];
    else { const r = await this.ranked(run, step); names = r.fit.map(f => f.name); reasons = r.reasons; allHard = r.allHard; }
    for (const name of names) {
      const link = this.link(run, name);
      s.host = name;
      if (job.phase === "placing" || job.phase === "sending") {
        job.phase = "sending"; saveRun(run);
        try { await this.send(run, link, { root: job.source!, repo: job.repo! } as Frozen, job.commit!, `refs/sflow/jobs/${job.id}`); }
        catch (e) { reasons.push(`${name}: sending code failed: ${(e as Error).message}`); job.phase = "placing"; delete s.host; saveRun(run); continue; }
      }
      job.phase = "starting"; saveRun(run);
      let state: string;
      try {
        state = (await link.call<{ state: string }>("job-start", { jobId: job.id, repo: job.repo, commit: job.commit, tree: job.tree, cwd: job.cwd ?? ".",
          argv: step.command, artifacts: step.artifacts ?? [], slots: name === "local" ? run.workflow.concurrency : run.hosts![name].slots }, 120_000)).state;
      } catch (e) { return this.adopt(run, step, link, (e as Error).message); }
      if (state === "busy") { reasons.push(`${name} has no free slot`); job.phase = "placing"; delete s.host; saveRun(run); continue; }
      if (state === "exists") return this.adopt(run, step, link, "the host already had this job id");
      job.phase = "running"; s.status = "running"; s.lifecycle = "active"; s.actor = `job@${name}`; saveRun(run);
      return { ok: true };
    }
    if (names.length === 1 && names[0] === s.host) return { wait: reasons.join("; ") };
    return allHard ? { error: `no host can run this command: ${reasons.join("; ")}` } : { wait: reasons.join("; ") || "no host available" };
  }
  // The host's own record decides: a matching job is followed; anything else is uncertain.
  private async adopt(run: Run, step: Step, link: Link, why: string): Promise<Outcome> {
    const s = run.steps[step.id], job = s.job!;
    const st = await link.call<any>("job-status", { jobId: job.id }).catch(() => ({ state: "unknown" }));
    const ours = st.spec && st.spec.commit === job.commit && st.spec.tree === job.tree && JSON.stringify(st.spec.argv) === JSON.stringify(step.command);
    if (["missing", "unknown", "removed"].includes(st.state) || !ours) {
      s.status = "uncertain"; s.uncertainty = "launch";
      s.error = `starting the job on ${link.name} has an unknown outcome (${why}; host says ${st.state}${st.state !== "missing" && !ours ? ", record does not match this step" : ""}); it is never started again automatically`;
      saveRun(run); return { error: s.error };
    }
    job.phase = "running"; s.status = "running"; s.lifecycle = "active"; s.actor = `job@${link.name}`; saveRun(run);
    return { ok: true };
  }
  async pollCommand(run: Run, step: Step) {
    const s = run.steps[step.id], job = s.job!;
    if (job.phase !== "running" && job.phase !== "exited") return;
    if (Date.now() - (this.polled.get(job.id) ?? 0) < POLL_MS) return;
    this.polled.set(job.id, Date.now());
    const link = this.link(run, s.host!);
    let st: any;
    try { st = await link.call("job-status", { jobId: job.id }); }
    catch (e) { s.error = `cannot reach ${s.host}: ${(e as Error).message}; the job keeps running there`; saveRun(run); return; }
    if (s.error?.startsWith("cannot reach")) delete s.error;
    if (["missing", "lost", "removed"].includes(st.state)) {
      s.status = "uncertain"; s.uncertainty = "worker";
      s.error = st.state === "missing" ? `job ${job.id} is not on ${s.host}` : `${st.error} on ${s.host}`; saveRun(run); return;
    }
    if (st.state !== "exited") {
      if (Date.now() - (s.startedAt ?? Date.now()) > step.timeoutSeconds * 1000 && !st.cancel) {
        await link.call("job-cancel", { jobId: job.id, reason: "timeout" }).catch(() => {});
        s.error = `timed out after ${step.timeoutSeconds}s; cancellation sent to ${s.host}`; saveRun(run);
      } else if (st.cancel && !st.cancel.forcedAt && Date.now() - st.cancel.at > 15_000) {
        // The group ignored SIGTERM; the step stays running until the host records an exit.
        await link.call("job-cancel", { jobId: job.id, force: true }).catch(() => {});
        s.error = `${st.cancel.reason}: the job did not stop on SIGTERM; SIGKILL sent to its process group on ${s.host}`; saveRun(run);
      }
      return;
    }
    job.phase = "exited"; saveRun(run);
    await this.collect(run, step, link, st);
  }
  private async collect(run: Run, step: Step, link: Link, st: any) {
    const s = run.steps[step.id], job = s.job!, dir = join(run.dir, step.id);
    mkdirSync(join(dir, "artifacts"), { recursive: true, mode: 0o700 });
    // Evidence problems block the step whatever the exit code; artifact problems block a success.
    const evidence: string[] = [], problems: string[] = [];
    const spec = st.spec ?? {};
    if (spec.commit !== job.commit || spec.tree !== job.tree || JSON.stringify(spec.argv) !== JSON.stringify(step.command) ||
      JSON.stringify(spec.artifacts) !== JSON.stringify(step.artifacts ?? []) || (spec.cwd ?? ".") !== (job.cwd ?? "."))
      evidence.push(`the host's job record does not match this step's frozen input, command or artifacts`);
    const log = join(dir, "log.txt");
    try { await link.fetch("job-file", { jobId: job.id, kind: "log" }, log); }
    catch (e) { evidence.push(`log unavailable: ${(e as Error).message}`); writeFileSync(log, ""); }
    const exit = st.exit ?? {};
    const ran = !exit.error;
    if (ran && !st.artifacts) evidence.push("the host recorded no artifact list");
    problems.push(...(st.artifacts?.missing ?? []).map((m: { path: string; error: string }) => `${m.path}: ${m.error}`));
    const listed = [...(st.artifacts?.files ?? []).map((f: { path: string }) => f.path), ...(st.artifacts?.missing ?? []).map((m: { path: string }) => m.path)];
    for (const want of step.artifacts ?? []) {
      const w = want.replace(/\/+$/, "");
      if (st.artifacts && !listed.some(p => p === w || p.startsWith(w + "/")) && !(st.artifacts.missing ?? []).some((m: { path: string }) => m.path === "*"))
        problems.push(`${w}: not accounted for by the host`);
    }
    const artifacts: Record<string, unknown>[] = [];
    for (const a of (st.artifacts?.files ?? []) as { path: string; sha256: string; bytes: number }[]) {
      if (!safeRelative(a.path)) { problems.push(`${a.path}: unsafe path`); continue; }
      const local = join(dir, "artifacts", a.path);
      mkdirSync(dirname(local), { recursive: true, mode: 0o700 });
      try { await link.fetch("job-file", { jobId: job.id, kind: "artifact", path: a.path }, local); }
      catch (e) { problems.push(`${a.path}: ${(e as Error).message}`); continue; }
      const sha = createHash("sha256").update(readFileSync(local)).digest("hex");
      if (sha !== a.sha256) { problems.push(`${a.path}: hash mismatch after transfer`); continue; }
      artifacts.push({ path: local, sha256: sha, bytes: a.bytes });
    }
    const tail = readFileSync(log, "utf8").split("\n").slice(-30).join("\n").slice(-4000);
    const argv = step.command!.join(" ");
    const how = exit.error ? exit.error : exit.signal ? `killed by ${exit.signal}` : `exit ${exit.code}`;
    let status: "done" | "failed" | "blocked" = evidence.length ? "blocked" : exit.code === 0 && !problems.length ? "done" : exit.code === 0 ? "blocked" : "failed";
    const issues = [...evidence, ...problems];
    const receipt = {
      status, summary: `${argv} on ${s.host}: ${how}${issues.length ? `; ${issues.join(", ")}` : ""}`,
      checks: [`${argv} → ${how}`], artifacts: [log, ...artifacts.map(a => a.path as string)],
      details: { host: s.host, jobId: job.id, inputCommit: spec.commit ?? null, inputTree: spec.tree ?? null, inputHead: job.head, cwd: spec.cwd ?? ".",
        argvSha256: createHash("sha256").update(JSON.stringify(spec.argv ?? null)).digest("hex"),
        exitCode: exit.code ?? null, signal: exit.signal ?? null, ...(exit.error ? { error: exit.error } : {}),
        arch: st.started?.arch, platform: st.started?.platform, machine: st.started?.host,
        startedAt: st.started?.startedAt, finishedAt: exit.finishedAt, ...(st.cancel ? { cancelled: st.cancel.reason } : {}),
        log: { path: log, sha256: createHash("sha256").update(readFileSync(log)).digest("hex") }, artifactFiles: artifacts,
        ...(evidence.length ? { evidenceProblems: evidence } : {}), ...(problems.length ? { artifactProblems: problems } : {}),
        logTail: tail },
    };
    let error: string | undefined = status !== "done" ? receipt.summary : undefined;
    if (st.cancel?.reason === "timeout") { status = "blocked"; error = `timed out after ${step.timeoutSeconds}s; the job was cancelled`; }
    // The same acceptance gate as an agent's done report.
    const miss = status === "done" && step.expect ? Object.entries(step.expect).find(([path, value]) => field(receipt, path) !== value) : undefined;
    if (miss) { status = "blocked"; error = `reported ${miss[0]} = ${JSON.stringify(field(receipt, miss[0]) ?? null)}, expected ${JSON.stringify(miss[1])}; over to you`; }
    s.result = storeResult(run, step.id, { ...receipt, status: receipt.status });
    s.status = status;
    if (error) s.error = error; else delete s.error;
    s.finishedAt = exit.finishedAt ?? Date.now(); s.lifecycle = "closed"; job.phase = "collected"; job.receipt = { status, exitCode: exit.code ?? null };
    saveRun(run);
  }
  async cancelCommand(run: Run, step: Step, reason: string) {
    const s = run.steps[step.id];
    if (!s.job || !s.host || !["starting", "running"].includes(s.job.phase)) return;
    try { await this.link(run, s.host).call("job-cancel", { jobId: s.job.id, reason }); }
    catch (e) { s.error = `cancellation on ${s.host} unknown: ${(e as Error).message}`; saveRun(run); }
  }
}
export class NotSent extends Error { readonly notSent = true; }
function ancestors(run: Run, step: Step, seen = new Set<string>()): string[] {
  for (const d of step.dependsOn) if (!seen.has(d)) { seen.add(d); ancestors(run, run.workflow.steps.find(x => x.id === d)!, seen); }
  return [...seen];
}
