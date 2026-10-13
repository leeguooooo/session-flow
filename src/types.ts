export type Agent = "claude" | "codex";
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
}
export interface Workflow {
  version: 1;
  name: string;
  concurrency: number;
  steps: Step[];
}
export type StepStatus = "pending" | "dispatching" | "launching" | "starting" | "running" | "done" | "failed" | "blocked" | "uncertain" | "cancelled";
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
}
export interface Run {
  version: 1;
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
}
export interface SessionRuntime {
  create(run: Run, step: Step): Promise<void>;
  exists(run: Run, stepId: string): Promise<boolean>;
  stop(run: Run, stepId: string): Promise<void>;
}
export interface Transport {
  read(channel: string, as: string): Promise<Message[]>;
  send(channel: string, body: unknown, as: string): Promise<void>;
  whoami(): Promise<string>;
}
