# Pi Bot 整体架构

> 本文在 `desktop/`、`server/`、`android/` 三处内容一致，修改时三份一起改。各端的具体需求在各自的 `REQUIREMENTS.md`。

Pi Bot 是多用户的个人 Bot 平台。每个用户有若干个 Bot，每个 Bot 有名字、人设、形象和一条连续的时间线；用户的 macOS 或 Linux 是 Bot 干活的电脑（harness），手机用来随时和 Bot 说话、批准请求、看 Bot 的资料库。

```
                         ┌──────────────── Pi Bot 云端（单副本 API） ─────────────────┐
  浏览器 ── /admin ─────▶│ Fastify API                                                │
  （管理员）              │   REST：/auth /me /bots /runs /approvals /models ...      │
                         │   /admin/api   用户、模型、设备、用量                       │
  Android ── HTTPS ─────▶│   /ws/events   给手机推送变更（用户令牌）                   │
          ◀── WSS ───────│   /ws/device  电脑的长连接（设备签名）                     │
                         │   /llm/v1      Responses API 兼容模型代理（短期令牌）              │
 电脑───── 签名 HTTPS ─▶│   内存 Hub：在线 电脑、事件订阅、文件 RPC                    │
      ◀──── WSS ─────────│                                                           │
                         │ Worker ── Runner（电脑 离线时在云端运行，对话、搜索、委托）   │
                         │ PostgreSQL 16（LISTEN/NOTIFY pibot_changes）               │
                         └──────────────────────────┬────────────────────────────────┘
                                                    │ 服务商 API Key 只在这里
                                                    ▼
                                         Responses API 兼容的模型服务
```

## 概念

| 概念 | 说明 |
|---|---|
| 用户 | 管理员在后台创建，没有注册入口。角色为 `admin` 或 `user`，可被禁用 |
|电脑设备 | 每个用户可以同时绑定多台 macOS / Linux 电脑。登录生成 Ed25519 密钥，每个 Bot 用 execution_device_id 选择一台，新绑定不吊销其他设备 |
| Bot | 属于一个用户：名字、人设、模型（为空则跟随默认模型）、形象（造型/颜色/深浅色）、资料库 `slug`。改名不改 `slug`；归档不删电脑上的文件 |
| 主智能体 | 每个用户自动拥有一个 Pi Bot，使用默认橙色小人头像和默认模型，带星标置顶，不能归档；普通 Bot 和已有历史继续保留 |
| 时间线 | 每个 Bot 一条，消息按 `seq` 递增。没有「会话」或「项目」 |
| 运行（run） | 一条用户消息触发一次运行，执行者是 `device` 或 `cloud`。每个 Bot 一个对话调度通道、最多两个同时执行的后台任务；超出的任务排队 |
| 协作 | 一个 Bot 在运行中用 `ask_agent` 把任务委托给同一用户的另一个 Bot（`agent_tasks`）；委托作为目标 Bot 的私有后台运行执行，对话通道异步转交，后台任务可以同步等结果 |
| 长期记忆 | 时间线超过阈值后，Worker 把较早的消息压缩成摘要（`bot_memories`），运行时作为系统提示的一部分 |
| 审批 |电脑上的 Bot 想访问资料库以外的路径时创建，用户在电脑或手机上批准/拒绝，默认 15 分钟过期 |
| 模型 | 管理员配置 xAI 或百炼（地址由服务商确定，模型与上下文、输出上限可从服务商列表选择），也可填写自定义 Responses API。语音模型单独选择，不选则不开通语音。其中一个是默认模型 |

## 组成

