# 改一次真实代码：实现、审查、验收

[English](dev-workflow.md) | 简体中文

这篇带你走一遍完整的改代码流程：Codex 在隔离的 git worktree 里实现，Claude 审查实际的 diff。用的是一个一次性的示例项目，不会碰到你在意的东西。

## 1. 准备

```sh
sflow doctor
sh examples/dev/setup.sh ~/sflow-demo
```

`setup.sh`（在本仓库里）会创建 `~/sflow-demo`：一个只有 `greet.sh`、`test.sh` 和一次提交的 git 仓库。然后它执行 `sflow init implement-review --write …`，生成 `~/sflow-demo/.sflow/implement-review.json`：

- `implement`：Codex，`workspace-write`，在新的 worktree 里改；要求它报告 `details.workspace`、改了哪些文件和跑过的检查，并且不要提交。
- `review`：Claude，只读，在 `implement` 之后；要求它从上一步结果里找到 worktree，自己看 `git status` / `git diff`，而不是相信摘要。

## 2. 运行

```sh
sflow run ~/sflow-demo/.sflow/implement-review.json
```

终端会显示每个步骤的变化。可能会按下面的顺序问你几个问题，每个都带编号选项，输入数字回车即可：

| 提示 | 什么时候出现 | 选了意味着什么 |
|---|---|---|
| Codex "Trust this folder?" | Codex 第一次打开这个仓库的 worktree | Codex 会把信任记在**仓库根目录**（`~/sflow-demo`）上 |
| Claude "Quick safety check" | 这台机器上第一个只读 Claude 步骤 | 信任 `~/.local/state/session-flow/workspaces/claude`，这是 sflow 自己的空目录；只问一次 |
| Claude "This command requires approval" | 审查者执行 `git diff`、跑测试或交结果的命令 | "Yes" 只放行这一条；"don't ask again" 类选项会在这次会话里放宽 |

写这篇文档时的那次真实运行里，Codex 大约 3 分钟做完，Claude 的审查大约 11 分钟，期间在 run 的终端里回答了三次 Claude 审批。

## 3. 东西都在哪

| | 路径 |
|---|---|
| 你的项目（工作流里的 `cwd`） | `~/sflow-demo`，运行过程中不会被改动 |
| 实现步骤 | `~/.local/state/session-flow/runs/<run-id>/implement/worktree`，分支 `sflow/<run-id>/implement`，从项目的 `HEAD` 创建 |
| 只读的 Claude 步骤 | `~/.local/state/session-flow/workspaces/claude`（按绝对路径读 worktree） |
| 其他只读步骤 | `~/.local/state/session-flow/runs/<run-id>/.protocol` |
| 完整结果 | `sflow result <run-id> <step>`（运行目录下经过哈希校验的文件） |

你工作区里没提交的改动不会出现在 worktree 里：它从最后一次提交开始。

## 4. 接受或丢弃改动

结束时 `sflow run` 会打印一份验收摘要（`sflow review <run-id>` 可以再看一次）。它把每个 worker **报告**的内容（摘要、检查、文件，sflow 没有重跑）和 sflow 用 git 在 worktree 里**实际看到**的（改了哪些文件、diff 统计）分开列出。然后自己确认：

```sh
W=~/.local/state/session-flow/runs/<run-id>/implement/worktree
git -C "$W" diff
(cd "$W" && sh test.sh)
```

要保留，就在 worktree 里提交，再合并这个分支：

```sh
git -C "$W" commit -am "greet: add --shout"
git -C ~/sflow-demo merge sflow/<run-id>/implement
```

不要了，或者合并完以后，清理掉：

```sh
git -C ~/sflow-demo worktree remove "$W"     # 有未提交改动时加 --force 丢弃
git -C ~/sflow-demo branch -D sflow/<run-id>/implement
```

sflow 从不替你提交、合并或删除 worktree。

## 5. 出问题时

| 情况 | 怎么办 |
|---|---|
| 有提示在等回答 | 在 run 的终端里回答，或 `sflow answer <run-id> <step> <prompt-id> <n>`（id 从 `sflow status` 拿） |
| 按了 Ctrl-C 或关了终端 | worker 还在跑；`sflow resume <run-id>` 会核对它们的报告并继续 |
| "no acceptance within …" | 错误信息会引用 worker 屏幕上的内容（后端或登录错误），认不出就写原因未知；用 `sflow logs` 看，处理好后 `sflow resume <run-id>`，仍开着的 worker 会得到新的就绪窗口 |
| worker 报告了 `failed` 或 `blocked` | 这次运行里是终态。把原因解决后新开一次运行，会用新的 worktree |
| 步骤是 `uncertain`（派单或启动结果未知） | sflow 绝不自动重发或重建。用 `sflow review` 和 `sflow logs` 查清楚，然后 `sflow stop <run-id>`，再新开一次运行 |

没有自动"从某步重试"。想在新运行里复用某步已完成的结果，把需要的内容写进新步骤的 prompt，或者让它去读旧结果（`sflow result <旧 run> <step>`），并要求它先核实这些证据再使用。想在旧 worktree 的基础上继续，就先提交并把它的分支合并进项目（第 4 节），再从项目开新的运行。
