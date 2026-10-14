# Reusable workflows and defaults

Templates keep a workflow's roles, models, instructions, parameters and dependency graph. Each invocation supplies a new task and project. A template expands into an ordinary workflow before preflight; workers, approvals, result proofs, worktrees and recovery use the existing engine.

```sh
sflow template list
sflow template create my-dev --from builtin:dev --project --cwd .
sflow template show project:my-dev --json
# Edit the printed .sflow/templates/my-dev.json path, then:
sflow template validate project:my-dev
sflow template use project:my-dev --project
sflow config set --project --role implement=codex --model review=sonnet --param rounds=2
sflow start --task "Add a login screen" --cwd . --write --dry-run --json
sflow start --task "Add a login screen" --cwd . --write
```

`--dry-run` starts no agents and creates no run. It prints the expanded workflow, role assignments, values and field sources. A normal `start` prints the template's source, assignments and field sources before preflight. Project templates and config are repository content: inspect that plan before first use. A writing template requires `--write` on every invocation, even if it is the configured default. Configuration cannot grant write permission or change native approvals.

## Built-ins and roles

`dev` plans, implements in a worktree, reviews the actual change and fixes findings in that same worktree. Its `rounds` integer defaults to 2 (1–5). Each review receives `plan.details.acceptance`, checks each criterion and reports a verdict. Unneeded rounds are skipped; the last required review must pass. `review` runs one read-only reviewer. `investigate` / `fan-out` run two independent investigators and a joining step. The built-in roles are listed by `template show`; any template may define its own roles.

The agent driving the conversation remains responsible for clarification, presenting approvals and final acceptance. A template's `plan`, `lead` or `join` role is an explicit workflow step, not a second scheduler. Workers cannot start another workflow or delegate. The driver never commits or merges.

```json
{
  "version": 1,
  "kind": "sflow-template",
  "name": "my-review",
  "description": "Review with a chosen focus",
  "params": { "focus": { "type": "string", "default": "correctness" } },
  "roles": {
    "review": {
      "agent": "claude",
      "model": "sonnet",
      "instructions": "Pay attention to {{focus}}."
    }
  },
  "steps": [
    { "id": "review", "role": "review", "cwd": ".",
      "prompt": "Task: {{task}}. Read the relevant code; report findings with file/line evidence. Do not edit." }
  ]
}
```

Agent names are `claude`, `codex`, `pi`, `agy`; model names are passed to their native CLI. A role can use `{"inherit":"implement","instructions":"Fix only the findings"}`. It inherits the final agent/model (including overrides), but never another role's instructions. Inheritance cycles are rejected. Use `--role review=codex` and `--model review=<name>` to override one invocation.

## Parameters and paths

`task` is always a required string supplied by `--task`. Additional parameters have type `string`, `integer` or `boolean`, optional `default`, and integer `min`/`max`. A parameter without a default is required. Use repeated `--param focus=performance --param rounds=3`, or `--params-file parameters.json` containing an object; explicit `--param` values override that file. Unknown parameters and roles are errors. Unused declared parameters produce warnings.

`{{name}}` substitution is single-pass, only in `step.prompt` and `role.instructions`. A value containing quotes, shell characters or `{{task}}` stays text; sflow does not evaluate it. Parameters do not alter step IDs, dependencies, policies, conditions or paths. `step.cwd` is relative to invocation `--cwd`, with no absolute path or `..`; a symlink escaping that directory is also rejected. This keeps repository-supplied templates from silently selecting another project.

All ordinary workflow fields except `agent`/`model` are available on template steps; use `role` in their place. Unknown schema fields fail validation. The completed expansion always passes the existing workflow validator before any worker is created.

For bounded repair, a review step can declare:

```json
{
  "id": "review", "role": "review", "cwd": ".",
  "dependsOn": ["implement", "plan"],
  "prompt": "Review the actual implementation and acceptance criteria for {{task}}.",
  "reviewFix": {
    "fixRole": "fix", "workspace": "implement",
    "rounds": { "param": "rounds" }
  }
}
```

It expands through the same function as the `implement-review-fix` preset into `review-1`, `fix-1`, `review-2`, etc. Other review names produce `<id>-fix-N`. Extra dependencies such as `plan` reach every review. Expanded step IDs must be unique; when adding downstream steps, refer to the explicit expanded IDs visible in `start --dry-run`.

## Storage and precedence

Project config and templates are in the Git top level's `.sflow/config.json` and `.sflow/templates/`. Outside Git they are in the invocation directory's `.sflow/`. Global storage is `$SFLOW_CONFIG_HOME`, otherwise `$XDG_CONFIG_HOME/sflow`, otherwise `~/.config/sflow`.

```json
{
  "version": 1,
  "template": "my-dev",
  "roles": { "implement": { "agent": "codex" }, "review": { "model": "sonnet" } },
  "params": { "rounds": 2 }
}
```

Fields merge independently: explicit CLI > project config > global config > template fields. Without a configured default, `start` requires an explicit `--template` and lists available templates. Defaults exist only after the user sets them. A bare template name resolves project > global > builtin; `project:`, `global:` and `builtin:` force a scope. `template list` marks shadowed names. Use explicit scope names for portable global defaults.

`config show` displays config values and their sources; `start --dry-run` adds template values and inheritance. `config set` changes roles/models/parameters/template; `config clear --role <name>`, `--param <name>` or `--template` removes a stored field. `template clear-default` removes only the selected scope's template default. Clearing a project default may expose the global default.

```sh
sflow template create mine --from builtin:review --global
sflow template use global:mine --global
sflow config show --cwd . --json
sflow config clear --project --role review
sflow template clear-default --global
sflow template remove mine --global
```

Creation never overwrites without `--force`. Writes replace complete JSON files atomically. Removing a template that resolves as a current project/global default is refused; clear or change that default first. `show --json` exports a template. `create --from <file>` imports a template or existing workflow (its project paths must lie inside `--cwd`; role definitions are derived from its agents/models). Imported fixed prompts stay fixed: edit them to use `{{task}}` if they should change per invocation. `validate` without a task checks template structure; `start --dry-run` checks an actual expansion, including DAG and paths.

## Compatibility and recovery

`init <preset>` and `run workflow.json` never read template/default config. Existing scripts keep their agent choices and permissions. `start` stores the fully expanded workflow and private origin (template hash, parameters, final roles and their sources) in `run.json`. Editing a template or defaults later cannot change a resumed run. Public status/review/list show template identity; private task parameters are not added to those views. Explicit dry-run/show and private run records can contain task text: keep them out of git.

Native approvals still belong to the user. Use `status`, `answer` or `attach` as before. Interrupted runs resume from their frozen workflow, without re-expansion or uncertain retries. Always inspect the actual diff and rerun relevant checks before accepting a writing task.

For automatic use in an agent conversation, install the bundled skill with `sflow skill install`, then ask `/sflow <task>`. A project may add this instruction to its own AGENTS.md:

> For explicitly requested development or review tasks, use the sflow skill and project default template. Show the resolved plan and source before the first project-template run. Do not start paid workers for ordinary questions. Add --write only when the user asked for code changes. Do not commit or merge unless asked.

Installation never writes that instruction into your project or changes global agent permissions.

Config fields for roles/parameters absent from the selected template are ignored with source-labelled warnings; explicit unknown CLI or parameter-file fields remain errors.
