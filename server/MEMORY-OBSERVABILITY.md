# 私有记忆、任务续接与云端 Langfuse

## Pi Hermes Memory 托管版

`packages/agent/src/hermes-memory` 是 **pi-hermes-memory 0.9.10** 的受控功能裁剪移植，实际复用上游内容扫描、记忆匹配规范化与写入策略，保留 MIT LICENSE。模型工具和 lifecycle 接入改为平台显式加载，存储、检索和学习流程适配 PostgreSQL；不运行上游本地 Markdown/SQLite 存储、全局 session 扫描、skill 注册或子进程回退。来源及改动见该目录 README。

长期事实、工作结论带来源、explicit/inference、revision 和删除墓碑。自动学习不能覆盖用户纠正或重新插入已删除内容。删除使旧摘要失效，并排除对应源消息，原始记录仍保留。`memory_manage` 负责增删改查，`history_search` 检索当前 Bot 的公开历史和自己执行过的任务；访问范围由运行令牌确定。

公开对话摘要有租约、连续区间与失败退避，成功提交摘要后才推进游标。超大消息保留为原文检索，不标记为已完成摘要。旧摘要兼容读取，后续对话逐步进入新事实和摘要。每轮使用有预算的记忆快照；Pi 原生 token 估算、压缩和 custom session entry 继续复用。

每累计 20 条有效消息，或记忆/已完成任务发生变化时，后台提取私有记忆和宽泛知识主题；目录组合主题、人设和启用技能。`agent_directory` 搜索全部同用户未归档 Bot，提示中最多注入 20 项简短目录，不包含私有正文。使用稳定 ID 调用 `ask_agent`，由对方检索自己的记忆回答。

任务通过 `task_checkpoint` 保存已确认事项、发现、产物、阻塞和下一步；带版本控制，完成时补最终结果，中断保留最近版本。用户要求后用 `resume_task` 创建关联任务，恢复目标、检查点、补充指令和结果；重复请求幂等。仍在运行则追加要求。续接先核实未知操作，旧审批不继承，不自动恢复或重放工具过程。

## 云端配置

在云端 `.env` 填写实际值，配置文件不提交仓库：

```dotenv
LANGFUSE_TRACING_ENABLED=true
LANGFUSE_BASE_URL=https://your-langfuse.example.com
LANGFUSE_PUBLIC_KEY=pk-lf-...
LANGFUSE_SECRET_KEY=sk-lf-...
LANGFUSE_TRACING_ENVIRONMENT=production
```

默认关闭；PUBLIC_KEY 对应 AK，SECRET_KEY 对应 SK。API 只接收开关，**仅 Worker 注入地址和凭据**，Runner、桌面配置均不包含。Ubuntu env 初始化会补缺失字段并保留已有配置；Compose 已分别注入。填写后重启 API、Worker。

Kubernetes：共享 `pibot` Secret 只放开关；地址、AK/SK、environment 放独立 `pibot-langfuse` Secret（从仅含这四项的 env 文件创建），部署模板仅让 Worker 挂载它。不要把这四项写入共享 Secret。

启用 Kubernetes 追踪时，配置好 Worker 凭据后设置共享开关，并同时重启 API、Worker（Secret 环境变量不会热更新）：

```sh
kubectl -n pibot patch secret pibot --type merge -p '{"stringData":{"LANGFUSE_TRACING_ENABLED":"true"}}'
kubectl -n pibot rollout restart deployment/pibot deployment/pibot-worker
kubectl -n pibot rollout status deployment/pibot
kubectl -n pibot rollout status deployment/pibot-worker
```

升级已有集群时，先创建共享开关字段，再应用新的 Deployment 配置；停用追踪时字段值设为 `false`。两个 Deployment 都要求该字段存在，避免 Worker 的凭据 Secret 意外覆盖开关。检查两个容器中的 `LANGFUSE_TRACING_ENABLED` 均为 `true`。只重启 Worker 会产生后台维护 trace，但 API 不会采集新对话的模型及工具观测。重启本身不会更新 Deployment 模板。

