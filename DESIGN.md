# Session Flow 0.1

Session Flow creates independent coding-agent sessions and advances a workflow when their explicit reports arrive. OCS remains the communication layer. Neither project imports the other's source.

## Components

- `config.ts`: versioned JSON DAG; agent and model are independent fields. Unsupported agents fail validation. Model availability belongs to the native CLI/account.
- `runtime.ts`: first `SessionRuntime` adapter, using one private tmux socket per run. Agents remain interactive TUIs, not API calls. No Herdr/orcr dependency.
- `ocs.ts`: public `ocs send` and `ocs read --peek --since 0 --json`. Known channel names and structured message bodies avoid parsing human-readable send output. OCS send/dm JSON is useful but not required by this MVP.
- `engine.ts`: one durable driver, dependency and concurrency scheduling, explicit worker-result reconciliation.
- `worker.ts`: protocol wrapper for fetching an assignment and reporting acceptance/completion. Native OCS session identity and a per-step capability prevent accidental cross-step attribution.
- `preflight.ts`: before a run is created, checks tmux, OCS and every agent CLI the workflow names (found on `PATH` and answering its version command) and reports all failures together with install hints. Nothing is created when any check fails.

## Lifecycle

`pending → dispatching → launching → starting → running → done/failed/blocked`, or `pending → skipped` when a step's `when` does not hold.

Review → fix → review is unrolled into distinct steps (`review-1`, `fix-1`, `review-2`, …) gated by `when`, not a loop in the engine. Each round keeps its own token, proof and actor, so a late report from one round can never advance another, and the one-attempt, never-resend rules stay as they are. A skipped step counts as finished for its dependents and is shown to them as `{status: "skipped"}`. A `when` field the dependency did not report blocks the step rather than deciding either way; `expect` turns a `done` without the required values (the last review still saying `needs-fix`) into `blocked`, handing the decision to a person. `workspace: <step>` reuses an ancestor write step's worktree; validation requires every two writers of one worktree to be ordered by dependencies, which is the one-writer-at-a-time guarantee (no lock needed). The default remains a fresh session in an isolated worktree. The opt-in modes below also keep every round as a distinct step.

The driver persists dispatch intent before sending an assignment. After a crash it looks for exactly one matching task in OCS; it never blindly resends. Launch intent is durable before tmux creation. An existing session on this run's private socket is adopted; an absent session after uncertain creation is retained as `uncertain`, never recreated automatically.

Workers fetch their task from OCS using `sflow task`. Returning the task requires explicit acceptance to be stored first. They report a terminal result with `sflow report`. Idle, CLI exit code, process exit, and message delivery are not completion evidence. A successful report is the worker's claim; downstream review and the human/main agent remain responsible for artifact verification.

Coordination is quiet: one assignment, one acceptance and one terminal result per
step, all without waking another model. Complete results are immutable files;
signed result references are verified before completion. The driver stores the
reference instead of copying the report into every snapshot. Status queries show
summaries, and full results are explicit reads. New run record version 2 prevents
old drivers from interpreting file references as complete inline reports; legacy
version 1 runs keep their wire semantics when the helper is upgraded.

Read-only workers share `.protocol` as their native cwd and the same tool set;
per-step approved wrappers, tokens and result paths remain distinct. No shared
dispatcher lets a model select another step. A native session that accepted one
step cannot claim an unrelated step; declared reuse chains may accept a later round after explicit completion. Identical agent/model groups may opt into a bounded
prefix warmup hold with `prefixWarmupMs` (default 0, maximum 5000). This
does not prove a cache hit, and tool/account/model differences may prevent reuse.
Write workers stay isolated. Dependency context is inline only up to 1 KiB per
result and 4 KiB aggregate; larger fan-in is a SHA-256 manifest. The full evidence
remains available for verification. Byte/message metrics are not token billing.

Each step has one attempt. There is no automatic retry, model fallback, or reassignment. Use a new run for a deliberately repeated attempt after inspecting the original workers and outputs.

