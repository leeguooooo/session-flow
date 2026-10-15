# Session Flow

English | [简体中文](README.zh-CN.md)

https://github.com/user-attachments/assets/5f564a03-848a-4a9e-bbf3-ac68cea78efd

The middle of the video is a real run of [examples/smoke.json](examples/smoke.json), captured from its tmux panes.

Run a workflow across independent Claude Code, Codex, Pi and Antigravity CLI (`agy`) sessions. Each step selects its agent and model; OCS carries assignments and explicit results. The first runtime adapter creates native TUIs in private tmux sessions on macOS/Linux.

No orcr, Herdr, API proxy, or copied OCS internals. Native CLIs use their own authenticated accounts.

## Install

GitHub Release binaries are installed with:

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | sh
```

The installer also installs the `sflow` skill for Claude Code, Codex, Pi and agy (`~/.gemini/config/skills`), so you can ask an agent to write and run a workflow (`/sflow` in Claude Code, `/skill:sflow` in Pi). The skill is embedded in the binary; `sflow skill install` reinstalls it, and `SFLOW_INSTALL_SKILLS=0` skips it. `sflow upgrade` installs the latest release and refreshes the skill (`--check` only looks); other commands print one line on stderr, at most daily, when a newer release exists (`SFLOW_NO_UPDATE_CHECK=1` turns that off). It is also in the [use-family](https://github.com/leeguooooo/plugins) Claude Code plugins: `/plugin install sflow@leeguooooo-plugins`.

To build from source instead:

```sh
bun install
bun run build
bun run bench:context
./dist/sflow help
```

Install and authenticate the agent CLIs your workflow uses (`claude`, `codex`, `pi`, `agy`), and install `tmux` and [OCS](https://github.com/leeguooooo/open-cross-session) 0.8.0 or newer. Only the agents named in your workflow are required. tmux hosts each step's native TUI in a private session, which is what makes `attach`, `logs`, Ctrl-C without stopping workers, and `resume` possible. `sflow run` checks every dependency before creating anything and lists what is missing with install commands. Install tmux with `brew install tmux` (macOS) or `sudo apt install tmux` (Debian/Ubuntu); `SFLOW_TMUX_BIN` and `SFLOW_OCS_BIN` point at binaries outside `PATH`. Windows is not supported yet (WSL works). This MVP works with released OCS 0.8.0 and does not require the newer send/dm JSON or whoami threadId additions. There is no npm registry distribution.

## User templates and defaults

Save a team workflow once, then supply only the task:

```sh
sflow template create my-dev --from builtin:dev --project
sflow template use project:my-dev --project
sflow config set --project --role implement=codex --model review=sonnet
sflow start --task "Add a login screen" --write --dry-run --json
sflow start --task "Add a login screen" --write
```

There is no implicit default: until you run `template use`, `start` needs `--template <name>` (for example `--template builtin:dev`) and lists the available templates when it is missing. Templates support arbitrary workflow DAGs, per-role models/instructions, typed task parameters and bounded review/fix rounds. Explicit CLI fields override project defaults, then global defaults, then template fields. `start` shows each field's source; writing still requires `--write` for that task. Existing `init` and `run workflow.json` ignore defaults. See [the complete template guide](docs/templates.md) for management, scope resolution, import/export, parameter rules, skill use and frozen run snapshots.

## Run

```sh
sflow doctor                         # tmux, ocs, agent CLIs and their sign-in; no model calls
sflow init implement-review --write --task "Add a --verbose flag"   # or write workflow.json yourself
sflow run .sflow/implement-review.json
```

`sflow init` writes a plain workflow for a common shape: `review`, `implement-review`, `plan-implement-review`, `implement-review-fix` (these three need `--write`, since an agent changes code in a new git worktree), or `fan-out` (several agents in parallel, one joins). `implement-review-fix --rounds N` (default 2) reviews the change; on a `needs-fix` verdict the implementer fixes it in the same worktree and it is reviewed again, at most N times. Rounds that are not needed show as `skipped`; a last review that still says `needs-fix` ends the run `blocked` for you to decide. It prints the agents, directories, dependencies and write policy; edit the file or pass `--implement`/`--review`/`--agents` to change agents. Anything else is a hand-written workflow (below); in an agent conversation, the `sflow` skill writes it from your description.

While it runs, `sflow run` prints each step's observed changes (starting, accepted, done, blocked) and a reminder after two quiet minutes. When a worker shows a trust, login or approval prompt, the question and numbered options appear in the same terminal: type a number and Enter to answer. At the end it prints a review: per step what the worker reported (marked as not verified), what sflow saw in each worktree with git, and what is left to do. Progress goes to stderr; stdout keeps the JSON it always had (run ID first, final state last). `--progress json` prints NDJSON events instead, `--progress none` nothing.

From another terminal or an agent:

```sh
sflow runs [--cwd <dir>] [--json]    # recent runs, newest first, to find a run id
sflow status <run-id>                # JSON; a waiting prompt appears on its step
sflow answer <run-id> <step-id> <prompt-id> <n>
sflow review <run-id> [--json]
sflow result <run-id> <step-id>
sflow logs <run-id> <step-id>
sflow attach <run-id> <step-id>
sflow stats <run-id>
```

Any `<run-id>` may be an unambiguous prefix (`sflow status 8f75`); several matches are listed, never guessed between.

A real change from start to finish, with worktree review and recovery: [docs/dev-workflow.md](docs/dev-workflow.md).

A hand-written workflow looks like this:

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

`model` is optional: omit it to use that CLI's configured default, or name a model your account supports. Relative `cwd` paths resolve from the workflow file. `dependsOn` creates a DAG; independent ready steps run concurrently. Default policy is `read-only`; writing defaults to `worktree: true` (or opts into `inPlace: true`, described below) and a Git repository with an existing commit, or `"workspace": "<step>"` to keep working in an earlier write step's worktree (that step must be one of its dependencies; two steps writing in one worktree must be ordered). `"when": {"<dependency>": {"details.verdict": "needs-fix"}}` runs a step only if that dependency's result has those values, otherwise it is `skipped` (which counts as finished for later steps); a result that lacks the field stops the step instead of guessing. `"expect": {"details.verdict": "pass"}` turns a `done` report without those values into `blocked`. Workers set such fields with `report done '<summary>' --detail verdict=pass`. Default execution timeout is 1800 seconds, readiness timeout 90 seconds (`timeoutSeconds` / `readyTimeoutSeconds`).

The synthetic [examples/smoke.json](examples/smoke.json) exercises Claude planning, Claude/Codex parallel workers, and a Codex join without modifying project files. [examples/mixed.json](examples/mixed.json) runs the same graph on four agents: Pi plans, agy and Claude work in parallel, Codex joins.

### Agents

`agent` is `claude`, `codex`, `pi` or `agy`. Each runs as its own native TUI; what differs is how a step is confined and how its report is attributed:

| agent | read-only step | approvals | who may report |
|---|---|---|---|
| `claude` | file-edit tools disabled; only this step's wrappers (or its declared reuse chain) are pre-approved | native Claude prompts | the Claude session (`claude-…`) |
| `codex` | project outside the sandbox write roots | `on-request` | the full Codex thread (`codex-<thread id>`) |
| `pi` | `edit` and `write` tools removed; **bash stays available** (Pi has no per-tool approvals) | none | the Pi session (`pi-<session id>`), which needs the OCS Pi extension (`ocs doctor --fix`) |
| `agy` | instruction plus agy's approvals | agy asks before each command; answer with `sflow attach` | bound to the step (`agy-<run>-<step>`): agy has no per-session identity in OCS, so its report rests on the step's capability alone |

Session Flow starts agy as an interactive TUI it owns. This is separate from OCS's optional `ocs agy start` receiver, which serves `ocs dm agy` with headless runs; the two do not share conversations. Hermes is not supported as a worker.

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
grouped, and write steps use isolated worktrees by default. Shared Claude workers must be
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

New native sessions can prompt for directory trust, login, or tool approval. sflow never answers one itself. You answer in the `sflow run` terminal by typing the option number, or the agent driving the run asks you in its conversation and passes your choice with `sflow answer <run-id> <step-id> <prompt-id> <n>` (the prompt id comes from `sflow status`); either way the answer is sent only if the screen still shows the exact prompt you saw. `sflow attach` still works. While a prompt is on screen the readiness timeout waits (up to the step timeout) and restarts once it is answered; if the driver already stopped, `sflow resume` gives a still-open worker a fresh readiness window. When a worker does not accept in time, the error quotes what its screen shows (a backend or sign-in error, for example) or says the cause is unknown; it only mentions a prompt when one is on screen.

Read-only Claude steps start in one empty folder sflow owns, `~/.local/state/session-flow/workspaces/claude`, so Claude asks to trust it once per machine instead of once per run. That trust covers only this folder, which holds no project code; run files are passed by absolute path. Write steps start in a new worktree, so Claude or Codex asks about that folder (Codex applies the trust to the repository root). Standard approvals remain enabled; this version does not promise unattended execution. For Claude, read-only forbids file-edit tools but shell actions still use native permission gates. Pi read-only steps cannot edit or write files through Pi's tools but can still run shell commands. agy asks before every command; approve its wrapper with "always allow in this conversation" to avoid a second prompt for the report. Codex review workers can write protocol/results and OCS messages, while the reviewed repository stays outside their sandbox write roots.

Ctrl-C stops the driver and leaves workers available. Keep the printed run ID:

```sh
sflow resume <run-id>
sflow stop <run-id>
```

Resume reconciles OCS reports before progressing. An uncertain send or worker creation is never retried automatically. A readiness timeout can leave a worker waiting for human intervention; handle the prompt, then resume. Terminal failure/blocked reports are final for that run. Use a new run for an intentional retry.

Only explicit `done` reports advance dependencies. A report is an agent's claim, so review its actual diff and checks. Finished sessions are archived and closed once no declared later round needs them; `logs` reads the retained archive. Worktrees stay on disk for inspection and manual commit/merge. The runner does not automatically commit or merge them.

Run records live at `~/.local/state/session-flow/runs/<id>` (`SFLOW_HOME` overrides this); OCS messages use one `sflow-<id>` channel per run. These records may contain private task text. Keep them out of git. All workers share your OS account; the protocol does not defend against malicious same-user processes.

## Other machines

Steps can run on other computers you reach with ssh. Each one needs sflow
installed and non-interactive ssh from the driving machine (`ssh -o BatchMode=yes
<target> true` must work); how the network gets there (LAN, VPN, Tailscale, a
jump host in `~/.ssh/config`) is up to you.

```sh
sflow hosts add box --ssh leo@192.168.0.190 --site office
sflow hosts add mini --ssh macmini --site home --slots 1
sflow hosts install box               # runs the release installer there (--from <binary> copies one)
sflow hosts check                     # sflow version, tools, load, free disk, slots in use
```

Then give a step `"host": "box"`, a list of names, or `"any"`. Builds and tests
are command steps: sflow runs the argv itself and records exit code, log and
artifacts, no agent involved.

```json
{ "id": "test", "agent": "command", "host": "any", "cwd": ".", "dependsOn": ["implement"],
  "workspace": "implement", "command": ["bun", "test"], "artifacts": ["coverage/summary.txt"] }
