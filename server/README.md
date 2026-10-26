# Pi Bot server

Node.js 24 + TypeScript + Fastify 5 + PostgreSQL 16。包含 API（含管理后台 `/admin/` 和模型代理 `/llm/v1`）、Worker（执行电脑离线时的云端运行、长期记忆压缩）和 Runner（隔离执行 Pi agent）。整体设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

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
3. 用户在执行电脑或手机上用这个账号登录。

执行电脑离线时的云端回复需要 Worker 和 Runner，各开一个终端：

```sh
npm run build --workspace=@pi-bot/server
npm run runner --workspace=@pi-bot/server
npm run worker --workspace=@pi-bot/server
```

联网搜索由 API 统一代理，执行电脑与云端 Runner 共用 `POST /web/search`，使用已有短期智能体令牌鉴权。只调用 Tavily SaaS（`https://api.tavily.com`），从服务端环境变量 `PI_BOT_TAVILY_API_KEY` 读取 Key；未配置时不向智能体提供搜索工具。所有环境变量见 [.env.example](.env.example)。

管理后台开发：`npm run admin:dev`（Vite 把接口代理到 `PI_BOT_SERVER`，默认 `http://127.0.0.1:8000`）。

每个 Bot 通过内置 Pi Extension 自行管理私有 skills，云端统一保存，执行电脑和 Runner 按需读取。没有用户管理界面，内部操作不进入公开时间线；已有 skill 的变更保留版本并支持恢复。说明和接入契约见 [agent/README.md](../packages/agent/README.md)。启动时自动执行 `0005-bot-skills.sql`；启用私有 skills 的会话按完整模型消息推送文本，避免内部管理说明短暂出现在客户端。

## 执行电脑与绑定

同一账号可同时登录多台 Linux/Mac 电脑，每个 Bot 选择一台执行电脑。`GET /devices` 列出设备，`POST /devices/:id/revoke` 只解绑指定设备；创建和编辑 Bot 时通过 `execution_device_id` 选择目标。旧 Bot 升级后保留原电脑绑定。聊天、记忆和 skills 保存在服务端，文件留在各自电脑。

绑定电脑离线时，聊天和显式选择云端的联网任务继续执行；本地任务与目标检查等待原电脑，不会转移到其他设备。重连后恢复尚未开始的任务，已中断的运行标记失败，需核实结果后重新安排。更换绑定前需结束所有未完成任务；更换后目标检查暂停，文件不迁移。Linux 安装步骤见 [desktop/LINUX.md](../desktop/LINUX.md)。

## 部署

- Ubuntu 长期后端：[deploy/ubuntu/README.md](deploy/ubuntu/README.md)，从阿里云拉取镜像、在目标机生成 `.env`，支持 systemd 自动更新；不自动备份数据库。
- 单机：`cd server && docker compose up --build -d`（需要先生成 `server/vault.json`，并在环境里设置 `PI_BOT_ADMIN_PASSWORD`、`PI_BOT_JWT_SECRET`、`PI_BOT_RUNNER_TOKEN`）。
- 集群：[deploy/pibot.yaml](deploy/pibot.yaml) 是部署模板，默认 namespace 为 `pibot`、示例入口为 `https://bot.example.com/pibot`，后台 `/pibot/admin/`。应用前创建 namespace，替换域名、镜像地址、镜像拉取 Secret、存储和 Traefik 配置，修改 `pibot` Secret 中的口令，并创建 `pibot-vault` Secret（见清单顶部注释）；不要原样部署示例凭据。维护者的镜像发布工作流见 [server-image.yml](../.github/workflows/server-image.yml)，Fork 如需发布必须配置自己的镜像仓库和凭据。

联网搜索统一使用 Tavily `fast` 模式，每次消耗 1 credit；关闭自动参数升级，不请求生成答案或网页全文。Server 限制搜索为 20 秒，返回最多 8 条去重结果，对有结果的查询缓存 5 分钟。