| 目录 | 内容 |
|---|---|
| `server/` | Fastify API、Worker、Runner、数据库迁移、部署清单 |
| `admin/` | 管理后台（Vite + React），构建后由 API 在 `/admin/` 提供 |
| `desktop/` | Pi Bot for macOS / Linux：Electron + 本地服务 + React UI |
| `android/` | Pi Bot Android：Kotlin + Jetpack Compose |
| `packages/agent` | 基于 Pi SDK 的 Bot agent（`createBotAgent`），电脑 和云端 Runner 共用 |
| `packages/bot-face` | 角色规格 `spec.json`、动画引擎、Canvas 渲染器；Android 有一份 Compose 移植 |
| `boards/` | ESP32 桌面小屏，跟随电脑上 Bot 的表情 |

## 云端

### 进程

- **API**（`server/src/main.ts`）：REST、WebSocket、模型代理、管理后台静态文件。**必须单副本**：电脑 的 `/ws/device` 连接、在线状态和文件 RPC 都在进程内存里（`hub.ts`）。数据库变更通过 `NOTIFY pibot_changes` 广播，API 收到后推送给该用户的订阅者。
- **Worker**（`server/src/worker.ts`）：认领 `executor='cloud'` 的运行，签发代理令牌后交给 Runner 执行；每个 Worker 提供 `PI_BOT_WORKER_CONCURRENCY`（默认 4）个后台名额和独立的 `PI_BOT_CONVERSATION_CONCURRENCY`（默认 4）个对话名额；同步等待的父运行释放后台名额，取得名额后才恢复；带租约，Worker 崩溃后超时的运行标为失败。同时负责长期记忆压缩。
- **Runner**（`server/src/runner.ts`）：无数据库、无 vault，只接受带 `PI_BOT_RUNNER_TOKEN` 的请求，用 `createBotAgent` 跑一次运行；工具只有 `web_search`（API 配置了 Tavily Key 时）和 `ask_agent`（可以委托时），都通过短期智能体令牌调用 API（`/web/search`、`/agent/tasks`），不接触搜索来源密钥。容器只读根文件系统、去掉全部 capabilities。

### 数据

基线迁移 `server/migrations/0001-baseline.sql`：`users`、`devices`、`device_nonces`、`models`、`bots`、`bot_runs`、`bot_messages`、`bot_memories`、`approvals`、`usage_logs`。`0004-agent-tasks.sql` 增加 `agent_tasks`，以及 `bot_runs.origin`（`user` / `agent` / `report`）、`bot_runs.task_id` 和 `bot_messages.from_bot_id`（这条用户消息由哪个 Bot 写入）。模型 API Key 用 vault 文件（`PI_BOT_VAULT_FILE`，`scripts/vault-key.ts` 生成，可轮换）加密后入库。

### 鉴权

| 模式 | 凭据 | 用于 |
|---|---|---|
| `user` | `Authorization: Bearer <JWT>`，默认 7 天 | 手机、管理后台 |
| `admin` | 同上，且角色为 `admin` | `/admin/api/*` |
| `device` | Ed25519 签名头 `x-pibot-device-id / timestamp / nonce / signature` |电脑|
| `actor` | `user` 或 `device` 任一 | Bot、消息、审批等电脑和手机共用的接口 |
| `llm` | 模型代理令牌（JWT，`src=device` 或 `cloud`） | `/llm/v1/*` |

设备签名内容为 `${ts}.${nonce}.${METHOD}.${path}.${sha256(body)}`，时间偏差 ≤300 秒，nonce 不可重放。用户被禁用或设备被吊销后，相应请求立即 401，WebSocket 以 4401 关闭。

### 模型代理

`/llm/v1/responses` 采用 Responses API（`input` / `output`、`max_output_tokens`）。请求里的 `model` 是 Pi Bot 模型 ID，代理换成服务商模型名、注入服务商 API Key 后转发，流式透传，并从 `response.completed.response.usage` 解析 token 用量写入 `usage_logs`。电脑 用 `POST /device/llm-token` 换取令牌（默认 15 分钟，运行中每 10 分钟刷新）；Worker 为每次云端运行签发覆盖运行时长的令牌。用户令牌不能调用代理，客户端永远拿不到服务商地址和 Key。

### 实时事件

