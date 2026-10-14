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
      // Only an implement step may write, and only in a worktree.
      for (const s of wf.steps) expect(s.policy === "workspace-write").toBe(s.id === "implement" && s.worktree === true);
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
