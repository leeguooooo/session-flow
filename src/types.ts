export type Agent = "claude" | "codex" | "pi" | "agy";
export const AGENTS: readonly Agent[] = ["claude", "codex", "pi", "agy"];
export type Policy = "read-only" | "workspace-write";
export interface Step {
  id: string;
  agent: Agent;
  model?: string;
  prompt: string;
  cwd: string;
  dependsOn: string[];
  policy: Policy;
  timeoutSeconds: number;
  readyTimeoutSeconds: number;
  worktree?: boolean;
  // Write in an ancestor write step's worktree instead of a new one (a fix after a review).
  workspace?: string;
  // Run only when each named dependency's result has these field values; otherwise "skipped".
  when?: Record<string, Record<string, Scalar>>;
  // A done report must carry these values, or the step ends blocked (the last review round).
  expect?: Record<string, Scalar>;
}
export type Scalar = string | number | boolean;
export interface Workflow {
  version: 1;
  name: string;
  concurrency: number;
  prefixWarmupMs?: number;
  steps: Step[];
}
export type StepStatus = "pending" | "dispatching" | "launching" | "starting" | "running" | "done" | "failed" | "blocked" | "uncertain" | "cancelled" | "skipped";
export interface StepState {
  status: StepStatus;
  token: string;
  session: string;
  actor?: string;
  cwd?: string;
  startedAt?: number;
  result?: Record<string, unknown>;
  error?: string;
  uncertainty?: "dispatch" | "launch" | "worker";
  finishedAt?: number;
  acceptedAt?: number;
  // Last time the worker was seen waiting on a user prompt; readiness restarts from here.
  promptAt?: number;
  prefixGroup?: string;
  contextBytes?: number;
  dependencyBytes?: number;
  fullDependencyBytes?: number;
}
export interface Run {
  version: 1 | 2;
  id: string;
  channel: string;
  dir: string;
  socket: string;
  workflow: Workflow;
  createdAt: number;
  status: "running" | "done" | "blocked" | "cancelled";
  steps: Record<string, StepState>;
}
export interface TaskEvent {
  type: "sflow.task";
  version: 1;
  runId: string;
  stepId: string;
  prompt: string;
  workspace: string;
  dependencies: Record<string, Record<string, unknown>>;
  dependencyManifest?: { path: string; sha256: string; count: number };
}
export interface WorkerEvent {
  type: "sflow.worker";
  version: 1;
  runId: string;
  stepId: string;
  proof: string;
  actor: string;
  status: "accepted" | "done" | "failed" | "blocked";
  result?: Record<string, unknown>;
}
export interface Message {
  seq: number;
  from: string;
  body: string;
  ts?: string;
}
export interface SessionRuntime {
  create(run: Run, step: Step): Promise<void>;
  exists(run: Run, stepId: string): Promise<boolean>;
  stop(run: Run, stepId: string): Promise<void>;
  // The menu the worker's TUI shows the user (trust, approval, login), if any.
  waitingOnPrompt?(run: Run, stepId: string): Promise<{ id: string; question: string[]; options: string[] } | null>;
  // A line from the worker's screen that explains why it has not accepted, if one is recognisable.
  diagnose?(run: Run, stepId: string): Promise<string | null>;
}
export interface Transport {
  read(channel: string, as: string): Promise<Message[]>;
  send(channel: string, body: unknown, as: string): Promise<void>;
  whoami(agent?: Agent, scope?: { runId: string; stepId: string }): Promise<string>;
}
