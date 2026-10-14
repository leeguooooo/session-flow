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

`pending → dispatching → launching → starting → running → done/failed/blocked`.

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
step cannot claim another. Identical agent/model groups may opt into a bounded
prefix warmup hold with `prefixWarmupMs` (default 0, maximum 5000). This
does not prove a cache hit, and tool/account/model differences may prevent reuse.
Write workers stay isolated. Dependency context is inline only up to 1 KiB per
result and 4 KiB aggregate; larger fan-in is a SHA-256 manifest. The full evidence
remains available for verification. Byte/message metrics are not token billing.

Each step has one attempt. There is no automatic retry, model fallback, or reassignment. Use a new run for a deliberately repeated attempt after inspecting the original workers and outputs.

Dependency outputs are data, not instructions. Small results are inline; large results are referenced by private local file and SHA-256. No automatic cherry-pick, merge, or push. Write steps require isolated worktrees and retain their diffs for the main agent to review and commit. Review steps receive artifact paths from preceding workers.

## Permissions and resource ownership

No global permission settings are changed, and no bypass flag is used. Native trust/login/approval prompts may require a human: `sflow logs` and `sflow attach` expose the owned session. A readiness timeout prints the `resume` command; after intervention, resuming reconciles reports before progressing.

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

No GUI, automatic branch/repair loop, cron, cross-machine runtime creation, Desktop-hosted worker creation, automatic model routing, or automatic artifact merge. Future adapters can create sessions in other hosts while keeping the workflow engine and OCS message protocol unchanged.
