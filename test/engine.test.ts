import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflow } from "../src/config";
import { createRun, loadRun, lockRun, saveRun } from "../src/store";
import { tick, reconcile } from "../src/engine";
import type { Message, Run, SessionRuntime, Transport, Step } from "../src/types";
import { eventProof } from "../src/protocol";
import { workerTask, workerReport } from "../src/worker";
import { resolveResult } from "../src/results";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); for (const k of ["SFLOW_HOME", "SFLOW_RUN_ID", "SFLOW_STEP_ID", "SFLOW_TOKEN"]) delete process.env[k]; });
// A fixture actor shaped like the native session of each step's agent.
function actorFor(run: Run, id: string) {
  const agent = run.workflow.steps.find(s => s.id === id)!.agent;
  return agent === "claude" ? "claude-12345678" : agent === "pi" ? "pi-01a1386a-5b57-72eb-9178-7f54f0dd7686"
    : agent === "agy" ? `agy-${run.id.slice(0, 8)}-${id}` : "codex-12345678";
}
function setup(steps: object[], concurrency = 2) {
  const home = mkdtempSync(join(tmpdir(), "sf-test-")); dirs.push(home); process.env.SFLOW_HOME = join(home, "state");
  const project = join(home, "project"); mkdirSync(project);
  const run = createRun(parseWorkflow({ version: 1, name: "test", concurrency, steps: steps.map(s => ({ cwd: project, agent: "codex", prompt: "task", ...s })) }, home));
  dirs.push(join(run.socket, "..")); return run;
}
class FakeTransport implements Transport {
  rows: Message[] = []; failSend = false;
  async whoami() { return "codex-12345678"; }
  async read() { return this.rows; }
  async send(_c: string, body: unknown, as: string) {
    if (this.failSend) throw new Error("unknown outcome");
    this.rows.push({ seq: this.rows.length + 1, body: JSON.stringify(body), from: as });
  }
  report(run: Run, id: string, status: string, actor = actorFor(run, id), token = run.steps[id].token, extra: Record<string, unknown> = {}) {
    const e = { type: "sflow.worker" as const, version: 1 as const, runId: run.id, stepId: id, actor, status: status as "done", result: { summary: id, ...extra } };
    this.rows.push({ seq: this.rows.length + 1, from: actor,
      body: JSON.stringify({ ...e, proof: eventProof(e, token) }) });
  }
}
class FakeRuntime implements SessionRuntime {
  live = new Set<string>(); created: string[] = []; failCreate = false;
  async exists(_r: Run, id: string) { return this.live.has(id); }
  async create(r: Run, s: Step) { this.created.push(s.id); if (this.failCreate) throw new Error("unknown create"); r.steps[s.id].cwd = s.cwd; this.live.add(s.id); }
  async stop(_r: Run, id: string) { this.live.delete(id); }
}
test("parallel children only run after explicit parent completion; outputs feed join", async () => {
  const run = setup([{ id: "plan" }, { id: "a", dependsOn: ["plan"] }, { id: "b", agent: "claude", dependsOn: ["plan"] }, { id: "review", dependsOn: ["a", "b"] }]);
  const rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); expect(rt.created).toEqual(["plan"]);
  await tick(run, rt, tr); expect(rt.created).toEqual(["plan"]);
  tr.report(run, "plan", "accepted"); tr.report(run, "plan", "done");
  await tick(run, rt, tr); expect(rt.created).toEqual(["plan", "a", "b"]);
  for (const id of ["a", "b"]) { tr.report(run, id, "accepted"); tr.report(run, id, "done"); }
  await tick(run, rt, tr); expect(rt.created).toEqual(["plan", "a", "b", "review"]);
  const task = JSON.parse(tr.rows.find(r => JSON.parse(r.body).type === "sflow.task" && JSON.parse(r.body).stepId === "review")!.body);
  expect(task.dependencies).toEqual({ a: { summary: "a" }, b: { summary: "b" } });
  tr.report(run, "review", "accepted"); tr.report(run, "review", "done"); await tick(run, rt, tr);
  expect(run.status).toBe("done"); expect(rt.live.size).toBe(0);
});
test("unknown send and unknown creation are never retried on resume", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  tr.failSend = true; await tick(run, rt, tr); expect(run.steps.a.status).toBe("uncertain");
  const restored = loadRun(run.id); restored.status = "running"; tr.failSend = false;
  await tick(restored, rt, tr); expect(rt.created).toEqual([]); expect(tr.rows).toEqual([]);
  const second = setup([{ id: "a" }]); rt.failCreate = true; await tick(second, rt, tr);
  const again = loadRun(second.id); again.status = "running"; rt.failCreate = false;
  await tick(again, rt, tr); expect(rt.created).toEqual(["a"]);
});
test("crash after launch adopts exact session without spawning duplicate", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  run.steps.a.status = "launching"; rt.live.add("a");
  await tick(run, rt, tr); expect(String(run.steps.a.status)).toBe("starting"); expect(rt.created).toEqual([]);
});
test("acceptance, matching actor and capability are required before completion", () => {
  const run = setup([{ id: "a" }]); run.steps.a.status = "starting";
  const tr = new FakeTransport();
  tr.report(run, "a", "done"); reconcile(run, tr.rows); expect(run.steps.a.status).toBe("starting");
  tr.rows = []; tr.report(run, "a", "accepted", "codex-12345678", "wrong"); reconcile(run, tr.rows); expect(run.steps.a.actor).toBeUndefined();
  tr.rows = []; tr.report(run, "a", "accepted"); tr.report(run, "a", "done", "claude-87654321"); reconcile(run, tr.rows); expect(String(run.steps.a.status)).toBe("running");
  tr.report(run, "a", "done"); reconcile(run, tr.rows); expect(String(run.steps.a.status)).toBe("done");
});
test("exited worker cannot complete a task and prevents downstream dispatch", async () => {
  const run = setup([{ id: "a" }, { id: "b", dependsOn: ["a"] }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); rt.live.delete("a"); await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("uncertain"); expect(run.steps.b.status).toBe("blocked"); expect(rt.created).toEqual(["a"]);
});
test("blocked live worker still consumes concurrency; trust timeout points at status", async () => {
  const run = setup([{ id: "a", readyTimeoutSeconds: 5 }, { id: "b" }], 1); const rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); run.steps.a.startedAt = Date.now() - 6000; await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("blocked"); expect(run.steps.a.error).toContain("cause unknown"); expect(run.steps.a.error).not.toContain("trust"); expect(rt.created).toEqual(["a"]); expect(run.status).toBe("blocked");
});
test("a prompt the user is answering keeps readiness open until the step timeout", async () => {
  const run = setup([{ id: "a", readyTimeoutSeconds: 5, timeoutSeconds: 60 }]);
  const menu = { id: "abcd1234", question: ["Trust?"], options: ["No", "Yes"] };
  const rt = new (class extends FakeRuntime { prompt = true; async waitingOnPrompt() { return this.prompt ? menu : null; } })(), tr = new FakeTransport();
  await tick(run, rt, tr); run.steps.a.startedAt = Date.now() - 6000; await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("starting");
  // Answered: the worker gets a fresh readiness window from the last sighting of the prompt.
  rt.prompt = false; run.steps.a.promptAt = Date.now() - 3000; await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("starting");
  run.steps.a.promptAt = Date.now() - 6000; await tick(run, rt, tr);
  expect(run.steps.a.status).toBe("blocked"); expect(run.steps.a.error).toContain("no acceptance");
  const seen = setup([{ id: "a", readyTimeoutSeconds: 5 }]);
  const err = new (class extends FakeRuntime { async diagnose() { return "Error: HTTP 524 gateway timeout"; } })();
  await tick(seen, err, tr); seen.steps.a.startedAt = Date.now() - 6000; await tick(seen, err, tr);
  expect(seen.steps.a.error).toContain("the worker screen shows: Error: HTTP 524 gateway timeout");
  const stuck = setup([{ id: "a", readyTimeoutSeconds: 5, timeoutSeconds: 60 }]); rt.prompt = true;
  await tick(stuck, rt, tr); stuck.steps.a.startedAt = Date.now() - 61000; await tick(stuck, rt, tr);
  expect(stuck.steps.a.status).toBe("blocked"); expect(stuck.steps.a.error).toContain("timed out");
  const fresh = setup([{ id: "a", readyTimeoutSeconds: 5 }]); rt.prompt = false;
  await tick(fresh, rt, tr); fresh.steps.a.startedAt = Date.now() - 6000; await tick(fresh, rt, tr);
  expect(fresh.steps.a.status).toBe("blocked");
});
test("one driver owns each run", () => {
  const run = setup([{ id: "a" }]); const unlock = lockRun(run);
  expect(() => lockRun(run)).toThrow("already driven"); unlock(); const next = lockRun(run); next();
});
test("invalid workflow cycles, missing references and shared writable paths fail before launch", () => {
  expect(() => setup([{ id: "a", dependsOn: ["b"] }, { id: "b", dependsOn: ["a"] }])).toThrow("cycle");
  expect(() => setup([{ id: "a", dependsOn: ["unknown"] }])).toThrow("unknown dependency");
  expect(() => setup([{ id: "a", policy: "workspace-write" }])).toThrow("worktree");
});
test("worker acceptance and report are idempotent, use proofs without raw capability", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr);
  process.env.SFLOW_RUN_ID = run.id; process.env.SFLOW_STEP_ID = "a"; process.env.SFLOW_TOKEN = run.steps.a.token;
  // Worker commands need not be run in the exact launch cwd.
  const task = await workerTask(tr); expect((task as any).stepId).toBe("a");
  await workerTask(tr); expect(tr.rows.length).toBe(2);
  expect(tr.rows[1].body).not.toContain(run.steps.a.token);
  const result = { status: "done", summary: "checked", details: { number: 42 } };
  await workerReport(tr, result); expect(tr.rows.length).toBe(3);
  expect(await workerReport(tr, result)).toEqual({ reported: true, alreadyReported: true }); expect(tr.rows.length).toBe(3);
  await expect(workerReport(tr, { status: "done", summary: "different" })).rejects.toThrow("already exists");
  await expect(workerTask(tr)).rejects.toThrow("terminal report");
});
test("large terminal report stays in a verified file, not the OCS packet or run snapshot", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr);
  process.env.SFLOW_RUN_ID = run.id; process.env.SFLOW_STEP_ID = "a"; process.env.SFLOW_TOKEN = run.steps.a.token;
  await workerTask(tr); await workerReport(tr, { status: "done", summary: "checked", details: "x".repeat(24000) });
  expect(Buffer.byteLength(tr.rows[2].body)).toBeLessThan(2000);
  expect(tr.rows[2].body).not.toContain("x".repeat(100));
  reconcile(run, tr.rows); expect(run.steps.a.status).toBe("done"); expect(run.steps.a.result!.details).toBeUndefined();
  expect((resolveResult(run, "a", run.steps.a.result!).details as string).length).toBe(24000);
});
test("corrupted result evidence blocks completion and downstream dispatch", async () => {
  const run = setup([{ id: "a" }, { id: "b", dependsOn: ["a"] }]); const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr);
  process.env.SFLOW_RUN_ID = run.id; process.env.SFLOW_STEP_ID = "a"; process.env.SFLOW_TOKEN = run.steps.a.token;
  await workerTask(tr); await workerReport(tr, { status: "done", summary: "checked" });
  const e = JSON.parse(tr.rows[2].body); writeFileSync(e.result.fullResultFile, '{"status":"done","summary":"changed"}');
  await tick(run, rt, tr); expect(run.steps.a.status).toBe("blocked"); expect(run.steps.a.error).toContain("corrupted"); expect(rt.created).toEqual(["a"]);
});
test("legacy runs keep inline report semantics when the worker CLI is upgraded", async () => {
  const run = setup([{ id: "a" }]); run.version = 1; saveRun(run);
  const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr);
  process.env.SFLOW_RUN_ID = run.id; process.env.SFLOW_STEP_ID = "a"; process.env.SFLOW_TOKEN = run.steps.a.token;
  await workerTask(tr); await workerReport(tr, { status: "done", summary: "legacy", details: { number: 42 } });
  expect(JSON.parse(tr.rows[2].body).result).toEqual({ status: "done", summary: "legacy", details: { number: 42 } });
});
test("damaged completion proof and changed result cannot advance the workflow", async () => {
  const run = setup([{ id: "a" }]); run.steps.a.status = "starting"; const tr = new FakeTransport();
  tr.report(run, "a", "accepted"); reconcile(run, tr.rows);
  tr.report(run, "a", "done");
  const e = JSON.parse(tr.rows[1].body); e.result.summary = "tampered"; tr.rows[1].body = JSON.stringify(e);
  reconcile(run, tr.rows); expect(String(run.steps.a.status)).toBe("running");
});
test("large dependency results become inspectable files within OCS byte limit", async () => {
  const run = setup([{ id: "a" }, { id: "b", agent: "claude" }, { id: "join", dependsOn: ["a", "b"] }]);
  const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr);
  for (const id of ["a", "b"]) {
    tr.report(run, id, "accepted");
    const e = { type: "sflow.worker" as const, version: 1 as const, runId: run.id, stepId: id, actor: actorFor(run, id), status: "done" as const,
      result: { summary: id, details: "x".repeat(60000) } };
    tr.rows.push({ seq: tr.rows.length + 1, from: e.actor, body: JSON.stringify({ ...e, proof: eventProof(e, run.steps[id].token) }) });
  }
  await tick(run, rt, tr);
  const row = tr.rows.find(r => JSON.parse(r.body).stepId === "join")!;
  expect(Buffer.byteLength(row.body)).toBeLessThan(100000);
  const dep = JSON.parse(row.body).dependencies.a;
  expect(JSON.parse(readFileSync(dep.resultFile, "utf8")).details.length).toBe(60000); expect(dep.sha256.length).toBe(64);
});
test("matching read-only prefixes wait for first response; different models stay parallel", async () => {
  const run = setup([{ id: "a" }, { id: "b" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  run.workflow.prefixWarmupMs = 5000;
  await tick(run, rt, tr); expect(rt.created).toEqual(["a"]);
  tr.report(run, "a", "accepted"); await tick(run, rt, tr); expect(rt.created).toEqual(["a", "b"]);
  const other = setup([{ id: "c", model: "one" }, { id: "d", model: "two" }]); const rt2 = new FakeRuntime();
  await tick(other, rt2, new FakeTransport()); expect(rt2.created).toEqual(["c", "d"]);
});
test("prefix hold is bounded at 5 seconds, never waits indefinitely for a trust prompt", async () => {
  const run = setup([{ id: "a" }, { id: "b" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  run.workflow.prefixWarmupMs = 5000;
  await tick(run, rt, tr); run.steps.a.startedAt = Date.now() - 5100;
  await tick(run, rt, tr); expect(rt.created).toEqual(["a", "b"]);
});
test("an accepted native session cannot claim another step through a copied command", async () => {
  const run = setup([{ id: "a" }, { id: "b" }]); const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr);
  process.env.SFLOW_RUN_ID = run.id; process.env.SFLOW_STEP_ID = "a"; process.env.SFLOW_TOKEN = run.steps.a.token; await workerTask(tr);
  process.env.SFLOW_STEP_ID = "b"; process.env.SFLOW_TOKEN = run.steps.b.token;
  await expect(workerTask(tr)).rejects.toThrow("already accepted another step");
  expect(tr.rows.length).toBe(3);
});
test("late explicit report after readiness timeout can recover downstream on resume", async () => {
  const run = setup([{ id: "a", readyTimeoutSeconds: 5 }, { id: "b", dependsOn: ["a"] }]);
  const rt = new FakeRuntime(), tr = new FakeTransport(); await tick(run, rt, tr); run.steps.a.startedAt = Date.now() - 6000;
  await tick(run, rt, tr); expect(run.status).toBe("blocked");
  tr.report(run, "a", "accepted"); tr.report(run, "a", "done"); run.status = "running";
  await tick(run, rt, tr); expect(rt.created).toEqual(["a", "b"]); expect(String(run.steps.a.status)).toBe("done");
});
test("cancellation stops only owned workers and does not launch pending steps", async () => {
  const run = setup([{ id: "a" }, { id: "b", dependsOn: ["a"] }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); writeFileSync(join(run.dir, "cancel.request"), "cancel"); await tick(run, rt, tr);
  expect(run.status).toBe("cancelled"); expect(rt.created).toEqual(["a"]); expect(rt.live.size).toBe(0);
});
test("a committed assignment after unknown send is reconciled without resending", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  run.steps.a.status = "uncertain"; run.steps.a.uncertainty = "dispatch";
  await tr.send(run.channel, { type: "sflow.task", version: 1, runId: run.id, stepId: "a", prompt: "task", workspace: run.workflow.steps[0].cwd, dependencies: {} }, `sflow-${run.id}`);
  await tick(run, rt, tr); expect(rt.created).toEqual(["a"]); expect(tr.rows.length).toBe(1);
});
test("a created session after unknown launch is adopted without recreating", async () => {
  const run = setup([{ id: "a" }]); const rt = new FakeRuntime(), tr = new FakeTransport();
  run.steps.a.status = "uncertain"; run.steps.a.uncertainty = "launch"; rt.live.add("a");
  await tick(run, rt, tr); expect(rt.created).toEqual([]); expect(String(run.steps.a.status)).toBe("starting");
});

test("an actor must match its step's agent; pi and agy actors are accepted", () => {
  const run = setup([{ id: "a", agent: "pi" }, { id: "b", agent: "agy" }, { id: "c", agent: "claude" }]);
  for (const id of ["a", "b", "c"]) run.steps[id].status = "starting";
  const tr = new FakeTransport();
  tr.report(run, "c", "accepted", "codex-12345678"); reconcile(run, tr.rows); expect(run.steps.c.actor).toBeUndefined();
  tr.rows = []; tr.report(run, "b", "accepted", `agy-${run.id.slice(0, 8)}-a`); reconcile(run, tr.rows); expect(run.steps.b.actor).toBeUndefined();
  tr.rows = [];
  for (const id of ["a", "b", "c"]) tr.report(run, id, "accepted");
  reconcile(run, tr.rows);
  expect(run.steps.a.actor).toBe("pi-01a1386a-5b57-72eb-9178-7f54f0dd7686");
  expect(run.steps.b.actor).toBe(`agy-${run.id.slice(0, 8)}-b`);
  expect(run.steps.c.actor).toBe("claude-12345678");
});

// #9: a review decides whether a fix round runs; rounds are distinct steps, unneeded ones are skipped.
const loop = [
  { id: "impl", policy: "workspace-write", worktree: true },
  { id: "review-1", agent: "claude", dependsOn: ["impl"] },
  { id: "fix-1", policy: "workspace-write", workspace: "impl", dependsOn: ["review-1"], when: { "review-1": { "details.verdict": "needs-fix" } } },
  { id: "review-2", agent: "claude", dependsOn: ["review-1", "fix-1"], when: { "fix-1": { status: "done" } }, expect: { "details.verdict": "pass" } },
  { id: "after", agent: "claude", dependsOn: ["review-2"] },
];
async function finish(run: Run, rt: FakeRuntime, tr: FakeTransport, id: string, extra: Record<string, unknown> = {}) {
  expect(rt.created.at(-1)).toBe(id);
  tr.report(run, id, "accepted"); tr.report(run, id, "done", undefined, undefined, extra); await tick(run, rt, tr);
}
test("a passing review skips the fix round, and what depends on a skipped step still runs", async () => {
  const run = setup(loop), rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); await finish(run, rt, tr, "impl"); await finish(run, rt, tr, "review-1", { details: { verdict: "pass" } });
  expect(run.steps["fix-1"].status).toBe("skipped"); expect(run.steps["review-2"].status).toBe("skipped");
  const task = JSON.parse(tr.rows.find(r => JSON.parse(r.body).stepId === "after" && JSON.parse(r.body).type === "sflow.task")!.body);
  expect(task.dependencies).toEqual({ "review-2": { status: "skipped" } });
  await finish(run, rt, tr, "after");
  expect(run.status).toBe("done");
  expect(rt.created).toEqual(["impl", "review-1", "after"]);
});
test("needs-fix runs the fix in the same worktree, then the next review; a last needs-fix goes to the user", async () => {
  const run = setup(loop), rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); await finish(run, rt, tr, "impl"); await finish(run, rt, tr, "review-1", { details: { verdict: "needs-fix" } });
  const fix = JSON.parse(tr.rows.find(r => JSON.parse(r.body).stepId === "fix-1" && JSON.parse(r.body).type === "sflow.task")!.body);
  expect(fix.workspace).toBe(join(run.dir, "impl", "worktree"));
  await finish(run, rt, tr, "fix-1"); await finish(run, rt, tr, "review-2", { details: { verdict: "needs-fix" } });
  expect(run.steps["review-2"].status).toBe("blocked");
  expect(run.steps["review-2"].error).toContain('details.verdict = "needs-fix", expected "pass"');
  await tick(run, rt, tr);
  expect(run.steps.after.status).toBe("blocked"); expect(run.status).toBe("blocked");
});
test("a review that gives no verdict stops the run instead of skipping the fix", async () => {
  const run = setup(loop), rt = new FakeRuntime(), tr = new FakeTransport();
  await tick(run, rt, tr); await finish(run, rt, tr, "impl"); await finish(run, rt, tr, "review-1");
  expect(run.steps["fix-1"].status).toBe("blocked");
  expect(run.steps["fix-1"].error).toContain("review-1 reported no details.verdict");
});
test("workspace reuse is only for an ancestor write step, and one worktree has one writer at a time", () => {
  expect(() => setup([{ id: "a", policy: "workspace-write", worktree: true }, { id: "b", policy: "workspace-write", workspace: "a" }])).toThrow("must be one of its (indirect) dependencies");
  expect(() => setup([{ id: "a" }, { id: "b", policy: "workspace-write", workspace: "a", dependsOn: ["a"] }])).toThrow("not a write step");
  expect(() => setup([{ id: "a", policy: "workspace-write", worktree: true }, { id: "r", dependsOn: ["a"] },
    { id: "b", policy: "workspace-write", workspace: "a", dependsOn: ["r"] }, { id: "c", policy: "workspace-write", workspace: "a", dependsOn: ["r"] }])).toThrow("write in the same worktree");
  expect(() => setup([{ id: "a" }, { id: "b", dependsOn: ["a"], when: { x: { status: "done" } } }])).toThrow("direct dependency");
  expect(() => setup([{ id: "a", policy: "workspace-write", worktree: true, workspace: "a" }])).toThrow("either worktree");
  expect(setup(loop).workflow.steps.find(s => s.id === "fix-1")!.workspace).toBe("impl");
});