- `/ws/events?token=`：连接后先收到 `{type:'hello', mac_online}`，之后是 `{type:'event', event}`，`event.type` 为 `delta`（流式文本）、`bot`（某个 Bot 变了，重新拉详情）、`bots`（列表变了）、`presence`（电脑 上下线）。
- `/ws/device`：握手带设备签名。云端下发 `run`、`cancel`、`task_message`、`approval`、`approval_created`、`rpc`，以及与手机相同的变更事件；电脑 回传 `run_event` 和 `rpc_result`。同一设备的新连接会以 4409 关闭自己的旧连接，其他设备不受影响。

## 运行路由

用户发消息（`POST /bots/:id/messages`，带 `request_id` 幂等）时，API 在同一事务里写入用户消息、空的助手消息和运行：

- **电脑 在线**：`executor='device'`，事务提交后经 `/ws/device` 下发 `run`，内容包括 Bot 信息、模型、系统提示（人设 + 长期记忆 + 资料库位置）、最近的历史和本条消息。如果下发时电脑刚好掉线，尚未开始的对话改为云端执行。
- **电脑 离线**：`executor='cloud'`，Worker 认领后交给 Runner。系统提示会告诉模型电脑离线、看不到资料库。

电脑 回传的 `run_event`：`started`、`instruction_ack`、`text`（完整文本，API 每秒最多落库一次并推送 `delta`）、`progress`（最多三句简短进度）、`tool`（工具名、状态、一行摘要）、`approval`、`done`。

`0002-message-progress.sql` 为消息增加 `progress` 数组。发送消息时先保存一句简短回应，随发送结果立即返回；Agent 生成具体开场后替换这句回应，将工具调用前的自然语言说明与最终回答分开；电脑 和云端都保存进度并通知客户端刷新。聊天页隐藏工具执行标签，在回答上方保留开头及关键转折的两三句进度，工具记录继续用于运行状态和角色表情。

- **取消**：通过聊天中的 `cancel_task` 精确取消任务或全部任务；两端输入框始终保留发送按钮。底层仍保留 `POST /runs/:id/cancel`。电脑 运行转发 `cancel` 给 电脑；排队中的云端运行直接取消，执行中的由 Worker 检测后中止 Runner。
- **电脑 中途掉线**：已开始的本机运行标为失败，排队对话转到云端，保留已生成的文本，提示「电脑 已离线，可重新发送（将在云端运行）」。API 重启后，残留的电脑运行同样标为失败。
- **审批**：电脑 发 `approval` → API 创建审批、运行变为 `waiting_approval`、回 `approval_created` → 用户 `POST /approvals/:id` → API 把决定下发给电脑→ 运行继续。过期或重复决定返回 409。
- **资料库浏览**：`GET /bots/:id/files?path=`、`/files/content?path=` 经 `rpc` 转给 电脑，电脑 离线返回 503，超时返回 504。

## 异步对话与后台任务

每个 Bot 有一个对话调度通道和独立的后台执行器，全部使用同一套 Pi SDK。对话只回答、安排任务和整理结果；搜索、文件操作、命令与复杂工作在独立任务会话里完成。用户消息持久化后立即接受，运行期间继续发送不返回忙碌 409。用户回合优先于内部回报；对话回合最长 10 分钟，模型请求和无响应检测也使用 10 分钟超时，模型异常不会无限占住入口。

`0007-async-tasks.sql` 为 `bot_runs` 增加 `lane`（`conversation` / `task`）和 `waiting_on_task_id`，用仅约束正在执行的对话的唯一索引替换旧的单运行索引。数据库在 Bot 锁内统一认领，电脑 与多副本 Worker 共用每 Bot 两个后台名额。`agent_tasks.kind` 区分 `background`（自己的任务，深度 0）与 `delegation`；任务不依附于一次短对话的存活时间。

对话工具均即时返回，不等待工作完成：

