import { createInterface } from "node:readline";
import { menuKeys, parseMenu, type Menu } from "./prompt";
import type { Run, Workflow } from "./types";
import type { Menu as _Menu } from "./prompt";
type PromptRuntime = { waitingOnPrompt(run: Run, id: string): Promise<_Menu | null>; screen(run: Run, id: string): Promise<string>; keys(run: Run, id: string, keys: string[]): Promise<void> };

export type ProgressMode = "text" | "json" | "none";
const QUIET_MS = 120_000;

function since(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`; }

// The plan as the driver understood it, before anything starts.
export function describe(workflow: Workflow): string[] {
  const lines = [`workflow ${workflow.name}: ${workflow.steps.length} step(s), up to ${workflow.concurrency} at a time`];
  for (const s of workflow.steps) {
    if (s.agent === "command") {
      lines.push(`  ${s.id}: command \`${s.command!.join(" ")}\` on ${s.host ? `host ${s.host.join(" or ")}` : "this machine"}, reading a frozen copy of ${s.workspace ? `${s.workspace}'s worktree` : s.cwd}` +
        `${s.dependsOn.length ? `, after ${s.dependsOn.join(", ")}` : ""}${s.artifacts?.length ? `, brings back ${s.artifacts.join(", ")}` : ""}` +
        `${s.when ? `, only if ${Object.entries(s.when).map(([d, f]) => `${d} ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")}`).join(" and ")}` : ""}` +
        `${s.allowFailure ? ", a failing exit is passed on as its result" : ""}`);
      continue;
    }
    lines.push(`  ${s.id}: ${s.agent}${s.model ? ` (${s.model})` : ""}${s.host ? ` on host ${s.host.join(" or ")}` : ""}, ${s.inPlace ? "WRITES DIRECTLY IN CHECKOUT" : s.workspace ? `writes in ${s.workspace}'s workspace of` : s.policy === "workspace-write" ? "writes in a new git worktree of" : "read-only on"} ${s.cwd}` +
      `${s.reuseSession ? `, continues session from ${s.reuseSession}` : ""}${s.dependsOn.length ? `, after ${s.dependsOn.join(", ")}` : ""}` +
      `${s.when ? `, only if ${Object.entries(s.when).map(([d, f]) => `${d} ${Object.entries(f).map(([k, v]) => `${k}=${v}`).join(" ")}`).join(" and ")}` : ""}` +
      `${s.expect ? `, must report ${Object.entries(s.expect).map(([k, v]) => `${k}=${v}`).join(" ")}` : ""}`);
  }
  return lines;
}

// Watches the run the driver is mutating and reports only what it observes: step status changes,
// prompts on a worker's screen, and a reminder when nothing has changed for a while. Never infers
// completion from a live process. With a terminal on stdin, a typed number answers the prompt shown.
export class Progress {
  private status = new Map<string, string>();
  private hostWait = new Map<string, number>();
  private prompts = new Map<string, Menu>();
  // The TUI redraws a moment after a key; until then the answered menu is still on screen.
  private answered = new Map<string, { id: string; at: number }>();
  private changedAt = Date.now();
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private input?: ReturnType<typeof createInterface>;

  constructor(private run: Run, private runtime: PromptRuntime, private mode: ProgressMode,
    private write: (line: string) => void = line => process.stderr.write(line + "\n"), private interactive = Boolean(process.stdin.isTTY)) {
    // A resumed run starts from its recorded state; only later changes are reported.
    for (const [id, s] of Object.entries(run.steps)) this.status.set(id, s.status);
  }

  start(intervalMs = 1000) {
    if (this.mode === "none") return;
    if (this.mode === "text") {
      this.write(`run ${this.run.id}`);
      for (const line of describe(this.run.workflow)) this.write(line);
    }
    if (this.interactive && this.mode === "text") {
      this.input = createInterface({ input: process.stdin });
      this.input.on("line", line => { void this.answer(line.trim()); });
    }
    this.timer = setInterval(() => { void this.poll(); }, intervalMs);
  }
  async stop() {
    if (this.timer) clearInterval(this.timer);
    this.input?.close(); if (this.input) process.stdin.pause();
    this.prompts.clear(); await this.poll();
  }

  private emit(event: Record<string, unknown>, text: string) {
    if (this.mode === "json") this.write(JSON.stringify({ at: new Date().toISOString(), runId: this.run.id, ...event }));
    else if (this.mode === "text") this.write(`[+${since(Date.now() - (this.run.createdAt ?? Date.now()))}] ${text}`);
  }

