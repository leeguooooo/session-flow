import { resolve } from "node:path";
import { AGENTS } from "./types";

export const PRESETS = {
  review: "one read-only review of the project",
  "implement-review": "implement in a git worktree, then a read-only review of the actual diff (needs --write)",
  "plan-implement-review": "plan, implement in a git worktree, then review the actual diff (needs --write)",
  "implement-review-fix": "implement in a git worktree, review; on needs-fix, fix in the same worktree and review again, up to --rounds (needs --write)",
  "fan-out": "several agents look at the same task in parallel, one joins their findings",
} as const;
export type Preset = keyof typeof PRESETS;

export interface PresetOptions { task: string; cwd: string; write?: boolean; inPlace?: boolean; reuseSessions?: boolean; plan?: string; implement?: string; review?: string; agents?: string[]; join?: string; name?: string; rounds?: number;
  // A command run on the worktree after each write round; reviews read its result.
  test?: string;
  // Hosts per role: plan, implement (also its fix rounds), review, test.
  hosts?: Record<string, string[]> }
export interface TestGate { command: string[] }
export const TESTED = (id: string, cmd: string[]) => `The ${id} dependency is a command step that ran \`${cmd.join(" ")}\` on that worktree. Read its exit code and log (details.exitCode, details.logTail, the log file) before judging; a non-zero exit is a problem that blocks acceptance unless the task says otherwise.`;

export const IMPLEMENT = (task: string) => `Task: ${task}
Implement it in your isolated git worktree (your current working directory). It is a fresh checkout: install the project's dependencies first if its checks need them. Keep the change as small as the task allows and follow the project's conventions. Run the project's relevant checks. Do not commit, push or merge.
Report done with: summary; details.workspace = absolute path of the worktree; artifacts = the files you changed; checks = [{"command": ..., "passed": true|false, "output": last lines}]. Report blocked if you cannot finish.`;
export const REVIEW = (task: string, after: string) => `Task under review: ${task}
Find the worktree path in the ${after} dependency result (details.workspace). Inspect the actual change there yourself: git -C <path> status and git -C <path> diff. Rerun the key checks when you can do so without editing. Do not rely on the implementer's summary.
Do not edit, commit or merge. Report done with findings (problems first, each with file and line), and whether the task is met; report blocked if the worktree or evidence is missing.`;

export const VERDICT = `End with a verdict in details.verdict. "needs-fix" only for problems that block accepting the change: wrong behaviour, a failing or missing check the task needs, data loss, a security hole, or the task not met. List those first, each with file and line. Everything else (style, naming, a rare edge case, a nice-to-have test) is minor: report it as --check 'minor: <what and where>' and still give "pass". Report it with: report done '<summary>' --detail verdict=pass (or verdict=needs-fix), adding --check for what you ran.`;
export const FIX = (task: string, review: string) => `Task: ${task}
A reviewer found problems in the change in this worktree (your current working directory). Read the ${review} dependency result and fix what it lists as blocking (items marked minor are optional), nothing else. If the review quotes a failing test, run that test yourself until it passes. Keep the existing uncommitted changes; do not reset, stash or recreate the worktree. Rerun the relevant checks. Do not commit, push or merge.
Report done with: summary of what you changed for each finding; details.workspace = absolute path of the worktree; checks with what you ran. Report blocked if a finding cannot be fixed as described.`;

function agent(value: string | undefined, fallback: string, flag: string) {
  const a = value ?? fallback;
  if (!(AGENTS as readonly string[]).includes(a)) throw new Error(`${flag}: agent must be one of ${AGENTS.join(", ")}`);
  return a;
}

