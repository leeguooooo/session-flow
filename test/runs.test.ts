import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkflow } from "../src/config";
import { createRun, saveRun } from "../src/store";
import { listRuns, filterRuns, renderRuns, resolveRunId } from "../src/runs";

const dirs: string[] = [];
afterEach(() => { delete process.env.SFLOW_HOME; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function home() {
  const root = mkdtempSync(join(tmpdir(), "sf-runs-")); dirs.push(root); process.env.SFLOW_HOME = join(root, "state");
  return root;
}
function make(root: string, name: string, project: string, at: number) {
  mkdirSync(join(root, project), { recursive: true });
  const run = createRun(parseWorkflow({ version: 1, name, steps: [{ id: "look", agent: "claude", cwd: join(root, project), prompt: "secret prompt" }] }, root));
  run.createdAt = at; saveRun(run); dirs.push(join(run.socket, "..")); return run;
}

test("runs lists newest first, filters by project and status, and never shows prompts or tokens", () => {
  const root = home();
  const a = make(root, "review", "app", 1000), b = make(root, "review", "app", 2000), c = make(root, "other", "lib", 3000);
  c.status = "done"; c.steps.look.status = "done"; saveRun(c);
  const { runs, broken } = listRuns();
  expect(runs.map(r => r.id)).toEqual([c.id, b.id, a.id]);
  expect(broken).toEqual([]);
  expect(filterRuns(runs, { cwd: join(root, "app") }).map(r => r.id)).toEqual([b.id, a.id]);
  expect(filterRuns(runs, { status: "done" }).map(r => r.id)).toEqual([c.id]);
  expect(runs[1].open).toEqual([{ step: "look", status: "pending" }]);
  const text = renderRuns(runs, broken).join("\n") + JSON.stringify(runs);
  expect(text).toContain(b.id.slice(0, 8));
  expect(text).not.toContain("secret prompt");
  expect(text).not.toContain(a.steps.look.token);
});

test("a damaged record is reported without hiding the others", () => {
  const root = home();
  const good = make(root, "review", "app", 1000);
  const bad = join(root, "state", "runs", "00000000-0000-4000-8000-000000000000"); mkdirSync(bad, { recursive: true });
  writeFileSync(join(bad, "run.json"), "{not json");
  const { runs, broken } = listRuns();
  expect(runs.map(r => r.id)).toEqual([good.id]);
  expect(broken[0].id).toBe("00000000-0000-4000-8000-000000000000");
  expect(renderRuns(runs, broken).join("\n")).toContain("unreadable record");
});

test("a short id resolves only when it is unambiguous", () => {
  const root = home();
  const a = make(root, "review", "app", 1000);
  expect(resolveRunId(a.id)).toBe(a.id);
  expect(resolveRunId(a.id.slice(0, 6))).toBe(a.id);
  expect(() => resolveRunId("abc")).toThrow("invalid run id");
  expect(() => resolveRunId("latest")).toThrow("invalid run id");
  const other = a.id[0] === "f" ? "0000" : "ffff";
  expect(() => resolveRunId(other)).toThrow("no run starts with");
  // Two records sharing a prefix: both are listed, neither is picked.
  const twin = join(root, "state", "runs", a.id.slice(0, 8) + "-0000-4000-8000-000000000000"); mkdirSync(twin, { recursive: true });
  expect(() => resolveRunId(a.id.slice(0, 8))).toThrow("matches 2 runs");
});

test("an unknown command is reported as unknown, and a missing id points to runs", () => {
  const env = { ...process.env, SFLOW_NO_UPDATE_CHECK: "1", SFLOW_HOME: join(tmpdir(), "sf-runs-none") };
  delete (env as Record<string, string | undefined>).SFLOW_TOKEN;
  const run = (...a: string[]) => Bun.spawnSync(["bun", "src/cli.ts", ...a], { env, cwd: import.meta.dir + "/.." }).stderr.toString();
  expect(run("list")).toContain("unknown command: list");
  expect(run("status")).toContain("find it with: sflow runs");
});

test("--cwd matches the real directory behind a symlink, and a deleted project by its recorded path (#10)", () => {
  const { symlinkSync } = require("node:fs") as typeof import("node:fs");
  const root = home();
  const run = make(root, "review", "real", 1000);
  symlinkSync(join(root, "real"), join(root, "alias"));
  const { runs } = listRuns();
  expect(filterRuns(runs, { cwd: join(root, "alias") }).map(r => r.id)).toEqual([run.id]);
  expect(filterRuns(runs, { cwd: join(root, "real") }).map(r => r.id)).toEqual([run.id]);
  expect(filterRuns(runs, { cwd: root }).map(r => r.id)).toEqual([run.id]);
  rmSync(join(root, "real"), { recursive: true });
  expect(filterRuns(listRuns().runs, { cwd: join(root, "real") }).map(r => r.id)).toEqual([run.id]);
  expect(renderRuns([], [], 1)[0]).toContain("no matching runs");
  expect(renderRuns([], [], 0)[0]).toBe("no runs recorded yet");
});