| 工具 | 行为 |
|---|---|
| `start_task({title, task})` | 自包含描述和相关上下文；返回任务 ID；同一工具调用幂等 |
| `task_status({task_id?})` | 查询本 Bot 发起或执行的任务；返回状态、最近活动、更新时间和已完成结果；不代表外部服务的实时进度 |
| `task_message({task_id, text})` | 持久化补充指令；排队时进入初始提示，运行中经电脑`task_message` 或 Runner `/runs/:id/messages` 送入 Pi `steer`，当前工具完成后生效；终态返回 `finished`，由对话建立后续任务 |
| `cancel_task({task_id?, all?})` | 用户明确要求时取消指定任务或全部任务；指代不清且有多个任务时先澄清 |

以上工具扩展内部 `/agent/tasks` 系列接口。创建和补充使用调用 ID 去重；电脑 确认 `instruction_ack` 后标为已送达，Runner 用指令 ID 去重并确认；失败的传输由 dispatcher 重试。令牌校验用户、Bot、执行端与设备，只有相关 Bot 能读取和操作任务。

后台的消息范围为 `task`，回报输入为 `internal`，普通聊天和最终回报为 `public`。消息分页、列表预览、模型公开对话历史、记忆压缩只选公开消息；内部记录不广播 `delta`。任务结束后持久化 `report_run_id` 与幂等 `report:<task_id>` 运行，在时间线末尾新增整理后的结果；内部回报不伪装成用户消息，最终 A2UI 随公开结果发布。恢复 dispatcher 不会重复创建回报。

跨 Bot 的 `ask_agent` 保留：对话通道强制异步；后台可同步委托。委托链最多两层、禁止循环和互相等待，每次运行最多五个任务；自己的后台任务不增加委托深度。等待父运行释放名额，依赖完成后重新取得 Bot 和 Worker 名额才返回工具结果。只有明确取消任务才级联取消其子任务；对话失败不会取消已交出的工作。

同一资料库的 `write_file`、`edit_file`、`run_command` 共用可取消的 FIFO 锁；审批不持锁。运行仍各自持有沙箱和批准范围。电脑 已开始的工作中断后标为失败并回报，不自动重放可能有副作用的操作；云端仍不具备本机文件和命令能力。

两端使用 `active_tasks` 和 `activity` 聚合活动，而非仅看 `latest_run`。界面保留自然语言开场、另发的结果和小人旁一句状态，多任务显示数量，不增加任务面板；其他任务运行不禁用已完成消息的 A2UI。用户随时可以聊天查询、补充或取消。

## 私有 skills

平台通过内置 Pi Extension 为每个 Bot 注册 `skill_manage` 和 `skill_load`。`buildContext` 只传该 Bot 已启用 skill 的名称、描述、版本，模型按需读取正文和参考资料。云端数据库是唯一持久存储，电脑 与 Runner 共用内部 `POST /agent/skills`；接口验证智能体令牌和当前运行的用户、Bot、执行端、设备、状态，不接受模型传入的 Bot 身份，不提供用户管理界面，也不进入公开 OpenAPI。

`0005-bot-skills.sql` 增加当前 skill 与版本快照表，支持创建、更新、启停、软删除与恢复，写操作校验 `expected_version`。智能体只沉淀经过验证的可复用工作方法，偏好和对话事实继续走长期记忆。第一版提供说明与参考资料，不安装或执行代码，不扩大现有权限。电脑 和 Runner 的 Pi 状态目录按 `bot_id` 分开；skills 不存进资料库。

内部工具事件、工具调用前的管理说明不进入公开时间线；agent 层先缓存完整模型消息并分类，含内部工具的消息不推送，其他消息完成后推送。启用私有 skills 的会话不逐 token 推送，任务状态、普通进度和最终回答照常展示。详细约束与测试见 [agent/README.md](../packages/agent/README.md)。

## 电脑端