```

- The host gets a frozen copy of the files: tracked and untracked, non-ignored
  ones, including uncommitted edits. Ignored files and submodules are not sent;
  Git LFS files arrive as pointers. Your repository's HEAD, index and object store
  are never written; sflow never pushes to `origin`.
- A host is used only while its load per core is under `--max-load` (default
  0.8) and its free disk over `--min-free-gb` (default 5). `--slots` (default 2)
  caps concurrent steps there, shared by everyone driving that host.
- A step with a host never falls back to this machine. If the host stops
  answering after the job started, the step becomes `uncertain`; it is never
  started again or moved elsewhere.
- Agent steps can have a host too. The native session runs there (its CLI must be
  installed and signed in on that machine, plus tmux and ocs); `status`, `logs`,
  `answer` and `attach` work the same. A write step's changes come back as
  uncommitted edits in a local worktree, exactly like a local write step.
  `inPlace` steps stay local; `workspace` and `reuseSession` chains stay on one host.
- The hosts a workflow names are copied into the run when it starts, so editing
  `hosts.json` does not change a running or resumed run.
- `sflow hosts gc [--days 7]` deletes finished command jobs on the hosts.

GUI work, screenshots, signing with your keychain, or anything using this
machine's screen or browser profiles must not get a host.

## Development

```sh
bun test
bun run check
bun run build
```

[DESIGN.md](DESIGN.md) describes ownership, failure semantics, protocol, and MVP limits. Runtime adapters are replaceable; this release implements tmux with Claude, Codex, Pi and agy TUIs.

## Write in the project and retain a worker

Both options are opt-in. For implementation, review and repair in your checkout:

```sh
sflow init implement-review-fix --task "fix the bug" --cwd /path/to/project \
  --write --in-place --reuse-sessions --rounds 2
