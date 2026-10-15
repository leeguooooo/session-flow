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

export interface PresetOptions { task: string; cwd: string; write?: boolean; inPlace?: boolean; reuseSessions?: boolean; plan?: string; implement?: string; review?: string; agents?: string[]; join?: string; name?: string; rounds?: number }

export const IMPLEMENT = (task: string) => `Task: ${task}
Implement it in your isolated git worktree (your current working directory). Keep the change as small as the task allows and follow the project's conventions. Run the project's relevant checks. Do not commit, push or merge.
Report done with: summary; details.workspace = absolute path of the worktree; artifacts = the files you changed; checks = [{"command": ..., "passed": true|false, "output": last lines}]. Report blocked if you cannot finish.`;
export const REVIEW = (task: string, after: string) => `Task under review: ${task}
Find the worktree path in the ${after} dependency result (details.workspace). Inspect the actual change there yourself: git -C <path> status and git -C <path> diff. Rerun the key checks when you can do so without editing. Do not rely on the implementer's summary.
Do not edit, commit or merge. Report done with findings (problems first, each with file and line), and whether the task is met; report blocked if the worktree or evidence is missing.`;

export const VERDICT = `End with a verdict in details.verdict: "pass" if the task is met with no problem that must be fixed first, otherwise "needs-fix" with the problems to fix listed first. Report it with: report done '<summary>' --detail verdict=pass (or verdict=needs-fix), adding --check for what you ran.`;
export const FIX = (task: string, review: string) => `Task: ${task}
A reviewer found problems in the change in this worktree (your current working directory). Read the ${review} dependency result and fix what it lists, nothing else. Keep the existing uncommitted changes; do not reset, stash or recreate the worktree. Rerun the relevant checks. Do not commit, push or merge.
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
    if (preset !== "implement-review-fix") steps.push({ id: "review", agent: agent(o.review, "claude", "--review"), cwd, dependsOn: steps.some(s => s.id === "plan") ? ["implement", "plan"] : ["implement"], prompt: REVIEW(o.task, "implement") + (steps.some(s => s.id === "plan") ? "\n" + ACCEPTANCE : "") });
    else {
      // Rounds are unrolled into distinct steps: each round has its own identity, so a late report
      // can never advance another round. A round that is not needed is skipped.
      const reviewer = agent(o.review, "claude", "--review"), fixer = agent(o.implement, "codex", "--implement");
      steps.push(...expandReviewFix({ id: "review", agent: reviewer, cwd, dependsOn: ["implement"], prompt: REVIEW(o.task, "implement") },
        { agent: fixer }, "implement", rounds, o.task));
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
  return { version: 1, name: o.name ?? preset, concurrency: preset === "fan-out" ? Math.min(steps.length - 1, 4) : 2, steps };
}


export const ACCEPTANCE = "Read plan.details.acceptance from the plan dependency. Verify every acceptance criterion against the actual diff and checks; include each criterion and its conclusion in your reported checks. Block if acceptance evidence is missing.";

// The one expansion used by both legacy presets and user templates. Each round has its own
// identity, and all non-implementation dependencies (including plan) reach every review.
export function expandReviewFix(first: Record<string, unknown>, fixer: Record<string, unknown>, workspace: string, rounds: number, task: string): Record<string, unknown>[] {
  const prefix = String(first.id), reviewId = (n: number) => `${prefix}-${n}`;
  const fixId = (n: number) => prefix === "review" ? `fix-${n}` : `${prefix}-fix-${n}`;
  const deps = first.dependsOn as string[], extra = deps.filter(d => d !== workspace);
  const reviewIdentity = first.role ? { role: first.role } : { agent: first.agent };
  const hasPlan = extra.includes("plan"), acceptance = hasPlan ? "\n" + ACCEPTANCE : "";
  const steps: Record<string, unknown>[] = [{ ...first, id: reviewId(1), prompt: `${first.prompt}${acceptance}\n${VERDICT}` }];
  for (let k = 1; k <= rounds; k++) {
    steps.push({ id: fixId(k), ...fixer, cwd: first.cwd, policy: "workspace-write", workspace, dependsOn: [reviewId(k)],
      when: { [reviewId(k)]: { "details.verdict": "needs-fix" } }, prompt: FIX(task, reviewId(k)) });
    steps.push({ id: reviewId(k + 1), ...reviewIdentity, cwd: first.cwd,
      dependsOn: [reviewId(k), fixId(k), ...extra], when: { [fixId(k)]: { status: "done" } },
      prompt: `${REVIEW(task, fixId(k))}\nThe ${reviewId(k)} dependency result lists what the previous review asked to fix; check each item and look for new problems.${acceptance}\n${VERDICT}`,
      ...(first.timeoutSeconds !== undefined ? { timeoutSeconds: first.timeoutSeconds } : {}),
      ...(first.readyTimeoutSeconds !== undefined ? { readyTimeoutSeconds: first.readyTimeoutSeconds } : {}),
      ...(k === rounds ? { expect: { "details.verdict": "pass" } } : {}) });
  }
  return steps;
}
