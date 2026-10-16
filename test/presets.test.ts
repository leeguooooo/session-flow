import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildPreset, PRESETS } from "../src/presets";
import { parseWorkflow } from "../src/config";

test("every preset builds a workflow that passes normal validation", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-preset-"));
  try {
    for (const preset of Object.keys(PRESETS)) {
      const write = preset.includes("implement");
      const wf = parseWorkflow(buildPreset(preset, { task: "add a flag", cwd: dir, write }), dir);
      expect(wf.steps.length).toBeGreaterThan(0);
      // Only implement writes in a new worktree; fix rounds write only in implement's worktree.
      for (const s of wf.steps) expect(s.policy === "workspace-write").toBe((s.id === "implement" && s.worktree === true) || (/^fix-\d$/.test(s.id) && s.workspace === "implement"));
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("writing must be asked for, and inputs are checked", () => {
  expect(() => buildPreset("implement-review", { task: "x", cwd: "." })).toThrow("Add --write to confirm");
  expect(() => buildPreset("review", { task: "x", cwd: ".", write: true })).toThrow("read-only");
  expect(() => buildPreset("review", { task: " ", cwd: "." })).toThrow("--task is required");
  expect(() => buildPreset("nope", { task: "x", cwd: "." })).toThrow("unknown preset");
  expect(() => buildPreset("review", { task: "x", cwd: ".", review: "hermes" })).toThrow("--review: agent must be one of");
  expect(() => buildPreset("fan-out", { task: "x", cwd: ".", agents: ["claude"] })).toThrow("at least two");
});

test("the review step is told to inspect the actual diff, not the summary", () => {
  const wf = buildPreset("plan-implement-review", { task: "add a flag", cwd: ".", write: true, implement: "claude", review: "codex" }) as { steps: Record<string, unknown>[] };
  expect(wf.steps.map(s => [s.id, s.agent])).toEqual([["plan", "claude"], ["implement", "claude"], ["review", "codex"]]);
  expect(String(wf.steps[1].prompt)).toContain("details.workspace");
  expect(String(wf.steps[2].prompt)).toContain("git -C <path> diff");
  expect(String(wf.steps[2].prompt)).toContain("Do not rely on the implementer's summary");
});

test("in-place and session retention are separate explicit options", () => {
  expect(() => buildPreset("implement-review-fix", { task: "fixture", cwd: ".", inPlace: true })).toThrow("--write");
  const p = buildPreset("implement-review-fix", { task: "fixture", cwd: ".", write: true, inPlace: true, reuseSessions: true }) as { steps: Record<string, unknown>[] };
  expect(p.steps.find(s => s.id === "implement")!.inPlace).toBe(true);
  expect(p.steps.find(s => s.id === "implement")!.worktree).toBeUndefined();
  expect(p.steps.find(s => s.id === "fix-1")!.reuseSession).toBe("implement");
});

test("--test gates every write round and --host places roles", () => {
  const wf = buildPreset("implement-review-fix", { task: "t", cwd: ".", write: true, rounds: 2, test: "bun test",
    hosts: { implement: ["box"], review: ["mini"], test: ["mini", "box"] } }) as { steps: Record<string, any>[] };
  const by = Object.fromEntries(wf.steps.map(s => [s.id, s]));
  expect(Object.keys(by)).toEqual(["implement", "test-0", "review-1", "fix-1", "test-1", "review-2", "fix-2", "test-2", "review-3"]);
  expect(by["test-0"]).toMatchObject({ agent: "command", command: ["sh", "-c", "set -o pipefail 2>/dev/null; bun test"], workspace: "implement", allowFailure: true, dependsOn: ["implement"], host: ["mini", "box"] });
  expect(by["test-1"]).toMatchObject({ dependsOn: ["fix-1"], when: { "fix-1": { status: "done" } } });
  expect(by["review-1"].dependsOn).toEqual(["implement", "test-0"]);
  expect(by["review-2"].dependsOn).toContain("test-1");
  expect(by["review-2"].prompt).toContain("test-1 dependency is a command step");
  expect(by["fix-1"].host).toEqual(["box"]); expect(by["review-3"].host).toEqual(["mini"]);
  expect(by["review-3"].expect).toEqual({ "details.verdict": "pass" });
  expect(() => buildPreset("review", { task: "t", cwd: ".", test: "x" })).toThrow("does not write");
  expect(() => buildPreset("implement-review", { task: "t", cwd: ".", write: true, hosts: { plan: ["box"] } })).toThrow("no plan step");
  expect(() => buildPreset("implement-review", { task: "t", cwd: ".", write: true, inPlace: true, hosts: { implement: ["box"] } })).toThrow("cannot run on another host");
  // The gated preset passes normal validation (from a directory outside sflow's state, wherever
  // this suite itself runs).
  const dir = mkdtempSync(join(tmpdir(), "sf-preset-"));
  // Command steps run on a snapshot of a Git checkout with a commit.
  for (const args of [["init", "-q"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "init"]])
    expect(Bun.spawnSync(["git", "-C", dir, ...args]).exitCode).toBe(0);
  try { parseWorkflow(buildPreset("implement-review-fix", { task: "t", cwd: dir, write: true, test: "true" }), dir); }
  finally { rmSync(dir, { recursive: true, force: true }); }
});

test("reviews say what is blocking and what is minor", () => {
  const wf = buildPreset("implement-review-fix", { task: "t", cwd: ".", write: true }) as { steps: Record<string, any>[] };
  const review = wf.steps.find(s => s.id === "review-1")!;
  expect(review.prompt).toContain("needs-fix\" only for problems that block");
  expect(review.prompt).toContain("--check 'minor:");
});

test("a --test pipeline fails when its first command fails", () => {
  const wf = buildPreset("implement-review", { task: "t", cwd: ".", write: true, test: "false | cat" }) as { steps: Record<string, any>[] };
  const cmd = wf.steps.find(s => s.id === "test")!.command as string[];
  expect(require("node:child_process").spawnSync(cmd[0], cmd.slice(1)).status).not.toBe(0);
});
