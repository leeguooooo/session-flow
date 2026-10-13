import { test, expect } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { buildTask, prefixGroup } from "../src/context";
import { runMetrics } from "../src/metrics";
import type { Run, Step } from "../src/types";

test("medium dependency payloads are bounded with complete verifiable evidence retained", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-context-"));
  const step = { id: "review", cwd: dir, agent: "claude", policy: "read-only", prompt: "review", dependsOn: ["a", "b"] } as Step;
  const run = { id: "fixture", dir, steps: { a: { status: "done", result: { status: "done", summary: "a", details: "x".repeat(12000) } },
    b: { status: "done", result: { status: "done", summary: "b", details: "y".repeat(12000) } }, review: {} } } as unknown as Run;
  try {
    const task = buildTask(run, step);
    expect(run.steps.review.dependencyBytes!).toBeLessThan(4096);
    expect(run.steps.review.dependencyBytes!).toBeLessThan(run.steps.review.fullDependencyBytes! / 10);
    const ref = task.dependencies.a;
    const bytes = readFileSync(ref.resultFile as string);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(String(ref.sha256));
    expect(JSON.parse(bytes.toString()).details.length).toBe(12000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("wide fan-in uses one manifest and small results retain convenient inline values", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-manifest-"));
  const deps = Array.from({ length: 30 }, (_, i) => `s${i}`);
  const step = { id: "review", cwd: dir, agent: "claude", policy: "read-only", prompt: "review", dependsOn: deps } as Step;
  const run = { id: "fixture", dir, steps: Object.fromEntries([...deps.map(id => [id, { status: "done", result: { status: "done", summary: id, details: "x".repeat(1200) } }]), ["review", {}]]) } as unknown as Run;
  try {
    const task = buildTask(run, step); expect(task.dependencies).toEqual({}); expect(task.dependencyManifest!.count).toBe(30);
    expect(JSON.parse(readFileSync(task.dependencyManifest!.path, "utf8"))).toHaveProperty("s29");
    step.dependsOn = ["s0"]; run.steps.s0.result = { status: "done", summary: "small", details: { n: 42 } };
    expect(buildTask(run, step).dependencies.s0.details).toEqual({ n: 42 });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("cache groups distinguish provider/model and do not group isolated write workers", () => {
  const step = { agent: "claude", model: "model-a", policy: "read-only" } as Step;
  expect(prefixGroup(step)).not.toBe(prefixGroup({ ...step, model: "model-b" }));
  expect(prefixGroup(step)).not.toBe(prefixGroup({ ...step, agent: "codex" }));
  expect(prefixGroup({ ...step, policy: "workspace-write" })).toBeUndefined();
});
test("metrics describe actual local traffic rather than claiming token/cache savings", () => {
  const run = { id: "fixture", steps: {} } as Run;
  const metrics = runMetrics(run, [{ seq: 1, from: "sflow-fixture", body: JSON.stringify({ type: "sflow.task", runId: "fixture" }) }, { seq: 2, from: "other", body: "thanks" }]);
  expect(metrics.assignments).toBe(1); expect(metrics.otherMessages).toBe(1); expect(metrics.protocolWakeRequests).toBe(0);
  expect(metrics.units).toContain("not model tokens");
});