```
┌──────────── Electron (Pi Bot.app) ────────────┐
│ UI (React + @pi-bot/bot-face)                 │
│   │ window.agent.call / subscribe             │
│ main.ts ── Unix socket RPC (IPC token) ──┐    │
└──────────────────────────────────────────┼────┘
                                           ▼
┌──────── 本地服务 (packages/service) ───────────┐
│ Application  账号、设备身份、CloudSocket         │──WSS──▶ /ws/device
│ Executor     每个 run 一个 Pi agent            │──HTTPS─▶ /llm/v1/responses
│ library.ts   资料库沙箱与工具                   │
└──────────────────── ~/pi-bot/<slug>/ ─────────┘
```

- **Electron 主进程**（`apps/desktop/src/main.ts`）：窗口、菜单、在系统文件管理器中打开资料库。打包应用里由它拉起本地服务，开发时由 `scripts/dev.mjs` 单独拉起。主进程只转发 RPC，不持有令牌。
- **本地服务**（`packages/service/src/server.ts`）：`/tmp/pi-bot-<uid>-<hash>/service.sock` 上的 JSON 行协议，先用数据目录里的 `ipc-token` 认证。方法和事件类型在 `packages/protocol`。
- **登录**：`POST /auth/login` 拿用户令牌 → 本地生成 Ed25519 密钥 → `POST /devices/register` 绑定 → 丢弃用户令牌。之后所有云端请求都用设备签名，电脑 和手机调用同一套 `actor` 接口。macOS 发行版私钥在钥匙串（`dev.pi-bot.device`），Linux 和开发模式下在 0600 的 `secrets.json`。收到 401 或 4401 进入 `revoked`，需要重新登录；4409 后至少等 5 秒再重连。
- **Executor**：`libraryDir(root, slug)` 创建资料库（拒绝符号链接作资料库本身）→ `createBotAgent` 用历史作种子建立内存会话，工具来自 `libraryTools(new Sandbox(dir))` → 回传 `run_event`（文本 150ms 节流）。取消时中止 agent 并结束命令的整个进程组。
- **工具**：`list_files`、`read_file`、`search_files`、`write_file`、`edit_file`、`run_command`（macOS 使用 zsh，Linux 使用 bash，默认 2 分钟超时，输出保留尾部 30KB）、`request_outside_access`，以及可选的 `web_search`、`ask_agent`。
- **沙箱**：`Sandbox` 维护允许的根目录（初始只有资料库）。路径展开 `~`、相对路径以资料库为基准，再对最近的已存在祖先取 realpath，符号链接和尚未创建的文件都逃不出允许的根。`request_outside_access` 批准后只对当前运行有效；拒绝授权 `/` 和整个家目录。`run_command` 只限制工作目录，命令本身不做隔离。
- **文件预览**：`files.list` / `files.read` RPC 只读资料库内的内容（文本 ≤512KB，图片 ≤4MB）。
- **本地事件**：`account`、`bots` / `bot` / `delta`（云端转发）、`activity` 与 `bot.mood`（本机正在执行的工具和表情，`boards/` 的桥接程序也订阅它）。
- **本地存储**：没有数据库。`account.json` 存服务器地址、用户、设备 ID 和设备名；消息、记忆、审批都在云端。

## Android 端

- 单 Activity + Compose Navigation：登录、Bot 网格、新建/编辑 Bot、时间线、资料库浏览、设置。
- `PiBotApi`（OkHttp + kotlinx.serialization）调用与电脑相同的 REST 接口；`PiBotRepository` 用 StateFlow 保存会话、Bot 列表、电脑 状态和各 Bot 的时间线，没有本地数据库。
- 应用在前台时连接 `/ws/events`：`delta` 直接合并进时间线，`bot` 事件 200ms 内合并成一次刷新，断线按 1、2、4…30 秒退避重连，重连后补拉列表和已打开的时间线；4401 或 401 退出登录。
- 会话（服务器地址、用户、令牌）存在 EncryptedSharedPreferences。Android 的 debug 和 release 均支持 HTTP、HTTPS 服务器地址，实时连接相应使用 WS、WSS。
- 消息按 `seq` 分页（每页 50 条），滚到顶部加载更早的消息。

