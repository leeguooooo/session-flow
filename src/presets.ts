import { resolve } from "node:path";
import { AGENTS } from "./types";

export const PRESETS = {
  review: "one read-only review of the project",
  "implement-review": "implement in a git worktree, then a read-only review of the actual diff (needs --write)",
  "plan-implement-review": "plan, implement in a git worktree, then review the actual diff (needs --write)",
  "fan-out": "several agents look at the same task in parallel, one joins their findings",
} as const;
export type Preset = keyof typeof PRESETS;

export interface PresetOptions { task: string; cwd: string; write?: boolean; plan?: string; implement?: string; review?: string; agents?: string[]; join?: string; name?: string }

const IMPLEMENT = (task: string) => `Task: ${task}
Implement it in your isolated git worktree (your current working directory). Keep the change as small as the task allows and follow the project's conventions. Run the project's relevant checks. Do not commit, push or merge.
Report done with: summary; details.workspace = absolute path of the worktree; artifacts = the files you changed; checks = [{"command": ..., "passed": true|false, "output": last lines}]. Report blocked if you cannot finish.`;
const REVIEW = (task: string, after: string) => `Task under review: ${task}
Find the worktree path in the ${after} dependency result (details.workspace). Inspect the actual change there yourself: git -C <path> status and git -C <path> diff. Rerun the key checks when you can do so without editing. Do not rely on the implementer's summary.
Do not edit, commit or merge. Report done with findings (problems first, each with file and line), and whether the task is met; report blocked if the worktree or evidence is missing.`;

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
  const writes = preset === "implement-review" || preset === "plan-implement-review";
  if (writes && !o.write) throw new Error(`${preset} lets an agent write code in a new git worktree of ${cwd} (your checkout stays untouched, nothing is committed). Add --write to confirm`);
  if (!writes && o.write) throw new Error(`${preset} is read-only; --write does not apply`);
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
      prompt: `Task: ${o.task}\nRead the relevant code and propose the smallest change that does it: files to touch, approach, and acceptance criteria someone can check. Do not edit files. Report done with the plan.` });
    steps.push({ id: "implement", agent: agent(o.implement, "codex", "--implement"), cwd, policy: "workspace-write", worktree: true,
      ...(steps.length ? { dependsOn: ["plan"] } : {}), prompt: IMPLEMENT(o.task) + (steps.length ? "\nFollow the plan in the plan dependency result." : "") });
    steps.push({ id: "review", agent: agent(o.review, "claude", "--review"), cwd, dependsOn: ["implement"], prompt: REVIEW(o.task, "implement") });
  }
  return { version: 1, name: o.name ?? preset, concurrency: preset === "fan-out" ? Math.min(steps.length - 1, 4) : 2, steps };
}