在 [Tavily 控制台](https://app.tavily.com/) 获取 API Key，写入服务端 `.env` 的 `PI_BOT_TAVILY_API_KEY=tvly-...`，重新启动 API 和 Worker。Compose 需要重新创建容器以加载新环境变量，Kubernetes 通过 `pibot` Secret 提供。Key 只保存在服务器，不会返回给后台、执行电脑或 Runner。

管理员在「用量」页查看搜索剩余 credits、套餐用量、Key 上限和同步时间，也可调用 `GET /admin/api/search/usage`。通过 [Tavily Usage API](https://docs.tavily.com/documentation/api-reference/endpoint/usage) 最多每分钟同步一次；成功搜索后在本进程扣减，并为进行中的搜索预留 credit。可用额度取账号套餐剩余额度与当前 Key 剩余额度的较小值（Key 未单独设限时仅使用套餐额度），不使用 pay-as-you-go 额度。达到上限时 `/web/search` 返回 HTTP 402、`detail: "搜索额度到了"`，包括已有缓存的查询；Tavily 的 432/433 响应也映射为同一错误。工具提示模型停止重试或创建重复任务。用量查询失败或搜索连接中断导致余额不确定时暂停新搜索，直到下一次成功同步；后台显示查询失败，不把未知额度当作零；429 限流、无效 Key 与额度耗尽分别提示。额度恢复后在下一次同步时恢复搜索。

用量是按分钟同步的快照；同一账号或 Key 在其他应用消耗额度时，可能在下一次同步或 Tavily 拒绝请求后才反映。本地计数只负责本服务的预留和扣减，账号总账以 Tavily 为准。旧版 SearXNG 环境变量不再使用；Compose 升级会移除旧搜索容器但保留卷，Kubernetes 迁移时可另行删除旧 `pibot-searxng` Deployment、Service 和 ConfigMap。


API 只能单副本：执行电脑的长连接、在线状态和资料库 RPC 都在进程内存里。Worker 可以多副本。Runner 只供 Worker 在内网调用。生产入口必须是 HTTPS/WSS。

## 检查

```sh
npm run typecheck                                   # 仓库根目录，覆盖 server/admin/desktop/packages
PI_BOT_TEST_DATABASE_URL=postgresql://pibot:pibot@127.0.0.1:5432/pibot npm test
```

集成测试会清空测试库，请用专门的数据库。接口契约导出在 `openapi.json`，修改路由后运行 `npm run openapi --workspace=@pi-bot/server`。

模型调用统一使用 Responses API：执行电脑与 Runner 通过 `POST /llm/v1/responses`，连通性测试和记忆摘要直接调用服务商 `/responses`。Base URL 填到 `/v1`，不含 `/responses`；模型必须支持此协议。请求使用 `input`、`max_output_tokens`，工具使用 `function_call` / `function_call_output`，流式用量从终止事件的 `response.usage` 读取。历史由客户端发送，代理强制 `store: false`。升级时需同步更新 API、Worker、Runner 和执行电脑客户端。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。各客户端需与 API、Worker、Runner 同步升级，服务端自动应用数据库迁移；升级前结束旧运行。详情见 [整体架构](ARCHITECTURE.md)。

记忆、协作目录、任务续接与云端 Langfuse 配置见[实现说明](MEMORY-OBSERVABILITY.md)。


## 目标

没有进行中的目标时不会自动检查。有目标时，空闲会把检查间隔逐步拉长，最多六小时一次。目标检查只在 Bot 绑定且保持运行的 Linux 或 Mac 电脑上执行；该电脑离线、退出应用或休眠时等待，重连后合并检查。云端仍可接受聊天、保存和管理目标。

直接在聊天中使用：

- “我的目标是把周报写进资料库，有进展再告诉我。”
- “现在有哪些目标？最近推进了什么？”
- “暂停这个目标。” / “恢复目标检查。”
- “这个目标完成了。” / “停止全部目标。”

没有新进展不发消息。某个目标有新进展时，在原时间线发一条；同一状态不重复发。检查可以在该目标写明的授权范围内改文件或跑命令，资料库外访问仍需审批。不能自己新增目标，也不能把工作交给其他智能体。中断时操作结果无法确认会暂停并请你核实。

升级需同步更新 API、Worker、Runner、Linux/Mac 客户端和 Android。服务端自动应用 `0010-multi-device`，保留已有电脑绑定、聊天和记忆；升级前备份数据库与 vault 并结束运行。旧客户端协议不兼容本版本。Android 不提供系统后台推送。


## 云端机器操作

默认关闭。`PI_BOT_REMOTE_BACKEND=ssh` 时，在用户后台配置每用户唯一的 SSH 虚机；`kubevirt` 时按照启动配置自动创建并复用每用户一台 VM。首版支持 Ubuntu 24.04 LTS amd64，包含文件／命令、浏览器、截图、桌面控制及人工接管。凭据保存在 API，Runner 通过当前任务授权调用。

部署前请阅读 [云端环境部署与验收](deploy/remote/README.md)，包含 SSH 安装示例、KubeVirt 标准镜像构建、RBAC／VM 模板、启动配置及测试清单。API、Worker、Runner 和两端客户端需同步升级；文件不在电脑和云端之间自动同步。