// Builds a plain workflow JSON for a common shape; it goes through the same validation as a
// hand-written one and can be edited and rerun. Writing is never enabled without --write.
export function buildPreset(preset: string, o: PresetOptions): Record<string, unknown> {
  if (!(preset in PRESETS)) throw new Error(`unknown preset ${preset}; one of: ${Object.keys(PRESETS).join(", ")}`);
  if (!o.task?.trim()) throw new Error("--task is required: describe the work in one or two sentences");
  const cwd = resolve(o.cwd);
  const writes = ["implement-review", "plan-implement-review", "implement-review-fix"].includes(preset);
  const rounds = o.rounds ?? 2;
  if (o.rounds !== undefined && preset !== "implement-review-fix") throw new Error("--rounds only applies to implement-review-fix");
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 5) throw new Error("--rounds must be 1..5");
  if (writes && !o.write) throw new Error(`${preset} lets an agent write code in a new git worktree of ${cwd} (your checkout stays untouched, nothing is committed). Add --write to confirm`);
  if (!writes && o.write) throw new Error(`${preset} is read-only; --write does not apply`);
  if (!writes && o.test) throw new Error(`--test runs after code is written; ${preset} does not write`);
  if (o.inPlace && (!writes || !o.write)) throw new Error("--in-place requires a write preset and --write; it modifies " + cwd + " directly");
  if (o.reuseSessions && preset !== "implement-review-fix") throw new Error("--reuse-sessions only applies to implement-review-fix");
  const steps: Record<string, unknown>[] = [];
  if (preset === "review") {
    steps.push({ id: "review", agent: agent(o.review, "claude", "--review"), cwd,
      prompt: `${o.task}\nRead the relevant code and report done with findings (problems first, each with file and line). Do not edit files.` });
  } else if (preset === "fan-out") {
    const agents = o.agents?.length ? o.agents : ["claude", "codex"];
    if (agents.length < 2) throw new Error("--agents needs at least two agents, e.g. --agents claude,codex");
    agents.forEach((a, i) => steps.push({ id: `look-${i + 1}`, agent: agent(a, a, "--agents"), cwd,
      prompt: `${o.task}\nWork independently and read only what you need. Do not edit files. Report done with your findings, each with evidence (file and line, command and output).` }));
    steps.push({ id: "join", agent: agent(o.join, "claude", "--join"), cwd, dependsOn: steps.map(s => s.id),
      prompt: `Task: ${o.task}\nCompare the dependency results. Report done with the findings they agree on, where they disagree and which side the evidence supports, and anything none of them checked. Verify a disputed point in the code yourself before deciding it. Do not edit files.` });
  } else {
    if (preset === "plan-implement-review") steps.push({ id: "plan", agent: agent(o.plan, "claude", "--plan"), cwd,
      prompt: `Task: ${o.task}\nRead the relevant code and propose the smallest change that does it: files to touch, approach, and acceptance criteria someone can check. Do not edit files. Report done with the plan and --detail acceptance='<explicit acceptance criteria>'.` });
    steps.push({ id: "implement", agent: agent(o.implement, "codex", "--implement"), cwd, policy: "workspace-write", worktree: true,
      ...(steps.length ? { dependsOn: ["plan"] } : {}), prompt: IMPLEMENT(o.task) + (steps.length ? "\nFollow the plan in the plan dependency result." : "") });
    // pipefail where the shell has it: "bun test | tail" must not report the tail's success.
    const gate: TestGate | undefined = o.test ? { command: ["sh", "-c", `set -o pipefail 2>/dev/null; ${o.test}`] } : undefined;
    if (preset !== "implement-review-fix") {
      if (gate) steps.push(testStep("test", gate, cwd, "implement", "implement"));
      steps.push({ id: "review", agent: agent(o.review, "claude", "--review"), cwd,
        dependsOn: [...(steps.some(s => s.id === "plan") ? ["implement", "plan"] : ["implement"]), ...(gate ? ["test"] : [])],
        prompt: REVIEW(o.task, "implement") + (steps.some(s => s.id === "plan") ? "\n" + ACCEPTANCE : "") + (gate ? "\n" + TESTED("test", gate.command) : "") });
    } else {
      // Rounds are unrolled into distinct steps: each round has its own identity, so a late report
      // can never advance another round. A round that is not needed is skipped.
      const reviewer = agent(o.review, "claude", "--review"), fixer = agent(o.implement, "codex", "--implement");
      if (gate) steps.push(testStep("test-0", gate, cwd, "implement", "implement"));
      steps.push(...expandReviewFix({ id: "review", agent: reviewer, cwd, dependsOn: ["implement", ...(gate ? ["test-0"] : [])], prompt: REVIEW(o.task, "implement") },
        { agent: fixer }, "implement", rounds, o.task, gate));
    }
  }
  if (o.inPlace) {
    const implementation = steps.find(s => s.id === "implement")!;
    delete implementation.worktree; implementation.inPlace = true;
    implementation.prompt = String(implementation.prompt).replace("isolated git worktree", "existing project checkout") + "\nPreserve pre-existing user edits. Do not reset, stash or clean. Only change files needed for this task.";
  }
  if (o.reuseSessions) {
    for (const s of steps.filter(s => String(s.id).startsWith("fix-"))) s.reuseSession = "implement";
  }
  for (const [role, hosts] of Object.entries(o.hosts ?? {})) {
    if (!["plan", "implement", "review", "test"].includes(role)) throw new Error(`--host ${role}=…: role is plan, implement, review or test`);
    const of = (id: string) => id === "plan" ? "plan" : id === "implement" || id.startsWith("fix-") ? "implement" : id.startsWith("test") ? "test" : id.startsWith("review") || id === "join" || id.startsWith("look-") ? "review" : "";
    const matched = steps.filter(s => of(String(s.id)) === role);
    if (!matched.length) throw new Error(`--host ${role}: this preset has no ${role} step`);
    for (const s of matched) s.host = hosts;
  }
  if (o.inPlace && o.hosts?.implement) throw new Error("--in-place edits this machine's checkout; it cannot run on another host");
  return { version: 1, name: o.name ?? preset, concurrency: preset === "fan-out" ? Math.min(steps.length - 1, 4) : 2, steps };
}


