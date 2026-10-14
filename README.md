# Session Flow

English | [简体中文](README.zh-CN.md)

https://github.com/user-attachments/assets/5f564a03-848a-4a9e-bbf3-ac68cea78efd

The middle of the video is a real run of [examples/smoke.json](examples/smoke.json), captured from its tmux panes.

Run a workflow across independent Claude Code and Codex sessions. Each step selects its agent and model; OCS carries assignments and explicit results. The first runtime adapter creates native TUIs in private tmux sessions on macOS/Linux.

No orcr, Herdr, API proxy, or copied OCS internals. Native CLIs use their own authenticated accounts.

## Install

GitHub Release binaries are installed with:

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | sh
```

To build from source instead:

```sh
bun install
bun run build
bun run bench:context
./dist/sflow help
```

Install and authenticate `claude` and `codex`, and install `tmux` and [OCS](https://github.com/leeguooooo/open-cross-session) 0.8.0 or newer. Only the agents named in your workflow are required. tmux hosts each step's native TUI in a private session, which is what makes `attach`, `logs`, Ctrl-C without stopping workers, and `resume` possible. `sflow run` checks every dependency before creating anything and lists what is missing with install commands. Install tmux with `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu); `SFLOW_TMUX_BIN` and `SFLOW_OCS_BIN` point at binaries outside `PATH`. Windows is not supported yet (WSL works). This MVP works with released OCS 0.8.0 and does not require the newer send/dm JSON or whoami threadId additions. There is no npm registry distribution.

## Run

```sh
sflow validate workflow.json
sflow run workflow.json
# The first output prints a runId. In another terminal:
sflow status <run-id>
sflow stats <run-id>
sflow result <run-id> <step-id>
sflow logs <run-id> <step-id>
sflow attach <run-id> <step-id>
```

```json
{
  "version": 1,
  "name": "review-change",
  "concurrency": 2,
  "steps": [
    {
      "id": "plan",
      "agent": "claude",
      "model": "sonnet",
      "cwd": ".",
      "prompt": "Inspect the code and propose a small change with acceptance criteria."
    },
    {
      "id": "implement",
      "agent": "codex",
      "cwd": ".",
      "policy": "workspace-write",
      "worktree": true,
      "dependsOn": ["plan"],
      "prompt": "Implement the plan in your isolated workspace. Run relevant checks. Report the workspace path, changed files and check results; leave the diff for review."
    },
    {
      "id": "review",
      "agent": "claude",
      "cwd": ".",
      "dependsOn": ["implement"],
      "prompt": "Inspect the implementation workspace and actual diff referenced by the dependency report. Verify the acceptance criteria. Report findings; do not merge or edit."
    }
  ]
}
```

`model` is optional: omit it to use that CLI's configured default, or name a model your account supports. Relative `cwd` paths resolve from the workflow file. `dependsOn` creates a DAG; independent ready steps run concurrently. Default policy is `read-only`; writing requires `worktree: true` and a Git repository with an existing commit. Default execution timeout is 1800 seconds, readiness timeout 90 seconds (`timeoutSeconds` / `readyTimeoutSeconds`).

The synthetic [examples/smoke.json](examples/smoke.json) exercises Claude planning, Claude/Codex parallel workers, and a Codex join without modifying project files.

## Less traffic and repeated context

Workers report acceptance and one terminal result through machine-readable OCS
events with no wake. They do not chat acknowledgements or routine progress back
and forth. The driver advances dependencies; models do not negotiate scheduling.

Read-only steps share one protocol working directory and tool set within a run;
approved protocol commands and capabilities remain scoped to each step.
Optional `prefixWarmupMs` (0 by default, at most 5000) lets matching agent/model
groups wait for the first worker to accept or for that timeout before launching
a sibling. Enable it only after measuring whether it helps your workload.
This makes prefix reuse possible;
cache hits still depend on the native CLI and provider. Different models are not
grouped, and write steps retain separate worktrees. Shared Claude workers must be
addressed by exact session IDs if you message them, since their workspace alias
is ambiguous.

New runs store complete results in immutable, content-addressed private files. OCS and run snapshots
carry status, summary and SHA-256 references. The driver checks the file/hash
before accepting completion. Small dependency results stay inline; larger ones
use references, and wide fan-in uses one manifest. A reviewer must inspect full
results and artifacts before reaching a conclusion. `status` prints summaries;
`result` reads one complete verified report on demand.

`stats` reports message counts and bytes forwarded as task/dependency context.
These are local traffic measurements, not billed tokens or proof of cache hits.
Run records now use version 2; version 1 runs remain readable and keep inline
report semantics when a worker helper is upgraded. Old CLIs refuse version 2
records instead of misreading referenced results.

## Trust, approvals, and recovery

New native sessions can prompt for directory trust, login, or tool approval. Open the indicated worker with `attach` and handle the prompt. Standard approvals remain enabled; this version does not promise unattended execution. For Claude, read-only forbids file-edit tools but shell actions still use native permission gates. Codex review workers can write protocol/results and OCS messages, while the reviewed repository stays outside their sandbox write roots.

Ctrl-C stops the driver and leaves workers available. Keep the printed run ID:

```sh
sflow resume <run-id>
sflow stop <run-id>
```

Resume reconciles OCS reports before progressing. An uncertain send or worker creation is never retried automatically. A readiness timeout can leave a worker waiting for human intervention; handle the prompt, then resume. Terminal failure/blocked reports are final for that run. Use a new run for an intentional retry.

Only explicit `done` reports advance dependencies. A report is an agent's claim, so review its actual diff and checks. Finished sessions are archived and closed; `logs` reads the retained archive. Worktrees stay on disk for inspection and manual commit/merge. The runner does not automatically commit or merge them.

Run records live at `~/.local/state/session-flow/runs/<id>` (`SFLOW_HOME` overrides this); OCS messages use one `sflow-<id>` channel per run. These records may contain private task text. Keep them out of git. All workers share your OS account; the protocol does not defend against malicious same-user processes.

## Development

```sh
bun test
bun run check
bun run build
```

[DESIGN.md](DESIGN.md) describes ownership, failure semantics, protocol, and MVP limits. Runtime adapters are replaceable; this release implements only tmux and Claude/Codex TUIs.
