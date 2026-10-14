# A real change: implement, review, accept

English | [简体中文](dev-workflow.zh-CN.md)

This walks through one code change with Codex implementing in an isolated git worktree and Claude reviewing the actual diff. It uses a throwaway project, so nothing you care about is touched.

## 1. Set up

```sh
sflow doctor
sh examples/dev/setup.sh ~/sflow-demo
```

`setup.sh` (from this repository) creates `~/sflow-demo`: a git repo with `greet.sh`, `test.sh` and one commit. It then runs `sflow init implement-review --write …`, which writes `~/sflow-demo/.sflow/implement-review.json`:

- `implement` — Codex, `workspace-write` in a new worktree; told to report `details.workspace`, changed files and the checks it ran, and not to commit.
- `review` — Claude, read-only, after `implement`; told to open the worktree from that result and inspect `git status` / `git diff` itself instead of trusting the summary.

## 2. Run

```sh
sflow run ~/sflow-demo/.sflow/implement-review.json
```

The terminal shows each step as it changes. Prompts you may be asked, in this order, each shown with numbered options; type the number and Enter:

| prompt | when | what the choice means |
|---|---|---|
| Codex "Trust this folder?" | the first time Codex opens a worktree of this repo | Codex records trust for the **repository root** (`~/sflow-demo`) |
| Claude "Quick safety check" | the first read-only Claude step on this machine | trusts `~/.local/state/session-flow/workspaces/claude`, an empty folder sflow owns; asked once |
| Claude "This command requires approval" | the reviewer runs `git diff`, the tests, or its report command | "Yes" allows that one command; the "don't ask again" options widen it for the rest of the session |

In the run this guide was written from, Codex finished in about 3 minutes and Claude's review in about 11, with three Claude approvals answered from the run terminal.

## 3. Where things are

| | path |
|---|---|
| your project (`cwd` in the workflow) | `~/sflow-demo` — never modified by the run |
| implement worker | `~/.local/state/session-flow/runs/<run-id>/implement/worktree`, branch `sflow/<run-id>/implement`, created from the project's `HEAD` |
| read-only Claude worker | `~/.local/state/session-flow/workspaces/claude` (reads the worktree by absolute path) |
| other read-only workers | `~/.local/state/session-flow/runs/<run-id>/.protocol` |
| full results | `sflow result <run-id> <step>` (hash-checked files under the run directory) |

Uncommitted changes in your checkout are not in the worktree: it starts from the last commit.

## 4. Accept or drop the change

At the end `sflow run` prints a review (`sflow review <run-id>` prints it again). It separates what each worker **reported** (summary, checks, files — not rerun by sflow) from what sflow **observed** with git in the worktree (changed files, diff stat). Then check it yourself:

```sh
W=~/.local/state/session-flow/runs/<run-id>/implement/worktree
git -C "$W" diff
(cd "$W" && sh test.sh)
```

To keep it, commit in the worktree and merge the branch:

```sh
git -C "$W" commit -am "greet: add --shout"
git -C ~/sflow-demo merge sflow/<run-id>/implement
```

To drop it, or after merging, clean up:

```sh
git -C ~/sflow-demo worktree remove "$W"     # add --force to discard uncommitted changes
git -C ~/sflow-demo branch -D sflow/<run-id>/implement
```

sflow never commits, merges or removes worktrees for you.

## 5. When something goes wrong

| situation | what to do |
|---|---|
| a prompt is waiting | answer it in the run terminal, or `sflow answer <run-id> <step> <prompt-id> <n>` (ids from `sflow status`) |
| you pressed Ctrl-C or closed the terminal | workers keep running; `sflow resume <run-id>` reconciles their reports and continues |
| "no acceptance within …" | the error quotes the worker screen (a backend or sign-in error) or says the cause is unknown; look with `sflow logs`, fix it, then `sflow resume <run-id>` — a still-open worker gets a fresh readiness window |
| a worker reported `failed` or `blocked` | final for that run. Fix the cause and start a new run; it gets a new worktree |
| a step is `uncertain` (assignment or launch outcome unknown) | sflow never resends or recreates it. Check `sflow review` and `sflow logs`, then `sflow stop <run-id>` and start a new run |

There is no automatic "retry from step". To reuse a finished step's work in a new run, put what is needed into the new step's prompt, or point it at the old result (`sflow result <old-run> <step>`) and ask it to verify that evidence before relying on it. To build on an old worktree, commit it and merge its branch into your project (section 4), then start the new run from the project.
