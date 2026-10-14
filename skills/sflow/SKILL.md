---
name: sflow
description: Run a multi-step workflow across separate Claude Code, Codex, Pi and Antigravity (agy) sessions with Session Flow (`sflow`). Use when the user wants several agents to plan, implement, review or check work in parallel or in sequence, wants a JSON workflow written or run, or asks about an sflow run's status, results, logs or a stuck step.
---

# Session Flow (`sflow`)

Session Flow starts each workflow step in its own native agent TUI (in a private
tmux session), sends the assignment over OCS and advances the dependency graph
only on an explicit `done` report. You write the workflow and drive the run; the
workers do the steps.

If you were started *as a worker* (your prompt contains a Session Flow
assignment and tells you to run `sflow task` / `sflow report`), follow that
assignment instead of this skill. Never start a new run from inside a worker.

## Setup

```sh
sflow version || curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | sh
```

`sflow run` needs tmux, OCS 0.8.0+ and the CLIs of the agents the workflow
names. It checks all of them before creating anything and prints install
commands for whatever is missing. Pi workers also need the OCS Pi extension
(`ocs doctor --fix`). macOS/Linux only (WSL works).

## Write the workflow

```json
{
  "version": 1,
  "name": "review-change",
  "concurrency": 2,
  "steps": [
    { "id": "plan", "agent": "claude", "cwd": ".",
      "prompt": "Inspect the code and propose a small change with acceptance criteria." },
    { "id": "implement", "agent": "codex", "cwd": ".", "dependsOn": ["plan"],
      "policy": "workspace-write", "worktree": true,
      "prompt": "Implement the plan in your isolated workspace, run the relevant checks, and report the workspace path, changed files and check results." },
    { "id": "review", "agent": "claude", "cwd": ".", "dependsOn": ["implement"],
      "prompt": "Inspect the implementation workspace and its actual diff. Verify the acceptance criteria. Report findings; do not edit." }
  ]
}
```

- `name` and step `id`: lowercase letters, digits and `-`, starting with a letter.
- `agent`: `claude`, `codex`, `pi` or `agy`. `model` is optional (the CLI's default otherwise).
- `cwd` is required; relative paths resolve from the workflow file.
- `dependsOn` forms a DAG; ready steps run in parallel up to `concurrency` (default 2).
- `policy` defaults to `read-only`. Writing needs `"policy": "workspace-write"` plus `"worktree": true` in a Git repo with at least one commit. Worktrees are never committed or merged for you.
- `timeoutSeconds` (default 1800) and `readyTimeoutSeconds` (default 90) per step.
- Each prompt must be self-contained: say what to inspect, what to produce and what "done" means. Dependency results are passed to the next step automatically.

Save it under the project (for example `.sflow/<name>.json`), then:

```sh
sflow validate workflow.json
```

## Run it

`sflow run` stays in the foreground until the workflow finishes, which can take
many minutes. Start it in the background and keep its output, because the first
line prints the run ID:

```sh
sflow run workflow.json > /tmp/sflow-<name>.log 2>&1 &
head -n 5 /tmp/sflow-<name>.log      # {"runId": "...", "channel": "sflow-..."}
```

(In Claude Code, prefer the Bash tool's background mode.) Then watch it:

```sh
sflow status <run-id>                # per-step status and short summaries
sflow result <run-id> <step-id>      # one complete, hash-verified result
sflow logs <run-id> <step-id>        # what that worker's terminal shows now
sflow answer <run-id> <step-id> <prompt-id> <n>   # pick option n of a waiting prompt (after the user chose)
sflow stats <run-id>                 # message counts and forwarded bytes
```

Poll `status` at a sensible interval (a minute or more), not in a tight loop.

## When a step is stuck

New sessions can stop at a folder-trust prompt, a login, or a tool approval
(agy asks before every command). `sflow status` shows it on that step as
`prompt`: the question, the options in the TUI's own words, and an `id`. Check
`status` about 15 seconds after starting and again while steps are launching;
a prompt left unanswered past `readyTimeoutSeconds` (default 90) stops the run
until `sflow resume`.

The choice belongs to the user, but they answer in this conversation:

1. Show the step, the question and the numbered options exactly as `prompt`
   gives them. Say what the choice does (for example "trusts this run's
   protocol folder" or "lets agy run `ls` for the rest of its conversation").
2. Wait for the user to pick. Do not choose for them, do not pre-select the
   "always allow" options, and do not treat silence as yes.
3. Run `sflow answer <run-id> <step-id> <prompt-id> <n>`. It refuses if the
   screen now shows a different prompt; show the new one and ask again. Its
   output names any follow-up prompt.

The user can still answer directly with `sflow attach <run-id> <step-id>`.
Never add bypass flags.

- Ctrl-C or a killed driver leaves workers running: `sflow resume <run-id>`.
- After a readiness timeout, answer the prompt as above, then `sflow resume <run-id>`.
- `sflow stop <run-id>` stops this run's workers and keeps their records.
- A `failed` or `blocked` report is final for that run. Retry with a new run; sflow never resends an uncertain assignment by itself.

## Reporting back

A `done` report is the worker's claim, not proof. Before telling the user the
work is finished, read the full results (`sflow result`) and, for write steps,
inspect the worktree diff and check output yourself. Name the run ID, which
agent did each step, and anything still waiting for the user.

Run records live in `~/.local/state/session-flow/runs/<id>` and may contain
private task text; keep them out of git.

## Upgrade

When any `sflow` command prints `sflow X is available`, tell the user and offer
to run `sflow upgrade` (it updates the CLI and this skill). Check without
changing anything: `sflow upgrade --check`. The user may also just say
"升级 sflow" / "upgrade sflow".

If the skill came from somewhere `upgrade` can't refresh:
- Claude Code plugin: `claude plugin update sflow@leeguooooo-plugins`
- Whole family: `curl -fsSL https://raw.githubusercontent.com/leeguooooo/plugins/main/upgrade-use-family.sh | sh`