export const ACCEPTANCE = "Read plan.details.acceptance from the plan dependency. Verify every acceptance criterion against the actual diff and checks; include each criterion and its conclusion in your reported checks. Block if acceptance evidence is missing.";

// The one expansion used by both legacy presets and user templates. Each round has its own
// identity, and all non-implementation dependencies (including plan) reach every review.
// The test gate after implement is the caller's (it is the first review's dependency); this adds
// one after each fix round, and every later review reads its own round's test.
export function testStep(id: string, gate: TestGate, cwd: unknown, workspace: string, after: string, when?: Record<string, unknown>): Record<string, unknown> {
  return { id, agent: "command", cwd, workspace, dependsOn: [after], command: gate.command, allowFailure: true, ...(when ? { when } : {}) };
}
export function expandReviewFix(first: Record<string, unknown>, fixer: Record<string, unknown>, workspace: string, rounds: number, task: string, gate?: TestGate): Record<string, unknown>[] {
  const prefix = String(first.id), reviewId = (n: number) => `${prefix}-${n}`;
  const fixId = (n: number) => prefix === "review" ? `fix-${n}` : `${prefix}-fix-${n}`;
  const deps = first.dependsOn as string[], extra = deps.filter(d => d !== workspace && !(gate && d === "test-0"));
  const reviewIdentity = first.role ? { role: first.role } : { agent: first.agent };
  const hasPlan = extra.includes("plan"), acceptance = hasPlan ? "\n" + ACCEPTANCE : "";
  const tested = (k: number) => gate ? `\n${TESTED(`test-${k}`, gate.command)}` : "";
  const steps: Record<string, unknown>[] = [{ ...first, id: reviewId(1), prompt: `${first.prompt}${acceptance}${tested(0)}\n${VERDICT}` }];
  for (let k = 1; k <= rounds; k++) {
    steps.push({ id: fixId(k), ...fixer, cwd: first.cwd, policy: "workspace-write", workspace, dependsOn: [reviewId(k)],
      when: { [reviewId(k)]: { "details.verdict": "needs-fix" } }, prompt: FIX(task, reviewId(k)) });
    if (gate) steps.push(testStep(`test-${k}`, gate, first.cwd, workspace, fixId(k), { [fixId(k)]: { status: "done" } }));
    steps.push({ id: reviewId(k + 1), ...reviewIdentity, cwd: first.cwd,
      dependsOn: [reviewId(k), fixId(k), ...extra, ...(gate ? [`test-${k}`] : [])], when: { [fixId(k)]: { status: "done" } },
      prompt: `${REVIEW(task, fixId(k))}\nThe ${reviewId(k)} dependency result lists what the previous review asked to fix; check each item and look for new problems.${acceptance}${tested(k)}\n${VERDICT}`,
      ...(first.timeoutSeconds !== undefined ? { timeoutSeconds: first.timeoutSeconds } : {}),
      ...(first.readyTimeoutSeconds !== undefined ? { readyTimeoutSeconds: first.readyTimeoutSeconds } : {}),
      ...(k === rounds ? { expect: { "details.verdict": "pass" } } : {}) });
  }
  return steps;
}