原版 Pi Langfuse 插件会在执行进程直连，本项目不在客户端加载它。执行端只通过既有云端通道回传中性工具事件，模型输入输出及用量在云端代理采集，Worker 动态加载官方 `@langfuse/client`，使用 batch ingestion 将 PostgreSQL outbox 发送至实例。

用户运行建立根 trace，后台任务、跨 Bot 委托和回报继承 trace；run/generation/tool ID 建立父子关系。新的用户续接产生新 trace，并保留旧任务引用。独立记忆维护有单独 trace。费用未知时不填 0，缓存与 reasoning Token 单独保留。

工具开始记录保存在云端 receipt，完成后导出完整 span；运行中断时仍未结束的工具导出 incomplete span。重复、乱序不覆盖终态。旧客户端缺少工具事件时不推断为成功。观测数据不参与任务恢复。

云端入队前去除认证信息、已知凭据及敏感字段，输入/输出分别最多 64 KiB，二进制占位。队列使用稳定 ID、多 Worker 租约和退避，24 小时过期清理并计数，退出最多等 10 秒；Langfuse 不可用不使业务失败。

## 验证

### 普通对话首句耗时

百炼的 `qwen3.8-max`、`qwen3.8-flash` 在模型能力未填写或为 `unknown` 时使用服务端预设：普通对话请求发送 `reasoning: { effort: "none" }`。依据[阿里云 Responses API 参数说明](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-responses)。旧记录无需迁移，模型列表和目录返回有效能力，管理界面选择模型时采用相同预设。

管理员明确的 `none`、`required` 能力及 `reasoning_off` 参数保持优先；请求显式指定的思考参数也保持优先。预设只匹配百炼服务商及上述两个精确模型 ID，不作用于自定义服务商、未知模型或后台任务。任务上下文、调用轮次及输出上限不变。

模型 trace 的 `modelParameters` 仅记录允许的思考控制值；Langfuse 接口要求标量值，因此嵌套参数用 `reasoning.effort` 表示，其他控制参数保留原字段名。metadata 中 `reasoning_source` 为 `provider_preset`（内置预设）、`model_config`（管理员配置）、`request`（请求指定）或 `provider_default`（未注入参数）。检查普通对话的参数是否为 `none`，并结合 `reasoning_tokens`、`first_reply_ms`、`reply_generation_ms` 和 `reply_delivery_overhead_ms` 对比实际耗时。参数模式与用量分别记录，若服务商仍返回思考用量，应继续核查其实际支持情况；不把“发出关闭参数”视为已消除思考耗时。

需要执行工作的首轮先简短说明要核实什么，再安排任务，详细计划交给后台。沿用模型自然回复，不增加固定确认消息或强制额外模型回合。上线后用同模型的简单问答、任务创建、状态查询和任务回报检查首句是否更快、任务条件是否完整，以及有无重复回复；不承诺固定响应秒数。

### 记忆维护诊断

记忆维护失败会向 Worker 标准错误输出单行 JSON，包含 job/bot/model、失败阶段（`model`、`validate`、`usage`、`persist`）、错误和阶段耗时，不记录对话正文或密钥。数据库错误仅保留错误类型和 SQLSTATE，JSON 解析错误不包含模型输出片段。Langfuse 的维护 span 同时记录错误、`failure_phase` 和 `phase_ms`；`LLM Call` 只使用模型请求阶段的起止时间及错误，后续校验或保存失败不会再把模型调用标红。

测试使用专用数据库，会清空其 public schema：

```sh
PI_BOT_TEST_DATABASE_URL=postgresql://... npm test
npm run typecheck
npm run build
python3 -m unittest discover -s server/deploy/ubuntu -p 'test_*.py'
```

覆盖记忆隔离/墓碑/版本、摘要失败并发、跨页目录、续接幂等、代理归属检查、并行追踪、缺失/乱序工具事件、官方 SDK 的 mock 上报与失败重试。真实 Pi 在 Mac Executor 和云端 Runner 分别执行工具并检查网络目标。

真实实例验收需要有效 env：各运行一次 Mac 和云端任务，在 Langfuse 检查 generation、内部工具、Bot/run/task 元数据，再验证跨 Bot 委托及续接。凭据和对话正文不得写入诊断日志。