## 角色

`packages/bot-face/spec.json` 是唯一的角色规格：8 种造型、10 种颜色（浅/深两套渐变）、9 种表情（待命、开心、思考、工作、搜索、等待、庆祝、出错、睡觉）。

- `engine.ts`：与绘制无关的状态机（弹簧、眨眼、视线、`bounce` / `burst` / `spin`、粒子），用 Mulberry32 随机数，可在 Node 里测试；尊重「减少动态效果」。
- `render.ts`：Canvas 2D 渲染，`react.tsx` 提供 `<BotFace>`，电脑端和管理后台使用。
- `status.ts`：运行状态 → 表情。运行中按工具区分思考/搜索/工作，等待审批为 `waiting`，刚完成或失败短暂庆祝/出错，3 天无活动睡觉并显示天数。
- Android 的 `face/` 是逐行移植：构建时把 `spec.json` 复制进 assets，单元测试用同一份规格和同一组随机数参考值校验两端一致。

## 部署

- 本地完整栈：`server/docker-compose.yml`（Postgres、API、Worker、Runner）。
- 集群：`server/deploy/pibot.yaml`（示例命名空间 `pibot`，入口 `https://bot.example.com/pibot`，管理后台在 `/pibot/admin/`）。镜像 `registry.cn-beijing.aliyuncs.com/liuhx/pi-bot-server`。需要先创建 `pibot` 与 `pibot-vault` 两个 Secret。
- API 单副本；Worker 可多副本（`FOR UPDATE SKIP LOCKED` 认领）；Runner 只在内网可达。

## 验收

1. 管理员用环境变量里的口令登录后台，创建用户、添加模型并测试连通；普通用户访问后台接口返回 403，看不到模型地址和 Key。
2. 用户在电脑登录，新建 Bot，`~/pi-bot/<slug>/` 出现；让 Bot 写文件，文件管理器和手机资料库里都能看到。
3. Bot 申请访问 `~/Desktop`：手机和电脑都出现审批卡片，任一端批准后运行继续，下一次运行需要重新申请。
4.电脑退出后，手机发消息由云端回复（无资料库、可联网搜索）；运行中的电脑掉线时该运行失败并提示可重发。
5. 时间线超过阈值后长期记忆生效，较早提过的事情仍能被回答。
6. 两个用户的 Bot、消息、文件、审批、电脑 在线状态互不可见。
7. 管理员禁用用户或吊销设备后，对应客户端立即被登出。
8. 让 Pi Bot 把周报交给「写作助手」：同步委托时 Pi Bot 在同一次回复里给出结果；`wait=false` 时 Pi Bot 先说已转交，写作助手完成后 Pi Bot 的时间线出现回报并自动转告。写作助手的时间线里能看到「来自 Pi Bot 的委托」。

联网搜索：电脑 与云端共享 `packages/agent/src/web-search.ts` 的 `web_search` 工具。API `/web/search` 校验已有短期智能体令牌，再以环境变量 `PI_BOT_TAVILY_API_KEY` 调用 Tavily SaaS，固定 `fast` 模式（1 credit）；未配置 Key 时不注册工具。API 对成功查询缓存 5 分钟，最多返回 8 条去重结果。`GET /admin/api/search/usage` 仅管理员可调用，后台「用量」页展示剩余 credits；Tavily 用量最多每分钟同步一次，本进程预留并扣减搜索额度。额度取套餐与 Key 剩余额度的较小值，不使用按量付费额度；耗尽返回 402「搜索额度到了」，用量未知时暂停搜索。

## A2UI 交互工具

