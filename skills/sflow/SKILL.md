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
names. `sflow doctor [workflow.json]` checks them, plus Claude/Codex sign-in
and the OCS Pi extension, without calling a model; show the user any `FAIL`
line and its fix. `sflow run` repeats the essential checks before creating
anything. macOS/Linux only (WSL works).

## Use a saved/default template

For `/sflow <task>` or an explicit request to run a development/review workflow, prefer the user's template defaults. Do not launch paid workers for ordinary questions, brainstorming, or a request only to explain the product. A worker must follow its assignment instead and must never enter this driver flow.

```sh
sflow config show --cwd <project> --json
sflow template list --cwd <project>
sflow start --task "<task>" --cwd <project> --dry-run --json
```

Use `--template <name>` when requested. Writing templates need `--write` even for dry-run: add it only when the user explicitly asked for code changes (that request authorizes implementing, but not commit/merge). If no default is configured and the user did not name a template, ask which template to use (you can recommend dev/review/investigate based on the task). Explain that template use can save their choice as a project/global default, but never write config without their instruction. Do not choose a fallback template yourself. Never silently grant writes to a default.

Show the resolved template, role agents/models, source paths and whether it writes code. On the first use of repository-sourced templates/config in a project, show that summary before execution. Existing task authorization is sufficient to run the displayed plan; do not ask a redundant permission question. Resolve missing required inputs with the user. Then repeat the same start command without `--dry-run --json`, keeping all overrides and the authorized `--write`. Native approvals still follow the user-choice procedure below.

`template create <name> --from builtin:dev --project` saves a customizable workflow. Edit its roles/models/instructions/parameters/DAG; `template use project:<name> --project` makes it the project default. Global preferences use --global. `config set --role implement=codex --model review=sonnet --param rounds=2` saves overrides; `config show` and dry-run show sources. Fields resolve CLI > project > global > template. Explicit scope prefixes select a particular template; list marks shadowed names.

Use `template show --json` to export, `create --from <file>` to import, `validate` for structure and start dry-run for actual expansion. Params can be supplied with repeated --param or --params-file. Only prompts/instructions substitute placeholders, once. See docs/templates.md for schema and management. run/init workflows below remain compatible and ignore new defaults.

The current conversation's agent remains the main controller (clarification, approvals, actual diff/test acceptance). Template plan/lead/join roles are task steps, never another dispatcher. Run snapshots freeze the resolved workflow and origin; changing defaults must not change a resume.

## Write the workflow

For a common shape, let sflow write it and show the user the plan it prints:

```sh
sflow init review --task "<what to look at>" --cwd <project>
sflow init implement-review --write --task "<the change>" --cwd <project>
sflow init plan-implement-review --write --task "<the change>" --cwd <project>
sflow init implement-review-fix --write --rounds 2 --task "<the change>" --cwd <project>
sflow init fan-out --task "<question>" --agents claude,codex,pi --cwd <project>
```

Agents default to Codex implementing and Claude planning/reviewing; change them
with `--plan`, `--implement`, `--review`, `--join`. `--write` lets an agent
change code in a new git worktree; add it only when the user asked for a code
change, and say so. `implement-review-fix` loops review → fix (same worktree) →
review up to `--rounds` times; unneeded rounds are `skipped` (normal, not stuck),
and a last review still saying `needs-fix` ends the run `blocked` for the user. The file lands in `.sflow/<preset>.json` (or `--out`).

Otherwise write the JSON from the user's description:

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
- `policy` defaults to `read-only`. Writing needs `"policy": "workspace-write"` plus `"worktree": true` in a Git repo with at least one commit, or `"workspace": "<step>"` to continue in an earlier write step's worktree (it must be a dependency). Worktrees are never committed or merged for you.
- `"when": {"<dep>": {"details.verdict": "needs-fix"}}` runs a step only on those result values, else it is `skipped`; a missing field blocks it. `"expect": {"details.verdict": "pass"}` blocks a `done` report without those values. Tell the worker the exact field, e.g. `report done '<summary>' --detail verdict=pass`.
- `timeoutSeconds` (default 1800) and `readyTimeoutSeconds` (default 90) per step.
- Each prompt must be self-contained: say what to inspect, what to produce and what "done" means. Dependency results are passed to the next step automatically.

