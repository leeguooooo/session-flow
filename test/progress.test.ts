import { test, expect, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkflow } from "../src/config";
import { createRun } from "../src/store";
import { Progress, describe } from "../src/progress";
import { reviewRun, renderReview } from "../src/review";
import type { TmuxRuntime } from "../src/runtime";
import type { Run } from "../src/types";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function setup() {
  const home = mkdtempSync(join(tmpdir(), "sf-progress-")); dirs.push(home); process.env.SFLOW_HOME = join(home, "state");
  const project = join(home, "project"); mkdirSync(project);
  const run = createRun(parseWorkflow({ version: 1, name: "progress", steps: [
    { id: "plan", agent: "claude", cwd: project, prompt: "p" },
    { id: "check", agent: "codex", cwd: project, prompt: "c", dependsOn: ["plan"] }] }, home));
  dirs.push(join(run.socket, "..")); return run;
}
const trust = (path: string) => ` Accessing workspace:\n ${path}\n\n ❯ No, exit\n   Yes, I trust this folder\n\n Enter to confirm · Esc to cancel`;
function fakeRuntime(screens: Record<string, string>, sent: string[][]) {
  return {
    async screen(_r: Run, id: string) { return screens[id] ?? ""; },
    async waitingOnPrompt(_r: Run, id: string) { const { parseMenu } = await import("../src/prompt"); return parseMenu(screens[id] ?? ""); },
    async keys(_r: Run, _id: string, keys: string[]) { sent.push(keys); },
    async exists() { return false; },
  } as unknown as TmuxRuntime;
}

test("the plan is described before anything starts", () => {
  const run = setup();
  const lines = describe(run.workflow);
  expect(lines[0]).toContain("2 step(s)");
  expect(lines[1]).toContain("plan: claude, read-only on");
  expect(lines[2]).toContain("after plan");
});

test("progress reports observed changes and prompts, and a typed number answers only the prompt shown", async () => {
  const run = setup(), lines: string[] = [], sent: string[][] = [];
  const screens: Record<string, string> = {};
  const progress = new Progress(run, fakeRuntime(screens, sent), "text", l => lines.push(l), true);
  await progress.poll();
  expect(lines).toEqual([]);

  run.steps.plan.status = "starting"; screens.plan = trust("/a");
  await progress.poll();
  expect(lines.some(l => l.includes("plan (claude): starting"))).toBe(true);
  expect(lines.some(l => l.includes("plan (claude) is waiting for your answer"))).toBe(true);
  expect(lines).toContain("    2) Yes, I trust this folder");
  const shown = lines.length;
  await progress.poll();
  expect(lines.length).toBe(shown); // the same prompt is not repeated

  await progress.answer("7");
  expect(lines.at(-1)).toContain("choose 1..2");
  screens.plan = trust("/b"); // the screen changed after it was shown
  await progress.answer("2");
  expect(sent).toEqual([]);
  expect(lines.at(-1)).toContain("prompt changed before your answer; nothing was sent");

  await progress.poll(); // the new prompt is shown, then answered
  await progress.answer("2");
  expect(sent).toEqual([["Down", "Enter"]]);
  expect(lines.at(-1)).toContain('answered "Yes, I trust this folder"');
  const answeredAt = lines.length;
  await progress.poll(); // the screen has not redrawn yet: the answered prompt is not shown again
  expect(lines.length).toBe(answeredAt);

  run.steps.plan.status = "done"; run.steps.plan.result = { status: "done", summary: "plan-ready" };
  await progress.poll();
  expect(lines.at(-1)).toContain("plan (claude): done — plan-ready");
});

test("json progress emits one event per line", async () => {
  const run = setup(), lines: string[] = [];
  const progress = new Progress(run, fakeRuntime({}, []), "json", l => lines.push(l), false);
  run.steps.plan.status = "running"; await progress.poll();
  const event = JSON.parse(lines[0]);
  expect(event).toMatchObject({ type: "step", step: "plan", agent: "claude", status: "running", runId: run.id });
});

test("review separates what a worker claimed from what is left to do", async () => {
  const run = setup();
  run.steps.plan.status = "done"; run.steps.plan.startedAt = Date.now() - 5000; run.steps.plan.finishedAt = Date.now();
  run.steps.plan.result = { status: "done", summary: "plan-ready", checks: [{ name: "lint", passed: true }] };
  run.steps.check.status = "blocked"; run.steps.check.result = { status: "blocked", summary: "needs access" };
  const review = await reviewRun(run, fakeRuntime({}, []) as never);
  expect(review.steps[0]).toMatchObject({ id: "plan", agent: "claude", status: "done", elapsed: "5s", reported: { summary: "plan-ready" } });
  expect(review.next.join("\n")).toContain("check: reported blocked; that is final for this run");
  const text = renderReview(review).join("\n");
  expect(text).toContain("checks (as reported, not rerun)");
  expect(text).toContain("Review the actual diff and rerun checks before accepting");
  expect(text).not.toContain(run.steps.plan.token);
});