Agent 可以通过 `get_ui_catalog` 查询组件 / 函数，并用 `show_ui` 在回复中创建、更新或删除 A2UI surface。电脑 执行器用 `run_event(kind=ui)` 回传消息；云端 Runner 用 NDJSON `type=ui` 回传，Worker 执行相同验证和保存。`packages/a2ui` 是两端共享的目录和实现，采用 v0.9 协议与官方 React 渲染器。

`bot_messages.ui` 保存组件和数据的有界快照，不存无限增长的重放日志。组件引用、类型、数据深度、尺寸、展开数量和计算函数均受验证。电脑 时间线直接渲染；Android 加载 APK 内固定的同一渲染器，WebView 禁止外部页面、文件与通用原生访问，桥接不包含账号凭据。

`POST /bots/:id/messages/:messageId/ui-state` 按 revision 保存输入；冲突返回 409。`POST /bots/:id/messages/:messageId/ui-actions` 验证已发布按钮与表单校验，从当前数据重新解析操作参数，再通过原有消息 / 任务路径交给 Bot，request_id 保证重试幂等。跨端更新沿用已有 bot 事件，客户端重新加载消息。

可读的操作描述展示在聊天中；完整操作保存在 `ui_action`，只注入 Agent 上下文。动作不会绕过文件 / 命令审批。表单、计算、图表、表格和布局由目录里的可信组件 / 函数组合，Agent 不生成可执行页面代码。

## 异步模式升级

先结束旧运行，停止旧 API/Worker/Runner，再更新 API、Worker、Runner、电脑 与 Android；启动时自动应用 `0007-async-tasks`。不要让旧执行器连接新调度器。部署过程与回滚前先确认无活动任务；旧版本的单运行索引不兼容并行数据。数据库是队列、状态、补充指令和回报的持久来源，原有历史保持公开。


## 目标检查

`0009-always-on` 增加检查循环、轮次、副作用日志和待回报。`0013-goals` 用 `bot_goals` 替换自主巡检和长期委托：已有委托变成目标并保留检查点，巡检不变成目标。没有进行中的目标时不自动检查。每个智能体最多一条检查循环，状态和进度保存在云端 PostgreSQL，执行只在绑定电脑。

- API 的 `AgentDispatcher` 每次调度同时处理到期的目标检查；数据库变更和电脑能力声明加速调度，五秒扫描兜底。没有按目标单独定时。空闲时从一小时开始，无新进展依次退避至二、四、六小时；用户输入和普通任务完成会合并成大约一分钟后的检查，检查自身不唤醒自己。
- 每条检查循环最多一个活动轮次，事务认领、唤醒代数和唯一索引防重；离线或停机期间错过的检查合并成一次。检查沿用 `task` 通道与每 Bot 两个后台名额，用户工作优先。电脑通过 `capabilities` 声明 `always-on-v1`。旧电脑不接收检查；电脑离线时等待，不产生云端运行。`execution_policy=device_only` 使 Worker 和 Runner 拒绝这次检查。
- 对话和语音工具 `goal_manage` 建立、查询、修改、暂停、恢复、完成和停止目标；只允许真实用户对话调用。检查轮次用 `goal_finish` 为每一个进行中的目标提交状态，普通输出不能代替。控制版本防止暂停、修改或停止后旧结果重新生效。
- 检查可以在该目标的授权范围内改文件和跑命令，沿用资料库沙箱与外部路径审批。不能自行新建目标，也不能把工作交给其他智能体。
- 文件写入、编辑和命令执行前，通过 `/agent/automations/effect` 持久记录，再开始实际操作；结果确认后写回。断线时仍有未确认操作则等待用户，禁止自动重放。没有未知副作用的中断在电脑重连后续接，离线不计失败。已保存的结束决定在最后一条 Socket 消息丢失时仍可提交，不重复执行。
- 只有某个目标确有新进展才进入回报队列，并用该目标自己的进度文字发到聊天；同一目标、同一状态不重复发。回报以单事务创建已完成的公开回复，不另调模型。没有进展就保持安静。
- 暂停或停止目标会取消进行中的检查。归档 Bot 会停止检查并作废未发回报。静默轮次不更新公开消息预览或 `last_active_at`。更换执行电脑会暂停检查，确认后再恢复。
- 默认每轮五分钟、二十次模型调用，每 Bot 每本地日最多八轮。到上限后等到下一本地日，不另发一条次数用完。可重试的失败按一、五、十五分钟重试，仍失败或有未确认操作则等待用户并说一次。

