# Session Flow

[English](README.md) | 简体中文

https://github.com/user-attachments/assets/87ca55f0-c839-41f6-ac16-4725542c7e24

视频中段是 [examples/smoke.json](examples/smoke.json) 的一次真实运行，画面取自它的 tmux 窗格。

在多个彼此独立的 Claude Code 和 Codex 会话之间跑一套工作流。每个步骤自己选 agent 和模型；任务分派和明确的结果由 OCS 传递。首个运行时适配器在 macOS/Linux 上用私有 tmux 会话拉起原生 TUI。

不依赖 orcr、Herdr、API 代理，也没有拷贝 OCS 内部实现。原生 CLI 用的是各自已登录的账号。

## 安装

通过下面的命令安装 GitHub Release 二进制：

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/session-flow/main/install.sh | sh
```

如果想从源码构建：

```sh
bun install
bun run build
bun run bench:context
./dist/sflow help
```

需要先安装并登录 `claude` 和 `codex`，再装好 `tmux` 和 [OCS](https://github.com/leeguooooo/open-cross-session) 0.8.0 或更新版本。只有工作流里用到的 agent 才必须安装。这个 MVP 用已发布的 OCS 0.8.0 就能跑，不需要后来新增的 send/dm JSON 输出和 whoami threadId。不通过 npm registry 分发。

## 运行

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

`model` 可选：不写就用该 CLI 配置的默认模型，也可以写你账号支持的任意模型。相对路径的 `cwd` 以工作流文件所在目录为基准解析。`dependsOn` 构成一张 DAG，互不依赖且已就绪的步骤会并发执行。默认 policy 是 `read-only`；要写文件必须设 `worktree: true`，并且项目得是至少有一个提交的 Git 仓库。默认执行超时 1800 秒，就绪超时 90 秒（分别对应 `timeoutSeconds` / `readyTimeoutSeconds`）。

合成示例 [examples/smoke.json](examples/smoke.json) 覆盖了 Claude 做规划、Claude/Codex 并行干活、最后由 Codex 汇总这条链路，全程不改项目文件。

## 减少通信量和重复上下文

worker 通过机器可读的 OCS 事件上报"已接受"和唯一一条最终结果，这些事件不会唤醒对方。worker 之间不会来回发确认或例行进度。依赖推进由驱动器负责，调度不靠模型之间协商。

同一次运行中，只读步骤共用一个协议工作目录和同一套工具；获批的协议命令和能力凭证（capability）仍然按步骤隔离。可选的 `prefixWarmupMs`（默认 0，最大 5000）让 agent/模型相同的一组步骤先等第一个 worker 接受任务，或等到超时，再启动其余的兄弟步骤。先实测它对你的工作负载有没有帮助，再决定开不开。这样做让前缀复用成为可能，但能不能命中缓存，仍取决于原生 CLI 和模型提供方。不同模型不会被分到一组，写步骤也照样各用各的 worktree。共用的 Claude worker 工作区别名有歧义，如果要给它们发消息，必须用精确的会话 ID 寻址。

新的运行会把完整结果存成不可变、按内容寻址的私有文件。OCS 消息和运行快照里只带状态、摘要和 SHA-256 引用。驱动器在接受完成之前会校验文件和哈希。依赖结果小的直接内联，大的走引用，扇入很宽时只用一份清单。评审者必须看过完整结果和产物才能下结论。`status` 只打印摘要；`result` 按需读取一份经过校验的完整报告。

`stats` 统计消息条数，以及作为任务/依赖上下文转发的字节数。这些是本地通信量的测量值，不是计费 token，也不能证明命中了缓存。运行记录现在是版本 2；版本 1 的运行仍然可读，worker 辅助程序升级后也保持内联报告的语义。旧版 CLI 遇到版本 2 记录会直接拒绝，而不是把引用形式的结果读错。

## 信任、审批与恢复

新开的原生会话可能会弹出目录信任、登录或工具审批的提示。用 `attach` 打开对应的 worker 处理即可。标准审批保持开启；这个版本不承诺无人值守执行。对 Claude 来说，read-only 禁用文件编辑工具，但 shell 操作仍走原生的权限确认。Codex 评审 worker 可以写协议/结果文件和 OCS 消息，被评审的仓库则不在它的沙箱可写目录里。

Ctrl-C 只停掉驱动器，worker 继续保留。记下打印出来的 run ID：

```sh
sflow resume <run-id>
sflow stop <run-id>
```

resume 会先对账 OCS 报告再继续推进。结果不确定的发送或 worker 创建绝不会自动重试。就绪超时后 worker 可能还停在那儿等人处理；处理完提示，再 resume。最终的 failure/blocked 报告对本次运行是终局。想有意重试，请新开一次运行。

只有明确的 `done` 报告才会推进依赖。报告只是 agent 的自述，所以要去看实际的 diff 和检查结果。已完成的会话会被归档并关闭；`logs` 读取保留下来的归档。worktree 留在磁盘上供你检查、手动提交/合并，运行器不会自动提交或合并。

运行记录存放在 `~/.local/state/session-flow/runs/<id>`（可用 `SFLOW_HOME` 覆盖）；每次运行的 OCS 消息走一个 `sflow-<id>` 频道。这些记录可能含有私密的任务文本，别把它们提交进 git。所有 worker 都跑在你的同一个系统账号下；协议防不住同一用户下的恶意进程。

## 开发

```sh
bun test
bun run check
bun run build
```

[DESIGN.md](DESIGN.md) 介绍了职责归属、失败语义、协议和 MVP 的限制。运行时适配器可以替换；本版本只实现了 tmux 以及 Claude/Codex TUI。
