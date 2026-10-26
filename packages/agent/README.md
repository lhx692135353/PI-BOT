# Pi Bot agent 与私有 skills

Mac 与云端共用 `createBotAgent`，统一使用 Pi 的 `openai-responses` 适配器访问 `/llm/v1/responses`，支持 Grok 等兼容 Responses API 的模型。用户输入和历史保留标准的 `role: "user"` / `role: "assistant"` 消息；只有模型真实发起的工具调用使用 `function_call` / `function_call_output`，并通过 `call_id` 配对。消息通过 `input` 发送，服务商不保存会话（`store: false`）。平台通过 Pi SDK 的 `extensionFactories` 加载内置 `skillsExtension`，每个会话只允许显式提供的工具，以及 `skill_manage`、`skill_load`。不会发现用户家目录、资料库或祖先目录中的 extensions、skills、AGENTS、提示词模板；智能体不能修改平台插件。

## 所属与存储

- `bot_skills` 存当前版本，`bot_skill_versions` 存每次变更的完整快照、操作、发起运行和时间。
- 以 `bot_id` 隔离；名称只在所属 Bot 内唯一。主智能体与普通智能体使用相同规则，委托不会转移 skill 的访问权限。
- 云端是唯一持久存储。Mac 和 Runner 通过内部 API 按需读取，不把 skill 写进可浏览的资料库，也不需要文件缓存同步。
- Mac 和 Runner 的 Pi 私有状态目录均使用 `<agentDir>/bots/<bot_id>/`，不按可改名的 Bot 名字或资料库 slug 定位。
- `0005-bot-skills.sql` 随 API/Worker 启动自动迁移，部署时需要更新 API、Worker、Runner 和 Mac harness。

## 内部 API 与工具

`POST /agent/skills` 仅接受短期智能体模型代理令牌。请求携带 `run_id`，所属 Bot 由令牌和运行共同确定；请求不接受 `bot_id`。校验用户、Bot、执行端、Mac 设备、运行状态，以及归档/取消状态。普通用户令牌不能调用此接口；接口不出现在公开 OpenAPI 中。

| 工具 | 操作 |
|---|---|
| `skill_manage` | `list`、`create`、`update`、`enable`、`disable`、`delete`、`history`、`restore` |
| `skill_load` | 读取已启用 skill 的 Markdown 说明，或按 `reference` 读取一份配套资料 |

创建需传 `name`、`description`、`instructions`，可选 `references`（资料名到正文的映射）。已有 skill 的变更必须携带 `expected_version`；冲突返回 409，重新读取后再修改。删除为软删除；恢复指定历史版本会创建一个新的当前版本。停用/删除的 skill 不进入运行目录，不能 `skill_load`；可通过 `list` 获取版本号并启用或恢复。`history` 返回最近 20 个版本的元数据。

每个 Bot 最多保存 64 个名称（含软删除记录）；名称最多 64 字符，使用小写字母、数字和短横线。描述最多 1024 字符，说明最多 32000 字符；最多 8 份参考资料，每份最多 16000 字符，总 JSON 长度最多 64000 字符。第一版只提供说明和参考资料，不执行或安装脚本/依赖，不增加文件、终端、协作权限。

## 加载与自管理

`buildContext` 从数据库读取已启用目录，只传名称、描述、版本。Extension 在 `before_agent_start` 注入目录及管理规则；Pi 0.87.1 的内置 skill 提示要求 `read` 或 `bash`，因此这里显式引导使用私有 `skill_load`。模型只在任务匹配时读取完整说明，资料按需加载。当前任务创建/更新后可立即读取；下次运行自动刷新目录。

只沉淀经验证的可复用工作方法和明确纠正的流程，不为每轮对话创建 skill；偏好、身份、事项进度继续由长期记忆维护。系统提示禁止保存凭据，禁止将内部正文复制进资料库。平台加载器和普通文件工具不会自动载入 skill 中的可执行插件。

## 用户不可见的范围

没有 skill 管理页面、按钮、用户命令或 Bot 配置字段。工具事件在 agent 层过滤，公开消息序列化和服务端 `recordTool` 再过滤；数据库只保存独立的 skill 版本审计。私有 skill、记忆和检查点操作前的文字不生成公开进度。`goal_manage` 的工具记录仍隐藏，但面向用户的简短回应会保留；同一条模型消息若还包含其他内部工具，仍按内部消息隐藏。

工具调用可能在模型的一段文字之后才到达。启用私有 skill 的会话会缓存一条完整 assistant 消息，再判断是否包含需要隐藏正文的内部工具（`goal_manage` 除外）：需要隐藏的消息不向客户端推送正文，其余消息完成后推送。客户端仍展示任务状态、普通任务进度和最终回答，但这类会话不逐 token 推送文本。未启用私有 skill 的 SDK 会话保留原来的流式行为。

需要工具核实或较长任务时，提示词要求先给出一句结合当前问题的简短回应，再查询或安排后台任务；重要发现可以另发进度，完成后再汇报核实结果。简短回应由模型生成并保存在进度中，简单问题直接回答。

这是产品层的内部机制，不是对模型或数据库管理员加密；模型最终回答是否主动复述内部内容仍由提示规则约束。

## 验证

- `packages/agent/tests/skills.test.ts`：真实 Pi Extension、按需读取、令牌刷新、无文件发现、内部事件/临时文字过滤、工具覆盖拒绝。
- `server/tests/skills.test.ts`：Bot/用户/执行端/设备/运行隔离、版本并发冲突、参考资料、停用/删除/恢复、公开接口过滤，真实云端 Runner 创建和复用。
- `desktop/tests/harness-e2e.test.ts`：真实 Mac harness 管理和复用、资料库不出现 skill、云端上下文可发现 Mac 创建的 skill。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。两端需与 API、Worker、Runner 同步升级，服务端自动应用 `0007-async-tasks`；升级前结束旧运行。详情见 [整体架构](../../server/ARCHITECTURE.md)。

记忆、协作目录、任务续接与云端 Langfuse 配置见[实现说明](../../server/MEMORY-OBSERVABILITY.md)。
