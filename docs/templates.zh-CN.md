# 通用流程模板与默认配置

模板保存角色、模型、提示词、参数和依赖关系，每次只传任务和项目目录。展开后的结果是普通 workflow，沿用现有调度、审批、worktree 和恢复机制。

```sh
sflow template create my-dev --from builtin:dev --project --cwd .
sflow template show project:my-dev --json
# 编辑 .sflow/templates/my-dev.json 后：
sflow template validate project:my-dev
sflow template use project:my-dev --project
sflow config set --project --role implement=codex --model review=sonnet --param rounds=2
sflow start --task "增加登录页面" --cwd . --write --dry-run --json
sflow start --task "增加登录页面" --cwd . --write
```

`--dry-run` 不启动 agent，也不创建 run。它展示最终 workflow、角色配置、参数和每个字段的来源。正常启动也会先打印计划。项目模板和配置可能来自别人提交的仓库内容，第一次使用时应查看来源和计划。写模板每次必须带 `--write`，默认配置不能代替本次授权，也不会关闭原生审批。

## 角色与内置流程

`dev` 包含规划、隔离 worktree 实现、审查和修复复审。`rounds` 默认为 2，范围 1–5。规划阶段报告 `details.acceptance`，每轮审查都读取它，并逐条报告验收结果。不需要的轮次跳过；最后一轮仍不通过则交给用户。`review` 是一次只读审查；`investigate` 和 `fan-out` 是并行调查后汇总。

当前对话里的 agent 负责澄清、展示审批和最终验收，sflow 负责调度。模板中的 `plan`、`lead` 或 `join` 是明确的执行步骤，不能启动另一套 sflow 调度，也不能自由委派。角色名称可以自行定义。

完整模板示例：

```json
{
  "version": 1,
  "kind": "sflow-template",
  "name": "my-review",
  "params": { "focus": { "type": "string", "default": "正确性" } },
  "roles": { "review": { "agent": "claude", "model": "sonnet", "instructions": "重点检查 {{focus}}。" } },
  "steps": [ { "id": "review", "role": "review", "cwd": ".", "prompt": "任务：{{task}}。检查相关代码，报告带文件和行号的发现，不修改文件。" } ]
}
```

角色可配置 `agent`、`model`、`instructions`。`{"inherit":"implement","instructions":"只修复审查意见"}` 继承 implement 最终的 agent/model，不继承提示词。禁止循环继承。本次可以用 `--role review=codex --model review=<模型>` 覆盖。模型最终是否可用由原生 CLI 判断。

## 参数、路径与修复

`task` 是内置必填字符串，用 `--task` 提供。其他参数声明 `string`、`integer` 或 `boolean` 类型，可有 `default`；整数可加 `min`、`max`。没有默认值就是必填。支持重复 `--param 名称=值`，或 `--params-file 文件.json` 参数对象，显式 `--param` 优先。未知参数或角色报错，声明但未使用的参数给出警告。

`{{名称}}` 只在 step.prompt 和 role.instructions 中单次替换。参数里的引号、反引号、`$()` 和 `{{task}}` 作为文本保留，不执行、不递归展开。不能参数化 id、路径、依赖、权限、条件等字段。step.cwd 相对于本次 `--cwd`，不能是绝对路径，不能包含 `..`，也不能通过符号链接逃出项目目录。

模板可使用现有 workflow 的 DAG、when、expect、workspace 和超时字段，将 agent/model 换成 role。未知字段拒绝，实际展开后再次通过现有 workflow 校验。审查步骤可带 `reviewFix`：

```json
{
  "id": "review", "role": "review", "cwd": ".",
  "dependsOn": ["implement", "plan"],
  "prompt": "检查 {{task}} 的实际改动和验收标准。",
  "reviewFix": { "fixRole": "fix", "workspace": "implement", "rounds": { "param": "rounds" } }
}
```

它与旧 preset 共用展开函数，生成 review-1/fix-1/review-2 等独立步骤，所有 review 都接收 plan。其他 review 名称对应 `<id>-fix-N`。新增后续步骤时引用 dry-run 展示的具体展开 ID，不能重复 ID。

## 默认值与管理

项目文件位于 Git 顶层 `.sflow/config.json` 和 `.sflow/templates/`；非 Git 使用 `--cwd` 下的 `.sflow/`。全局目录依次取 `$SFLOW_CONFIG_HOME`、`$XDG_CONFIG_HOME/sflow`、`~/.config/sflow`。

字段优先级：本次 CLI > 项目配置 > 全局配置 > 模板自带。未配置默认时必须显式传 --template，错误提示会列出可用模板。只有用户主动设置后，才允许省略模板。同名模板按项目 > 全局 > 内置查找，也可以写 project:/global:/builtin: 固定来源。`template list` 标出被遮蔽的模板。全局默认建议使用明确的 global: 或 builtin: 前缀。

```sh
sflow template list --cwd .
sflow config show --cwd . --json
sflow template create my-review --from builtin:review --global
sflow template use global:my-review --global
sflow config set --global --model review=sonnet
sflow config clear --project --role review
sflow template clear-default --global
sflow template remove my-review --global
```

config 支持 version、template、roles、params，不支持 write 或 policy。角色/模型按字段合并，不会因为只覆盖 agent 而清掉已有 model。`config clear --param <名称>` 删除参数默认，`--role <名称>` 删除该角色覆盖。清掉项目默认后可能露出全局默认。

`template create --from <文件|模板名>` 支持复制、导入；`show --json` 用于导出。导入普通 workflow 时，目录必须在 `--cwd` 范围内，按原 agent/model 生成角色；固定任务提示不会自动改成参数，请自行加入 `{{task}}`。默认不覆盖已有文件，只有 --force 才替换；JSON 原子写入。删除当前默认引用的模板会拒绝，先 clear-default 或切换。`validate` 不带任务只检查模板结构；完整 DAG 和路径检查用 start --dry-run。

## 自动套用与恢复

安装的 skill 支持 `/sflow <任务>`：先解析 dry-run，展示模板、角色/模型、来源和写入范围，再运行。用户明确要求改代码时才传 --write；普通问答或未要求执行的讨论不启动付费 worker。

可由用户将这条规则加入项目 AGENTS.md：

> 明确开发或审查请求使用 sflow skill 和项目默认模板。第一次使用项目来源模板时展示解析计划及来源。普通问题不启动付费运行。只有用户要求改代码才加 --write。未要求时不提交或合并。

安装器只刷新 bundled skill，不自动修改项目规则或全局权限。原来的 `init <preset>`、`run workflow.json` 不读取新配置。start 将展开后的 workflow 和模板来源/hash、参数、最终角色及来源固化在私有 run.json，后续编辑模板不会改变 resume。status/review/runs 只增加模板标识，参数中的任务正文不加入这些公开视图。明确请求的 show/dry-run 及私有记录可能包含任务文本，不要放进 Git。

原生确认仍由用户选择，通过 status/answer/attach 处理。sflow 不自动提交、合并或重派不确定任务。最终仍需检查实际 diff 并重跑相关测试。

配置中属于其他模板的角色/参数会忽略，并显示带来源的警告；CLI 或参数文件显式传入未知字段仍报错。
