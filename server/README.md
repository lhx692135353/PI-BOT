# Pi Bot server

Node.js 24 + TypeScript + Fastify 5 + PostgreSQL 16。包含 API（含管理后台 `/admin/` 和模型代理 `/llm/v1`）、Worker（Mac 离线时的云端运行、长期记忆压缩）和 Runner（隔离执行 Pi agent）。整体设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 本地开发

在仓库根目录：

```sh
npm ci
cp server/.env.example server/.env      # 改管理员口令、JWT 密钥、Runner token
node --import tsx server/scripts/vault-key.ts "$PWD/server/vault.json"   # 模型 Key 加密文件，路径填进 PI_BOT_VAULT_FILE
(cd server && docker compose up postgres -d)
npm run build                            # 构建 admin 和 server
npm run dev --workspace=@pi-bot/server   # API，默认 http://127.0.0.1:8000
```

首次启动时，如果库里还没有管理员，就用 `PI_BOT_ADMIN_USERNAME` / `PI_BOT_ADMIN_PASSWORD` 创建一个。打开 `http://127.0.0.1:8000/admin/` 登录后：

1. 「模型」添加一个支持 Responses API 的模型（Base URL、服务商模型名、API Key），例如 xAI 的 `https://api.x.ai/v1`，点「测试」确认连通；第一个模型自动成为默认模型。
2. 「用户」创建普通用户。没有注册入口。
3. 用户在 Mac 或手机上用这个账号登录。

Mac 离线时的云端回复需要 Worker 和 Runner，各开一个终端：

```sh
npm run build --workspace=@pi-bot/server
npm run runner --workspace=@pi-bot/server
npm run worker --workspace=@pi-bot/server
```

联网搜索由 API 统一代理，Mac 与云端 Runner 共用 `POST /web/search`，使用已有短期智能体令牌鉴权。只调用 Tavily SaaS（`https://api.tavily.com`），从服务端环境变量 `PI_BOT_TAVILY_API_KEY` 读取 Key；未配置时不向智能体提供搜索工具。所有环境变量见 [.env.example](.env.example)。

管理后台开发：`npm run admin:dev`（Vite 把接口代理到 `PI_BOT_SERVER`，默认 `http://127.0.0.1:8000`）。

每个 Bot 通过内置 Pi Extension 自行管理私有 skills，云端统一保存，Mac 和 Runner 按需读取。没有用户管理界面，内部操作不进入公开时间线；已有 skill 的变更保留版本并支持恢复。说明和接入契约见 [agent/README.md](../packages/agent/README.md)。启动时自动执行 `0005-bot-skills.sql`；启用私有 skills 的会话按完整模型消息推送文本，避免内部管理说明短暂出现在客户端。

## 部署

- Ubuntu 长期后端：[deploy/ubuntu/README.md](deploy/ubuntu/README.md)，从阿里云拉取镜像、在目标机生成 `.env`，支持 systemd 自动更新；不自动备份数据库。
- 单机：`cd server && docker compose up --build -d`（需要先生成 `server/vault.json`，并在环境里设置 `PI_BOT_ADMIN_PASSWORD`、`PI_BOT_JWT_SECRET`、`PI_BOT_RUNNER_TOKEN`）。
- 集群：[deploy/pibot.yaml](deploy/pibot.yaml) 是部署模板，默认 namespace 为 `pibot`、示例入口为 `https://bot.example.com/pibot`，后台 `/pibot/admin/`。应用前创建 namespace，替换域名、镜像地址、镜像拉取 Secret、存储和 Traefik 配置，修改 `pibot` Secret 中的口令，并创建 `pibot-vault` Secret（见清单顶部注释）；不要原样部署示例凭据。维护者的镜像发布工作流见 [server-image.yml](../.github/workflows/server-image.yml)，Fork 如需发布必须配置自己的镜像仓库和凭据。

联网搜索统一使用 Tavily `fast` 模式，每次消耗 1 credit；关闭自动参数升级，不请求生成答案或网页全文。Server 限制搜索为 20 秒，返回最多 8 条去重结果，对有结果的查询缓存 5 分钟。

