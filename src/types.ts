export type Agent = "claude" | "codex" | "pi" | "agy";
export const AGENTS: readonly Agent[] = ["claude", "codex", "pi", "agy"];
export type Policy = "read-only" | "workspace-write";
// "command" runs a frozen argv (a build or test) instead of a native agent session.
export type Runner = Agent | "command";
export interface Step {
  id: string;
  agent: Runner;
  model?: string;
  prompt: string;
  cwd: string;
  dependsOn: string[];
  policy: Policy;
  timeoutSeconds: number;
  readyTimeoutSeconds: number;
  worktree?: boolean;
  inPlace?: boolean;
  reuseSession?: string;
  // Write in an ancestor write step's worktree instead of a new one (a fix after a review).
  workspace?: string;
  // Run only when each named dependency's result has these field values; otherwise "skipped".
  when?: Record<string, Record<string, Scalar>>;
  // A done report must carry these values, or the step ends blocked (the last review round).
  expect?: Record<string, Scalar>;
  // Hosts (names from hosts.json, or "any") the step may run on; absent means this machine.
  host?: string[];
  command?: string[];
  artifacts?: string[];
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
  lifecycle?: "active" | "retained" | "closed";
  baseline?: string;
  observedEnd?: string;
  workspaceWarning?: string;
  contextBytes?: number;
  dependencyBytes?: number;
  fullDependencyBytes?: number;
  // The host this step was placed on (recorded before the host is asked to do anything).
  host?: string;
  // Paths on that host: its run directory, and the working directory of this step.
  remote?: { dir: string; cwd?: string; base?: string; materialized?: boolean; localTree?: string; pathMap?: Record<string, string> };
  job?: JobState;
}
export interface JobState {
  id: string;
  phase: "placing" | "sending" | "starting" | "running" | "exited" | "collected";
  commit?: string; tree?: string; head?: string; repo?: string; source?: string; cwd?: string;
  receipt?: Record<string, unknown>;
}
export interface HostConfig {
  ssh: string;
  bin: string;
  slots: number;
  maxLoad: number;
  minFreeGB: number;
  site?: string;
  tags?: string[];
}
export interface RunOrigin {
  template: string; scope: "project" | "global" | "builtin"; path: string; sha256: string;
  params: Record<string, Scalar>; roles: Record<string, { agent: Agent; model?: string; instructions?: string; sources: Record<string, string> }>;
}
export interface Run {
  version: 1 | 2 | 3 | 4;
  origin?: RunOrigin;
  id: string;
  channel: string;
  dir: string;
  socket: string;
  workflow: Workflow;
  createdAt: number;
  status: "running" | "done" | "blocked" | "cancelled";
  steps: Record<string, StepState>;
  // Hosts the workflow names, frozen at creation (record version 4).
  hosts?: Record<string, HostConfig>;
  // Set on a host's mirror of a run driven from another machine.
  mirror?: { driver: string };
}
export interface TaskEvent {
  type: "sflow.task";
  version: 1;
  runId: string;
  stepId: string;
  prompt: string;
  workspace: string;
  dependencies: Record<string, Record<string, unknown>>;
  workspaceObservation?: { baseline: string; dependencies: Record<string, { baseline: string; end?: string }>; warning: string };
  dependencyManifest?: { path: string; sha256: string; count: number };
  // On another host: driver paths named in dependencies and where their copies are here.
  pathMap?: Record<string, string>;
  // Dependency files too large to copy to that host; read them on the driver machine.
  evidenceNotCopied?: string[];
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
  // The host whose OCS channel this row came from; absent for this machine.
  host?: string;
}
export interface SessionRuntime {
  create(run: Run, step: Step): Promise<void>;
  continue?(run: Run, step: Step): Promise<void>;
  exists(run: Run, stepId: string): Promise<boolean>;
  stop(run: Run, stepId: string): Promise<void>;
  // The menu the worker's TUI shows the user (trust, approval, login), if any.
  waitingOnPrompt?(run: Run, stepId: string): Promise<{ id: string; question: string[]; options: string[] } | null>;
  // A line from the worker's screen that explains why it has not accepted, if one is recognisable.
  diagnose?(run: Run, stepId: string): Promise<string | null>;
  // Hosts and command steps (HostRouter). Absent on a plain local runtime.
  remoteStep?(run: Run, stepId: string): boolean;
  placeAgent?(run: Run, step: Step): Promise<{ ok: true } | { wait: string } | { error: string }>;
  sendTask?(run: Run, step: Step, task: TaskEvent): Promise<void>;
  remoteRows?(run: Run): Promise<Message[]>;
  materialize?(run: Run, step: Step): Promise<void>;
  startCommand?(run: Run, step: Step): Promise<{ ok: true } | { wait: string } | { error: string }>;
  pollCommand?(run: Run, step: Step): Promise<void>;
  finish?(run: Run): Promise<void>;
}
export interface Transport {
  read(channel: string, as: string): Promise<Message[]>;
  send(channel: string, body: unknown, as: string): Promise<void>;
  whoami(agent?: Agent, scope?: { runId: string; stepId: string }): Promise<string>;
}