Dependency outputs are data, not instructions. Small results are inline; large results are referenced by private local file and SHA-256. No automatic cherry-pick, merge, or push. Write steps default to isolated worktrees (inPlace is explicit opt-in) and retain their diffs for the main agent to review and commit. Review steps receive artifact paths from preceding workers.

## Permissions and resource ownership

Every worker gets its own `TMPDIR`, `sflow-<run>-<step>` in the system temp
directory (never inside sflow's state, where a project may not be), added to
Codex's writable roots explicitly, so tests that create temp files run without a
sandbox approval; Codex otherwise excludes `/tmp` and the inherited TMPDIR. Tool caches outside the run (for example `~/.bun` during an
install) still ask once.

Review verdicts separate blocking problems from minor ones: `needs-fix` only for
wrong behaviour, a failing or missing check, data loss, a security hole or the
task not met; everything else is reported as `minor:` checks with a `pass`, so
repair rounds stop on what matters.

Read-only Claude workers start in one stable, empty directory owned by sflow (`$SFLOW_HOME/workspaces/claude`) instead of the per-run `.protocol`, and get the run directory through `--add-dir`. Claude records folder trust per directory, so a per-run cwd asked for trust on every run; a stable one asks once per machine, and the user still makes that choice. Other read-only agents keep `.protocol`: Codex's sandbox write roots are scoped to the run there. Write steps start in their new worktree, so the native trust question for that folder remains.

`sflow run` reports progress on stderr from what it observes (step status changes, menus on worker screens, a reminder after two quiet minutes) and never infers completion from a live process; stdout keeps the JSON contract. With a terminal on stdin, a typed option number answers the menu shown, after re-reading the screen and matching the prompt id. At the end, and through `sflow review`, it lists per step what the worker reported (resolved through the hash-checked result file, claims not rerun) and what sflow observed with git in each worktree, without prompts, tokens or transcripts. A readiness timeout records what the worker screen shows when it matches a known error pattern, otherwise "cause unknown"; on `resume`, a step blocked only by readiness whose session is still open returns to starting with a fresh window (same worker, no resend).

No global permission settings are changed, and no bypass flag is used. Native trust/login/approval prompts may require a human: `sflow logs` and `sflow attach` expose the owned session. `sflow status` parses a selection menu on a starting worker's visible screen into `prompt` (question, options, and an id hashed from both); `sflow answer` re-reads the screen, refuses when the id no longer matches, and sends only arrow keys and Enter, so the user can confirm in the driving agent's conversation. The runtime never chooses an option itself. While a menu is visible the readiness window stays open and restarts from the last sighting; the step timeout bounds the whole wait. A readiness timeout prints the `resume` command; after intervention, resuming reconciles reports before progressing.

Codex review workers run in a protocol directory with a workspace-write sandbox, with default `/tmp` writable exceptions disabled. The inspected project is outside the write roots; the protocol directory and OCS home are writable for reporting. The workflow rejects overlap with those roots. This is not the native `read-only` sandbox. Claude review workers deny file-edit tools and retain standard shell approvals; their read-only policy is an instruction plus permission gates, not a filesystem security boundary. Pi review workers lose Pi's `edit` and `write` tools, but Pi has no per-tool approvals, so bash remains unrestricted. agy workers keep agy's own approval prompts and receive the protocol, step and OCS directories via `--add-dir`.

Reports are attributed to the native session of the step's agent: `claude-<8 hex>`, `codex-<full thread id>`, `pi-<full session id>` (exported by the OCS Pi extension). The driver accepts an actor only if its shape matches the step's agent. agy has no per-session identity in OCS, so an agy actor is the fixed name `agy-<run id prefix>-<step id>`; its reports rest on the step's capability token alone, and the one-actor-one-step check cannot tell two agy sessions apart.

OCS and native auth/config stay in the user's account. Workers share that OS user. The run directory is private, but same-user processes can read it. Capabilities/proofs prevent accidental misrouting and corrupted reports, not a malicious same-user agent. No security isolation between workers is claimed. Workflow prompts and results must not contain credentials.

Per-step command scoping is enforced by Claude's allow rules. Codex's shell can
execute another step's wrapper as the same user; before its own first acceptance,
the one-actor-one-step check cannot bind it to the intended step. Workers must
follow their own bootstrap. This is a same-user trust boundary, not agent
authentication or protection against hostile project instructions.

The concurrency cap includes live blocked workers. Completed owned sessions are captured to `terminal.txt` before cleanup to release slots; worktrees and results are retained. Cancelling stops only sessions on this run's private socket. A crash during stale-lock recovery leaves a tombstone requiring inspection; fail closed rather than risk two drivers. Restart/OS cleanup may remove the tmux socket; absent workers become uncertain.

## MVP exclusions

No GUI, automatic branch/repair loop, cron, Desktop-hosted worker creation, automatic model routing, or automatic artifact merge. Other machines are reached over SSH (see Hosts below).

## User template expansion

Templates are version-1 workflow-shaped data with role bindings and typed parameters. Only prompts and role instructions have single-pass placeholders. Step paths are relative to the invocation project and cannot escape it, including through symlinks. reviewFix uses the same bounded expansion as presets; planning acceptance is carried to every review. Expansion passes parseWorkflow before preflight.

The start entrypoint alone merges CLI > project > global > template fields and records their sources. It requires per-invocation --write if any expanded step writes. Legacy init/run do not consult these files. Project config/templates live at the Git root (otherwise cwd); global config honors SFLOW_CONFIG_HOME/XDG_CONFIG_HOME. Files are atomically written and default-referenced templates cannot be removed accidentally.

createRun stores optional origin with template hash, parameters and final role values/sources without changing run version. Resume uses the saved workflow, never current preferences. Public views expose template identity only; full parameters remain private. The conversational main agent handles user intent/acceptance; lead/plan roles are explicit steps, not extra schedulers. Native approval/lifecycle/proof semantics are unchanged.

## In-place writes and retained sessions (#11)

`inPlace: true` is an explicit alternative to `worktree: true` on a write step.
It writes the canonical Git checkout named by cwd; it never resets, stashes or
cleans existing edits. init/start require both --write and --in-place and print
that exact directory. A saved workflow's inPlace field is the authorization for
run/resume. workspace chains may inherit this mode. All readers and writers of
an in-place checkout (including nested directories and symlink aliases) must
be ordered by dependencies whenever one is a writer.

Before dispatch, sflow saves a private snapshot of HEAD, the index, tracked and
non-ignored untracked files, including symlink targets and modes. After an
explicit terminal report it saves an end snapshot. Review compares those two
snapshots rather than HEAD, so earlier edits are not attributed to the step.
Snapshots and diffs stay in the private run directory, never in the project.
Ignored files are outside the observation contract. Snapshots are not backups
of all personal data. Changed HEAD/index and changes during read-only steps
block advancement; differences between a previous end and the next start also
block. Simultaneous outside writes during a write step cannot be attributed to
an actor: review always warns about that limitation. This is cooperative access
control within a validated workflow, not a lock on a human or another program.

Runs using either new mode use record version 3; old drivers reject them rather than applying the earlier cleanup/recovery rules. Legacy v1/v2 runs remain supported.

`reuseSession: <ancestor step>` continues one retained native TUI. Chains must
use the same agent, model, policy and effective workspace; agy is excluded
because its public OCS identity is per-step, not per native session. All members
are dependency ordered. A distinct token, wrapper and immutable result remain
per round; only the native actor and tmux session are shared. Claude's launch
allow rules name the wrappers in this declared chain, without global changes.
Acceptance is allowed only after the previous round's explicit done report,
and the bound actor must match. Previous reports cannot complete a later round.

Worker lifecycle (active/retained/closed) is recorded separately from step
status. A done worker is retained while a possible future round needs it; it
stops when no pending chain member remains, or on cancellation/final cleanup.
Retained TUIs count toward the actual-session concurrency cap. If retention
fills all slots before another session can run, the next step blocks with an
instruction to increase concurrency in a new workflow, rather than hanging.

Continuation prepares the new wrapper and bootstrap, persists launch intent,
then sends the bootstrap to the exact owned tmux pane once. A crash in this
window cannot establish delivery from session existence: the round remains
uncertain unless its own signed acceptance arrives. Never resend a continuation
or recreate a missing retained worker automatically. Human input and trust
prompts keep their native approval semantics.

## Hosts: steps on other machines

A step may run on another computer the user can reach with non-interactive SSH
(`ssh -o BatchMode=yes <target>`). SSH reachability is the prerequisite; how the
network gets there (same LAN, VPN, Tailscale, a jump host in `~/.ssh/config`) is
the user's choice. OCS is not the channel: OCS LAN does not replicate channels and
has no remote execution, so sflow talks to each host with `ssh <target> <bin>
remote <op>`, JSON on stdin and stdout. Host key checking, agent forwarding and the
rest of the SSH configuration stay as the user set them.

Templates may carry `host` and command steps (no role); `sflow start --host
<step>=<hosts>` overrides one step's host for a run and is recorded as its source.

Hosts live in `<config home>/hosts.json`: name → `{ssh, bin, slots, maxLoad,
minFreeGB, site, tags}`. A run freezes the entries its steps name at creation
(record version 4); resume uses the frozen copy, never the current file. Every
remote path (its data home, repos, worktrees) comes from the host's own `remote
hello`, never computed locally: home directories and user names differ between
machines. Driver and remote must speak the same `REMOTE_PROTOCOL` number.

`host` on a step names one host, a list of hosts, or `"any"` (every host in the
file). Without it the step runs locally as before. A step with `host` never falls
back to the local machine. Selection probes each candidate (load per core under
`maxLoad`, free disk over `minFreeGB`, protocol match) and then claims a slot on
the remote atomically (`mkdir` of `slots/<n>`, shared by every controller using
that host). A probe or claim refused before anything started is safe to retry on
another host; after a claim the step belongs to that host.

When no candidate can take the step yet (busy, out of slots, a send that failed
before anything started) the step stays `pending` with `waiting for a host: <reasons>`
and records `hostWaitSince`. Such a step can still start, so the run keeps running and
placement is tried again on later ticks. The wait is bounded by the step's own
`timeoutSeconds`, counted from the first refusal; past it the step is `blocked` with the
last reasons. Once a host takes it, `hostWaitSince` is cleared. When every candidate is
unusable for good (no such tool, wrong protocol, unreachable), the step is blocked at once,
as before.

### Code on the remote

Each host keeps one private bare repository per project under its data home.
The driver never pushes to `origin`, never commits in the user's repository and
never touches its HEAD or index. Objects created for transfer go to a private
object directory in the run (alternates point at the project's objects).

- Readers (read-only steps and command steps) see the same files as a local
  reader: tracked plus untracked, non-ignored files of the checkout or of the
  worktree they read, frozen into a commit with a temporary index, the same set
  `workspace.ts` snapshots. Submodules are refused; ignored files are not sent;
  Git LFS is not supported.
- Write steps start from HEAD, as a local write step's new worktree does. When a
  remote write step reports, the driver asks the host for a binary patch of the
  remote worktree against that HEAD (untracked files included), verifies its
  hash and applies it to a fresh run-owned local worktree at the same HEAD. The
  result is a worktree with uncommitted changes, exactly what a local write step
  leaves for review. Nothing is merged into the project.
- The remote verifies the commit and tree it received before using them.
- A write step's directory on a host is fixed per project and slot
  (`workspaces/<repo>/<slot>`), because agents record folder trust per path: the
  trust question comes once per slot, not once per run. Reuse switches it to the
  new step's branch at the new commit and removes everything else, ignored files
  included (`git clean -ffdx`), so it starts as a new worktree would. Changes a
  previous run left there are saved first as `<slot>.leftover-<branch>-<time>.patch`
  next to it; the previous `sflow/…` branch is deleted. The same step preparing
  again (a resumed driver) keeps the directory as it is. `cleanup` leaves
  workspaces in place; `gc` removes leftover patches past its cutoff.

`inPlace` steps cannot have a host. `workspace` and `reuseSession` chains stay on
one host. In-place observation snapshots do not apply to remote readers: they read
a frozen copy, so their writes cannot reach the checkout.

### Command steps

`allowFailure: true` on a command step records a non-zero exit as `done`, the exit
code being the result: a test before a review is information, not a stop.
`sflow init … --test "<cmd>"` inserts such a step after the write step and after
every fix round; each review depends on its round's test and is told to treat a
failing exit as blocking. `--host role=hosts` places plan, implement (and its fix
rounds), review and test steps.

`agent: "command"` with `command: [argv]` runs a program instead of an agent:
builds and tests. It reads `cwd` or the worktree of `workspace: <write step>`
(that step must be an ancestor). `artifacts` lists paths inside the checkout to
bring back. The argv, input commit and artifact list are frozen in the run; no
worker can submit a command, and no wrapper accepts free-form shell.

A command step is a job with a durable journal:

1. The driver records `jobId` (run + step) and the chosen host before contacting it.
2. The remote claims a slot, then `jobs/<jobId>` with an exclusive `mkdir`. An
   existing job is reported, never started twice.
3. The remote checks out the frozen commit in a job directory and starts the
   command in its own process group, detached from SSH. It writes `started.json`,
   the log, then `exit.json` (exit code or signal, times, arch), hashes the
   declared artifacts (inside the checkout only; `..` and escaping symlinks are
   refused), copies them out, removes the checkout and releases the slot.
4. The driver polls by `jobId`. Losing SSH after step 2 makes the step
   `uncertain`; it is never re-run, moved to another host or run locally. A job
   whose runner died without `exit.json` is reported as lost.
5. The driver fetches the log and artifacts, verifies every hash and stores the
   receipt as the step's result: host, jobId, input commit and tree, argv hash,
   arch, exit code or signal, times, log and artifact hashes. Exit 0 is `done`,
   anything else `failed`; a hash mismatch or missing artifact is `blocked`.

The receipt is evidence of what the command printed and returned; downstream
review still decides what it means. A timeout or cancellation kills only the
job's process group; when the host cannot be reached the cancellation is
recorded as unknown, never as done. Without `host`, a command step runs the same
journal on the local machine.

### Agent steps on a host

The driver stays the only writer of the run record. Before dispatch it sends the
host a mirror: run id, channel, the tokens of that host's steps only, and the
steps with remote paths. The remote's own tmux runtime creates the native
session on a private socket there, so the worker wrapper, `ocs whoami` and the
one-actor-one-step checks work unchanged on that machine. Assignments are sent
to the host's own OCS channel; the driver reads each host's channel separately
and accepts a report for a step only from the host that step runs on (sequence
numbers are per machine). Dependency result files are uploaded and their paths
rewritten; terminal results are fetched into the local result path with their
SHA-256 checked before reconciliation. For a continuation round the driver
updates the mirror's previous-round state first. status, logs, answer, attach,
stop and cancel go through the same remote operations. Remote sessions count
toward the workflow's concurrency and hold a host slot until they are closed.
A step placed on a host that never runs (the run stays blocked) keeps that slot
until `stop` or the run's cleanup; `sflow hosts check` lists slot owners. `sflow hosts gc` also removes mirror runs older than its
cutoff that validate as mirrors, have no live tmux session (probed under the
journal lock, 3 s bound, a timeout keeps the run), no checkout being prepared and
no slot claimed in the last hour; under the lock it only releases slots and moves
the run aside, deleting after. Known limit: the hour is a grace period, not a
lease, so `--days 0` during a placement that takes longer than an hour (a huge
evidence upload) can remove that mirror. Running
command jobs (and uncertain ones) count toward `concurrency` together with sessions.

## Teams: role sessions coordinated by message

A team is a set of long-lived native sessions with roles, started one at a time with
`sflow team spawn`. There is no workflow and no engine: a lead (a person, or any agent
session) hands out work by message and judges whether it is done. **Teams carry no
completion guarantee.** Nothing in `engine.ts` reads or drives a team, and a team never
appears among runs.

Split of responsibility. sflow starts a member, gives it its role, owns its private tmux
session, records what it started and stops it. OCS keeps discovery, identity, messages and
wakes. Nothing is added to OCS.

Records live in `teams/<team>/team.json` with `kind: "sflow-team"` and their own
`schemaVersion`, separate from runs: run tools never see them, and a record written by a
newer sflow is refused rather than reinterpreted. Each team has its own private socket
directory (`$TMPDIR/sf-t-<12 hex>/`, the same ownership checks as a run's) and its own lock,
held only for short record changes, never while waiting for a member.

A member's states are `launching`, `ready`, `closed` and `uncertain`.

- `spawn` writes the member as `launching`, with `launch.attemptedAt`, before tmux is asked to
  start anything. tmux is asked once. If it fails and no session exists, the member is
  `closed` with the error; if whether it exists cannot be determined, it is `uncertain`.
- The first prompt is the role and one instruction: run `<team>/<role>/member ready`. It
  carries no task. Tasks come later by message, so an uncertain start never leads to a task
  being sent twice.
- `ready` runs through the member wrapper (the capability token travels there, because Codex
  filters `*TOKEN*` variables). It checks the token, takes the native identity from
  `ocs whoami`, and sends a ready event signed with the token on the team channel, from that
  identity.
- The driver marks a member `ready` only for such an event: valid proof, sender equal to the
  claimed actor, actor shape matching the member's agent, the member still `launching`, its
  tmux session present, and the actor not already bound to another open member. A later
  report cannot rebind it. Neither `ocs who`, a session in the same directory, nor an idle
  TUI counts.
- Pane evidence is recorded with the ready event. If `$TMUX` names another tmux server, or
  `$TMUX_PANE` belongs to another session or is dead, `ready` refuses. If the check cannot run,
  the member is ready with `pane.verified: false` and the reason. Codex hides `TMUX` and
  `TMUX_PANE` from the commands it runs, so Codex members are always in this case. This
  guards against one session of the user being mistaken for another; it is not
  authentication, and same-user processes can read the token, as for runs.
- A `launching` or `ready` member whose session is gone without `team stop` becomes
  `uncertain`. Nothing restarts it; `spawn` refuses that role until a person stops it.

Messages. Claude members are started with `crossSessionInbound: accept` and Pi members wake
through the OCS Pi extension, so `ocs dm <OCS id>` reaches them. OCS wakes a Codex session only
when it is a task open in the desktop app, not a Codex CLI in tmux, so `sflow team send` is the
path that works for every agent. It writes the message to the team channel first (if that
fails, nothing was delivered), then pastes it into the member's pane once with an Enter. A paste
that fails part-way is reported as uncertain and never retried. The pasted text names the
sender's OCS id and a `Reply: ocs dm <sender> "…"` line; from a plain terminal there is no
sender id and the member answers in its own session.

`team stop` touches only the member's session on the team's socket, after saving its last
2000 lines to `terminal.txt`. There is no idle or age expiry: a quiet member may be working.
`team gc` lists closed members and empty teams, and removes them only with `--apply`.

Team members are not counted against any run's `concurrency`, and there is no machine-wide slot
count on this machine. Teams run on this machine only. Running members on hosts needs slot
accounting and SSH-loss handling there, and is not offered yet. agy is excluded: it has no
per-session identity, so two agy members could not be told apart.