在 [Tavily 控制台](https://app.tavily.com/) 获取 API Key，写入服务端 `.env` 的 `PI_BOT_TAVILY_API_KEY=tvly-...`，重新启动 API 和 Worker。Compose 需要重新创建容器以加载新环境变量，Kubernetes 通过 `pibot` Secret 提供。Key 只保存在服务器，不会返回给后台、Mac 或 Runner。

管理员在「用量」页查看搜索剩余 credits、套餐用量、Key 上限和同步时间，也可调用 `GET /admin/api/search/usage`。通过 [Tavily Usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage) 最多每分钟同步一次；成功搜索后在本进程扣减，并为进行中的搜索预留 credit。可用额度取账号套餐剩余额度与当前 Key 剩余额度的较小值（Key 未单独设限时仅使用套餐额度），不使用 pay-as-you-go 额度。达到上限时 `/web/search` 返回 HTTP 402、`detail: "搜索额度到了"`，包括已有缓存的查询；Tavily 的 432/433 响应也映射为同一错误。工具提示模型停止重试或创建重复任务。用量查询失败或搜索连接中断导致余额不确定时暂停新搜索，直到下一次成功同步；后台显示查询失败，不把未知额度当作零；429 限流、无效 Key 与额度耗尽分别提示。额度恢复后在下一次同步时恢复搜索。

用量是按分钟同步的快照；同一账号或 Key 在其他应用消耗额度时，可能在下一次同步或 Tavily 拒绝请求后才反映。本地计数只负责本服务的预留和扣减，账号总账以 Tavily 为准。旧版 SearXNG 环境变量不再使用；Compose 升级会移除旧搜索容器但保留卷，Kubernetes 迁移时可另行删除旧 `pibot-searxng` Deployment、Service 和 ConfigMap。


API 只能单副本：Mac 的长连接、在线状态和资料库 RPC 都在进程内存里。Worker 可以多副本。Runner 只供 Worker 在内网调用。生产入口必须是 HTTPS/WSS。

## 检查

```sh
npm run typecheck                                   # 仓库根目录，覆盖 server/admin/desktop/packages
PI_BOT_TEST_DATABASE_URL=postgresql://pibot:pibot@127.0.0.1:5432/pibot npm test
```

集成测试会清空测试库，请用专门的数据库。接口契约导出在 `openapi.json`，修改路由后运行 `npm run openapi --workspace=@pi-bot/server`。

模型调用统一使用 Responses API：Mac 与 Runner 通过 `POST /llm/v1/responses`，连通性测试和记忆摘要直接调用服务商 `/responses`。Base URL 填到 `/v1`，不含 `/responses`；模型必须支持此协议。请求使用 `input`、`max_output_tokens`，工具使用 `function_call` / `function_call_output`，流式用量从终止事件的 `response.usage` 读取。历史由客户端发送，代理强制 `store: false`。升级时需同步更新 API、Worker、Runner 和 Mac 客户端。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。两端需与 API、Worker、Runner 同步升级，服务端自动应用 `0007-async-tasks`；升级前结束旧运行。详情见 [整体架构](ARCHITECTURE.md)。

记忆、协作目录、任务续接与云端 Langfuse 配置见[实现说明](MEMORY-OBSERVABILITY.md)。


## 长期委托与自主巡检

全部 Bot 默认具备自主巡检，空闲时逐步降低检查频率，最多六小时检查一次。自动工作只在登录且保持运行的 Mac 上执行；Mac 离线、退出应用或休眠时等待，重连后合并检查。云端仍可接受聊天、保存和管理计划。

直接在聊天中使用：

- “每十分钟检查一下这个任务，有重要变化再告诉我。”
- “每天上午九点整理一次，按上海时间。”
- “现在有哪些自动工作？最近检查出了什么？”
- “暂停自主巡检。” / “恢复自主巡检，每两小时一次。”
- “停止这个长期委托。” / “停止全部自动工作。”

无重要变化不发消息。重要成果、风险和需要决策的事项在原时间线另发；同一状态不重复回报。普通巡检只读自己的资料，不会擅自修改文件或执行命令；明确委托沿用原有权限，资料库外访问仍需审批。中断时操作结果无法确认会暂停并请你核实。

首次升级需同步更新 API、Worker、Runner 和 Mac，服务端自动应用 `0009-always-on`；旧 Mac 不启动自动轮次。Android 无需新增配置，不提供系统后台推送。
