import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTask } from "../src/context";
import type { Run, Step } from "../src/types";

// Synthetic data only. This measures forwarded bytes, not billed model tokens.
const dir = mkdtempSync(join(tmpdir(), "sflow-benchmark-"));
const run = { version: 2, id: "fixture", dir, steps: {
  a: { status: "done", result: { status: "done", summary: "a", details: "x".repeat(12000) } },
  b: { status: "done", result: { status: "done", summary: "b", details: "y".repeat(12000) } }, review: {},
} } as unknown as Run;
const step = { id: "review", agent: "claude", policy: "read-only", cwd: dir, prompt: "review", dependsOn: ["a", "b"] } as Step;
try {
  buildTask(run, step);
  const before = run.steps.review.fullDependencyBytes!, after = run.steps.review.dependencyBytes!;
  console.log(JSON.stringify({ fixture: "two 12KB results", beforeBytes: before, afterBytes: after,
    reductionPercent: Number((100 * (1 - after / before)).toFixed(2)), fullEvidenceRetained: true,
    units: "forwarded dependency bytes; not tokens or overall workflow cost" }, null, 2));
} finally { rmSync(dir, { recursive: true, force: true }); }
