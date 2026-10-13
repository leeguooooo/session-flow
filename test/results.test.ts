import { test, expect } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { storeResult, resolveResult } from "../src/results";
import type { Run } from "../src/types";

test("an orphaned file before send cannot prevent a later terminal report", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-orphan-")); const run = { version: 2, dir, steps: { a: { status: "running" } } } as unknown as Run;
  try {
    const orphan = storeResult(run, "a", { status: "done", summary: "first draft" });
    const retry = storeResult(run, "a", { status: "done", summary: "verified draft" });
    expect(retry.fullResultFile).not.toBe(orphan.fullResultFile);
    expect(resolveResult(run, "a", retry).summary).toBe("verified draft");
    expect(storeResult(run, "a", { status: "done", summary: "verified draft" })).toEqual(retry);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("a result reference cannot point at another step or arbitrary local file", () => {
  const dir = mkdtempSync(join(tmpdir(), "sf-ref-")); const run = { version: 2, dir, steps: { a: { status: "running" }, b: { status: "running" } } } as unknown as Run;
  try {
    const ref = storeResult(run, "a", { status: "done", summary: "verified" });
    expect(() => resolveResult(run, "b", ref)).toThrow("invalid result reference");
    expect(() => resolveResult(run, "a", { ...ref, fullResultFile: "/arbitrary/file" })).toThrow("invalid result reference");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