升级时先结束旧运行，更新 API、Worker、Runner 与电脑后启动；服务端自动应用迁移。Android 沿用消息、审批和 `activity` 协议；不提供系统推送。目标检查在兼容电脑连接后开始。回滚前停止检查并备份数据库。


## Linux 与多设备（0010-multi-device）

macOS / Linux 复用 Node.js 执行服务，Linux 另提供 CLI 和用户级 systemd；安装、存储和打包见 desktop/LINUX.md。每个 Bot 的 execution_device_id 固定目标电脑，本地任务记录 device_id，不根据其他电脑在线状态换机。资料库不跨电脑同步。

Hub 按 device_id 保存连接；事件广播到用户的所有设备，文件 RPC、运行事件、审批和取消只发送到指定设备。GET /devices 列出账号设备，POST /devices/:id/revoke 解绑自己的设备。/me 与 /bots 返回 devices 和 computer 汇总；presence 含 device_id、device_online、online（账号任一设备在线）。执行类型统一为 device/cloud，自动工作状态为 waiting_device，执行策略为 device_only。

对话在绑定设备离线时转云端；start_task 默认 execution=device，等待目标上线，纯联网任务可选择 cloud。未开始的本地任务保留排队；运行中断不自动重放。跨 Bot 委托跟随目标 Bot。换绑需要先结束或取消未完成任务，随后暂停目标检查，文件不迁移。

升级前结束运行并备份，API、Worker、Runner、桌面端及 Android 同步升级。迁移绑定原有效设备到已有 Bot；首次注册接管未绑定 Bot，之后新设备不自动修改绑定。


## 可选云端操作环境

启动配置 `PI_BOT_REMOTE_BACKEND=none|ssh|kubevirt`，默认 none。SSH 在后台每用户配置一台；KubeVirt 按用户惰性创建一台持久 VM。两种方式共用 Ubuntu 24.04 操作组件，经 SSH 执行文件、命令、Playwright 浏览器与 X11 桌面操作。API 保存加密连接凭据，Runner 只使用当前 run 的短期令牌调用操作接口，不直接持有 SSH／集群凭据。

`operation_target` 区分 `device:<id>`、`remote:<id>`、纯文字搜索 `cloud` 和兼容旧客户端的 `legacy`。模型执行者仍是 device／cloud。新客户端记录来源：桌面操作默认当前发消息电脑，安卓新操作默认云端；已有文件和任务的机器归属优先，离线不自动迁移。任务、续接和回报保留目标；更换云端机器会停用旧环境并保留其历史记录和磁盘。

持续目标与检查循环按 Bot 和机器分组，电脑／云端分别执行。已有目标保留原电脑，未确定机器的目标等待用户指定；不增加固定时刻调度。云端目标沿用预算、检查点、操作日志及回报去重。

人工接管使用 noVNC，经 API 鉴权 WebSocket 和 SSH 转发连接 VM 本机的只读／控制 VNC 端口。接管前停止在途命令与界面操作，45 秒租约每 15 秒续期；释放后 Agent 必须重新读取界面。文件通过鉴权 SFTP 流式上传下载，生成结果具有稳定标识和受限查看入口，不自动跨机器复制。

配置、支持的镜像、安装／镜像构建脚本和验收清单见 [云端环境部署](../server/deploy/remote/README.md)。默认关闭；升级应用 `0016-remote-environments` 迁移并同步更新两端客户端。真实 Ubuntu／KubeVirt 联调需使用专门的环境验收。