```

`--in-place` requires `--write` and names the Git checkout root to modify in the
printed plan. It never resets/stashes/cleans the checkout. The generated write
step uses `inPlace: true` instead of `worktree: true`; `workspace` repair steps
inherit it. All readers and writers on that checkout must be dependency ordered.
`sflow start --template dev --write --in-place --task "…"` also supports direct
writes. A template containing inPlace still needs both flags on every start.
A saved JSON workflow explicitly containing inPlace authorizes `sflow run`.

`sflow review` shows a delta between private before/after snapshots, excluding
pre-existing staged, unstaged and non-ignored untracked edits. It provides a
patch path and the snapshots; worker assignments include `workspaceObservation`
so reviewers can inspect the same baseline. Changed HEAD/index, changes during
read-only review, or changes between steps block progression. Ignored files are
excluded; submodules are rejected. Concurrent outside writes during a write
step cannot be distinguished from worker writes, and every summary says so.

`--reuse-sessions` on this init preset retains the implementer's native TUI for
fix rounds. Hand-written workflows and templates use `reuseSession: "<ancestor>"`.
The ancestor must have reported done; agent/model/policy/workspace must match,
and rounds must be ordered. Claude, Codex and Pi support this; agy has no native
session identity and is rejected. Each round keeps a distinct token and result.
An uncertain continuation is never resent, even if its TUI is still alive.
Retained sessions occupy concurrency slots: use at least 2 for an implementer
waiting on a separate reviewer. `status` records active/retained/closed lifecycle
separately from step completion. Cancellation and final completion close owned
sessions and retain artifacts.