  async poll() {
    if (this.busy) return; this.busy = true;
    try {
      for (const step of this.run.workflow.steps) {
        const s = this.run.steps[step.id], before = this.status.get(step.id);
        if (s.status !== before) {
          this.status.set(step.id, s.status); this.changedAt = Date.now();
          this.prompts.delete(step.id);
          const result = s.result as { summary?: unknown } | undefined;
          const detail = s.status === "running" ? (step.agent === "command" ? `started on ${s.host ?? "this machine"}` : `accepted the task${s.host ? ` on ${s.host}` : ""}`) : ["done", "failed", "blocked"].includes(s.status) && result?.summary ? String(result.summary).slice(0, 160)
            : s.error ? s.error : "";
          this.emit({ type: "step", step: step.id, agent: step.agent, status: s.status, ...(detail ? { detail } : {}) },
            `${step.id} (${step.agent}): ${s.status}${detail ? ` — ${detail}` : ""}`);
        }
        // A step waiting for a busy host stays pending, so its status never changes: say why once.
        if (s.status === "pending" && s.hostWaitSince !== undefined && this.hostWait.get(step.id) !== s.hostWaitSince) {
          this.hostWait.set(step.id, s.hostWaitSince); this.changedAt = Date.now();
          this.emit({ type: "step", step: step.id, agent: step.agent, status: "pending", detail: s.error ?? "waiting for a host" },
            `${step.id} (${step.agent}): ${s.error ?? "waiting for a host"} (up to ${step.timeoutSeconds}s)`);
        }
        // Trust/login prompts come before acceptance, tool approvals after it.
        if (["starting", "running"].includes(s.status) && this.mode !== "none" && step.agent !== "command") {
          const menu = await this.runtime.waitingOnPrompt(this.run, step.id);
          const recent = this.answered.get(step.id);
          if (menu && recent?.id === menu.id && Date.now() - recent.at < 5000) continue;
          if (menu && this.prompts.get(step.id)?.id !== menu.id) { this.prompts.set(step.id, menu); this.changedAt = Date.now(); this.showPrompt(step.id, step.agent, menu); }
          if (!menu) this.prompts.delete(step.id);
        }
      }
      if (this.mode === "text" && Date.now() - this.changedAt > QUIET_MS && this.run.status === "running") {
        this.changedAt = Date.now();
        const busy = Object.entries(this.run.steps).filter(([, s]) => ["starting", "running"].includes(s.status))
          .map(([id, s]) => `${id} ${s.status} ${since(Date.now() - (s.startedAt ?? Date.now()))}`);
        if (busy.length) this.write(`  still working: ${busy.join("; ")}. Look at one with: sflow logs ${this.run.id} <step>`);
        const waiting = Object.entries(this.run.steps).filter(([, s]) => s.status === "pending" && s.hostWaitSince !== undefined)
          .map(([id, s]) => `${id} ${since(Date.now() - s.hostWaitSince!)}`);
        if (waiting.length) this.write(`  waiting for a host: ${waiting.join("; ")}. See them with: sflow hosts check`);
      }
    } finally { this.busy = false; }
  }

  private showPrompt(stepId: string, agent: string, menu: Menu) {
    this.emit({ type: "prompt", step: stepId, agent, prompt: menu }, `${stepId} (${agent}) is waiting for your answer:`);
    if (this.mode !== "text") return;
    for (const line of menu.question.filter(Boolean).slice(-8)) this.write(`    ${line}`);
    menu.options.forEach((o, i) => this.write(`    ${i + 1}) ${o}`));
    const multiple = this.prompts.size > 1;
    this.write(this.interactive
      ? `  Type ${multiple ? `"${stepId} <n>"` : "a number"} and Enter to answer here, or run: sflow answer ${this.run.id} ${stepId} ${menu.id} <n>`
      : `  Answer with: sflow answer ${this.run.id} ${stepId} ${menu.id} <n>  (or sflow attach ${this.run.id} ${stepId})`);
  }

  // Typed input answers only a prompt that is still on screen exactly as it was shown.
  async answer(line: string) {
    if (!line) return;
    const m = /^(?:([a-z][a-z0-9-]*)\s+)?(\d+)$/.exec(line);
    if (!m) { this.write(`  type a number (or "<step> <n>" when several steps are waiting)`); return; }
    const pending = [...this.prompts.keys()];
    const stepId = m[1] ?? (pending.length === 1 ? pending[0] : undefined);
    if (!stepId || !this.prompts.has(stepId)) { this.write(pending.length ? `  several steps are waiting (${pending.join(", ")}); type "<step> <n>"` : "  no step is waiting for an answer"); return; }
    const shown = this.prompts.get(stepId)!;
    const now = parseMenu(await this.runtime.screen(this.run, stepId).catch(() => ""));
    if (!now || now.id !== shown.id) {
      this.prompts.delete(stepId);
      this.write(`  ${stepId}: the prompt changed before your answer; nothing was sent`);
      return;
    }
    let keys: string[];
    try { keys = menuKeys(now, Number(m[2])); } catch (e) { this.write(`  ${(e as Error).message}`); return; }
    await this.runtime.keys(this.run, stepId, keys);
    this.prompts.delete(stepId); this.answered.set(stepId, { id: now.id, at: Date.now() });
    this.emit({ type: "answered", step: stepId, option: now.options[Number(m[2]) - 1] }, `${stepId}: answered "${now.options[Number(m[2]) - 1]}"`);
  }
}