Save it under the project (for example `.sflow/<name>.json`), then:

```sh
sflow validate workflow.json
```

## Run it

`sflow run` stays in the foreground until the workflow finishes, which can take
many minutes. Start it in the background. stdout is JSON (the run ID first, the
final state last); stderr is a readable progress log and the closing review:

```sh
sflow run workflow.json > /tmp/sflow-<name>.json 2> /tmp/sflow-<name>.log &
head -n 4 /tmp/sflow-<name>.json     # {"runId": "...", "channel": "sflow-..."}
tail -n 20 /tmp/sflow-<name>.log     # what has happened so far
```

(In Claude Code, prefer the Bash tool's background mode.) A run started from a
terminal by the user accepts typed answers to prompts; one you start in the
background does not, so answer through `sflow answer` as below. Then watch it:

```sh
sflow runs [--cwd <project>]         # recent runs, newest first, when the run id is lost
sflow status <run-id>                # per-step status and short summaries
sflow result <run-id> <step-id>      # one complete, hash-verified result
sflow logs <run-id> <step-id>        # what that worker's terminal shows now
sflow answer <run-id> <step-id> <prompt-id> <n>   # pick option n of a waiting prompt (after the user chose)
sflow stats <run-id>                 # message counts and forwarded bytes
sflow review <run-id>                # per step: what was reported, what sflow saw in worktrees, what is left
```

Any `<run-id>` may be an unambiguous prefix; if several runs match, the error lists them: ask
the user which one rather than picking. Poll `status` at a sensible interval (a minute or more), not in a tight loop.

## When a step is stuck

New sessions can stop at a folder-trust prompt or a login, and running ones at
a tool approval (Claude asks before shell commands, agy before every command).
`sflow status` shows it on that step as `prompt`: the question, the options in
the TUI's own words, and an `id`; the progress log prints the same. Check about
15 seconds after starting, then each time you poll. While a prompt is on screen
the run waits for it (up to the step's `timeoutSeconds`). A step that reports
"no acceptance within …" quotes what its screen showed, or says the cause is
unknown; do not guess a reason it does not give.

Read-only Claude steps start in `~/.local/state/session-flow/workspaces/claude`,
so the Claude folder-trust question comes once per machine. Codex asks to trust
a repository the first time it works in one of its worktrees.

The choice belongs to the user, but they answer in this conversation:

1. Show the step, the question and the numbered options exactly as `prompt`
   gives them. Say what the choice does (for example "trusts this run's
   protocol folder" or "lets agy run `ls` for the rest of its conversation").
2. Wait for the user to pick. Do not choose for them, do not pre-select the
   "always allow" options, and do not treat silence as yes.
3. Run `sflow answer <run-id> <step-id> <prompt-id> <n>`. It refuses if the
   screen now shows a different prompt; show the new one and ask again. Its
   output names any follow-up prompt; if it says the screen still shows the
   answered prompt, check `sflow status` before asking again.

The user can still answer directly with `sflow attach <run-id> <step-id>`.
Never add bypass flags.

- Ctrl-C or a killed driver leaves workers running: `sflow resume <run-id>`.
- After a readiness timeout, deal with what the error names, then `sflow resume <run-id>`; a still-open worker gets a fresh readiness window and its prompt shows again.
- `sflow stop <run-id>` stops this run's workers and keeps their records.
- A `failed` or `blocked` report is final for that run. Retry with a new run; sflow never resends an uncertain assignment by itself.

## Reporting back

A `done` report is the worker's claim, not proof. Start from `sflow review
<run-id>`: it lists each step's reported summary and checks (marked as not
rerun), the files sflow saw change in each worktree, and what is left to do.
Before telling the user the work is finished, read the full results
(`sflow result`) and, for write steps, run `git -C <worktree> diff` and the
checks yourself. Changes stay uncommitted in the worktree; commit, merge or
remove it only when the user asks (docs/dev-workflow.md in the repo shows how). Name the run ID, which
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
