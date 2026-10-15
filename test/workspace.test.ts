import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checked } from "../src/process";
import { parseWorkflow } from "../src/config";
import { createRun } from "../src/store";
import { snapshot, changedFiles, sameSnapshot } from "../src/workspace";
import { tick } from "../src/engine";
import { reviewRun } from "../src/review";
import { eventProof } from "../src/protocol";
import type { Run, Step, Message, Transport, SessionRuntime } from "../src/types";
const dirs: string[] = [];
afterEach(() => { delete process.env.SFLOW_HOME; dirs.splice(0).forEach(d => rmSync(d, { recursive: true, force: true })); });
async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "sf-inplace-")); dirs.push(dir);
  const project = join(dir, "project"); mkdirSync(project); process.env.SFLOW_HOME = join(dir, "state");
  await checked(["git", "init", "-q", project]);
  writeFileSync(join(project, "a.txt"), "committed\n"); writeFileSync(join(project, "user.txt"), "original\n");
  await checked(["git", "-C", project, "add", "."]);
  await checked(["git", "-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-qm", "fixture"]);
  const workflow = (steps: object[]) => parseWorkflow({ version: 1, name: "in-place", steps: steps.map(s => ({ agent: "codex", cwd: project, prompt: "fixture", ...s })) }, dir);
  const run = (steps: object[]) => { const r = createRun(workflow(steps)); dirs.push(join(r.socket, "..")); return r; };
  return { dir, project, run, workflow };
}
class Runtime implements SessionRuntime {
  live = new Set<string>();
  async create(r: Run, s: Step) { this.live.add(r.steps[s.id].session); r.steps[s.id].cwd = s.cwd; }
  async exists(r: Run, id: string) { return this.live.has(r.steps[id].session); }
  async stop(r: Run, id: string) { this.live.delete(r.steps[id].session); }
}
class Channel implements Transport {
  rows: Message[] = [];
  async read() { return this.rows; }
  async whoami() { return "codex-12345678"; }
  async send(_c: string, body: unknown, from: string) { this.rows.push({ seq: this.rows.length + 1, from, body: JSON.stringify(body) }); }
  async finish(r: Run, id: string) {
    for (const status of ["accepted", "done"] as const) {
      const e = { type: "sflow.worker" as const, version: 1 as const, runId: r.id, stepId: id, actor: "codex-12345678", status, ...(status === "done" ? { result: { summary: id } } : {}) };
      await this.send(r.channel, { ...e, proof: eventProof(e, r.steps[id].token) }, e.actor);
    }
  }
}
test("in-place delta excludes existing staged, unstaged and untracked user edits, preserving them", async () => {
  const f = await fixture(); writeFileSync(join(f.project, "user.txt"), "user staged\n");
  await checked(["git", "-C", f.project, "add", "user.txt"]);
  writeFileSync(join(f.project, "user.txt"), "user unstaged\n"); writeFileSync(join(f.project, "user-new.txt"), "private fixture\n");
  const r = f.run([{ id: "write", policy: "workspace-write", inPlace: true }]), rt = new Runtime(), tr = new Channel();
  await tick(r, rt, tr); writeFileSync(join(f.project, "a.txt"), "worker edit\n");
  await tr.finish(r, "write"); await tick(r, rt, tr);
  expect(r.status).toBe("done");
  const review = await reviewRun(r, rt), delta = review.steps[0].workspaceDelta!;
  expect(delta.changes).toEqual(["a.txt"]); expect(readFileSync(delta.diff!, "utf8")).not.toContain("user unstaged");
  expect(readFileSync(join(f.project, "user.txt"), "utf8")).toBe("user unstaged\n");
  expect(await checked(["git", "-C", f.project, "show", ":user.txt"])).toBe("user staged\n");
  expect(review.steps[0].worktree).toBeUndefined();
});
test("external edits during read-only review block advancement", async () => {
  const f = await fixture(), r = f.run([{ id: "w", policy: "workspace-write", inPlace: true }, { id: "r", dependsOn: ["w"] }, { id: "after", dependsOn: ["r"] }]);
  const rt = new Runtime(), tr = new Channel(); await tick(r, rt, tr); await tr.finish(r, "w"); await tick(r, rt, tr);
  writeFileSync(join(f.project, "user.txt"), "outside write\n"); await tr.finish(r, "r"); await tick(r, rt, tr);
  expect(r.steps.r.status).toBe("blocked"); expect(r.steps.after.status).toBe("blocked");
});
test("external index changes block even a write step", async () => {
  const f = await fixture(), r = f.run([{ id: "w", policy: "workspace-write", inPlace: true }]);
  const rt = new Runtime(), tr = new Channel(); await tick(r, rt, tr);
  writeFileSync(join(f.project, "a.txt"), "staged outside\n"); await checked(["git", "-C", f.project, "add", "a.txt"]);
  await tr.finish(r, "w"); await tick(r, rt, tr); expect(r.steps.w.status).toBe("blocked");
});
test("in-place readers and writers reject concurrent paths, including symlink and nested aliases", async () => {
  const f = await fixture(); mkdirSync(join(f.project, "sub")); symlinkSync(f.project, join(f.dir, "alias"));
  for (const cwd of [f.project, join(f.project, "sub"), join(f.dir, "alias")])
    expect(() => f.workflow([{ id: "w", policy: "workspace-write", inPlace: true }, { id: "r", cwd }])).toThrow("dependency ordered");
  expect(() => f.workflow([{ id: "w", policy: "workspace-write", inPlace: true, worktree: true }])).toThrow("inPlace requires");
  expect(() => f.workflow([{ id: "w", policy: "workspace-write", inPlace: true, cwd: join(f.project, "sub") }])).toThrow("checkout root");
});
test("snapshots include deletions, untracked contents and symlink targets; ignored files are excluded", async () => {
  const f = await fixture(); writeFileSync(join(f.project, ".gitignore"), "ignored\n"); writeFileSync(join(f.project, "ignored"), "ignored\n");
  symlinkSync("a.txt", join(f.project, "link"));
  const a = await snapshot(f.project, join(f.dir, "before")); rmSync(join(f.project, "a.txt"));
  writeFileSync(join(f.project, "fresh"), "new\n"); rmSync(join(f.project, "link")); symlinkSync("fresh", join(f.project, "link"));
  const b = await snapshot(f.project, join(f.dir, "after")); expect(changedFiles(a, b)).toEqual(["a.txt", "fresh", "link"]);
  expect(a.files.ignored).toBeUndefined(); expect(sameSnapshot(a, b)).toBe(false);
});

test("changes between an observed end and the next step block dispatch; protocol directories cannot be inside checkout", async () => {
  const { beginObservation, endObservation } = await import("../src/workspace");
  const f = await fixture(), r = f.run([{ id: "w", policy: "workspace-write", inPlace: true }, { id: "r", dependsOn: ["w"] }]);
  expect(r.version).toBe(3);
  await beginObservation(r, r.workflow.steps[0]); r.steps.w.result = { summary: "fixture" }; r.steps.w.finishedAt = Date.now();
  await endObservation(r, r.workflow.steps[0]); writeFileSync(join(f.project, "a.txt"), "outside between rounds\n");
  await expect(beginObservation(r, r.workflow.steps[1])).rejects.toThrow("outside the workflow between steps");
  process.env.SFLOW_HOME = join(f.project, "state");
  expect(() => f.workflow([{ id: "w", policy: "workspace-write", inPlace: true }])).toThrow("overlaps protocol write roots");
});
