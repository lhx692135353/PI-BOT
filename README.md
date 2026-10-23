# Pi Bot

一个可以自托管的个人 Bot 平台：每个 Bot 有独立的人设、角色形象、长期记忆和连续时间线。Mac 或 Linux 为 Bot 提供工作电脑，Android 用于随时聊天、查看结果与处理审批。

项目采用 [Apache License 2.0](LICENSE)。目前由 [@lhx692135353](https://github.com/lhx692135353) 个人维护，欢迎通过 Issue 和 Pull Request 参与。

## 能做什么

- **多 Bot 与长期记忆**：为不同任务设置人设、模型和角色形象，沿同一条时间线持续协作。
- **Mac / Linux 工作电脑**：在 `~/pi-bot/<slug>/` 中读写文件、执行命令；访问资料库外路径需要审批。
- **手机协作**：聊天、查看任务进展、批准请求，以及在 绑定的执行电脑在线时浏览资料库。
- **图片聊天**：Mac、Linux 和 Android 可上传、预览和发送图片，也可只发图片；支持 JPEG、PNG、WebP、GIF，每条最多 4 张，单张 2 MB、合计 4 MB。图片理解需要配置支持视觉输入的模型。
- **后台任务与目标**：对话过程中安排后台任务；每个智能体可以有自己的目标，绑定电脑在线时会定期对照现状并推进，有新进展才发到聊天里。
- **A2UI 交互工具**：在对话里展示表单、计算器、图表和表格，提交后继续任务。
- **服务端统一配置模型**：管理员配置支持 Responses API 的模型和 API Key；客户端经服务端代理调用。
- **可选扩展**：服务端配置 Tavily 后提供联网搜索；可接入 Langfuse 记录云端追踪；ESP32 桌面屏可跟随 Bot 显示表情。

需要自行准备模型服务账号和 API Key，相关费用由服务提供方收取。仓库不提供公共后端、共享账号或免费模型服务。

## 组成

```text
Mac / Linux / Android ── API + 管理后台 ── PostgreSQL
                     │
                     ├── 模型服务 / Tavily（可选）
                     └── Worker ── Runner（绑定的执行电脑离线时的云端对话）
```

绑定的执行电脑在线时，Bot 在该电脑上使用资料库和命令工具；离线时可由云端接续对话与联网搜索，无法访问本地文件。目标检查等待绑定电脑在线，不在云端自动执行。

| 目录 | 用途 |
| --- | --- |
| [server](server/README.md) | Node.js 24、Fastify、PostgreSQL；API、Worker、Runner、部署说明 |
| [admin](admin) | React 管理后台，由 API 在 `/admin/` 提供 |
| [desktop](desktop/README.md) | Electron + React 的 macOS / Linux 客户端与独立执行服务 |
| [android](android/README.md) | Kotlin + Jetpack Compose 的 Android 客户端 |
| [packages/agent](packages/agent/README.md) | 电脑与云端共用的 agent、记忆和私有 skills |
| [packages/a2ui](packages/a2ui/README.md) | 共享交互工具协议与 Web 渲染器 |
| [packages/bot-face](packages/bot-face) | 共享角色规格、动画引擎与渲染器 |
| [boards](boards/esp32-s3-touch-lcd-2.8c/README.md) | ESP32-S3 桌面屏 |

详细设计见 [整体架构](server/ARCHITECTURE.md)，各端的需求与限制见对应目录中的 `REQUIREMENTS.md`。

Linux 支持桌面和无界面的后台执行服务，安装与 systemd 配置见 [Linux 指南](desktop/LINUX.md)。同一账号可同时绑定多台电脑，每个 Bot 固定选择一台；文件各自保存，离线时本地任务等待。

## 快速开始

### 1. 准备环境与配置

需要 **Node.js 24 或更新版本、npm、Docker Compose**。运行 Mac 客户端还需要 macOS 和 Xcode Command Line Tools；Android 构建要求见 [Android 文档](android/README.md)。

```sh
git clone https://github.com/lhx692135353/PI-BOT.git
cd PI-BOT
npm ci
cp server/.env.example server/.env
node --import tsx server/scripts/vault-key.ts "$PWD/server/vault.json"
```

编辑 `server/.env`，至少替换以下配置：

| 变量 | 填写说明 |
| --- | --- |
| `PI_BOT_ADMIN_USERNAME` | 首次启动创建的管理员用户名 |
| `PI_BOT_ADMIN_PASSWORD` | 你设置的强口令，不使用示例值 |
| `PI_BOT_JWT_SECRET` | 至少 32 字符的随机字符串 |
| `PI_BOT_RUNNER_TOKEN` | 另一份至少 32 字符的随机字符串，与 JWT 密钥不同 |
| `PI_BOT_VAULT_FILE` | 本机运行 API 时填写刚生成的 `server/vault.json` 的绝对路径；Compose 会覆盖为容器内路径 |

可分别运行 `openssl rand -hex 32` 生成随机值。`server/.env` 和 `server/vault.json` 已被 Git 忽略；不要提交它们。请备份 vault 文件，丢失后将无法解密已保存的模型密钥。

### 2. 启动后端

**方式 A：完整后端使用 Docker Compose**

```sh
cd server
docker compose up --build -d
docker compose ps
# 需要排查启动问题时：
docker compose logs --tail=100 api worker runner
```

Compose 会启动 PostgreSQL、API、Worker 和 Runner。管理后台位于 <http://127.0.0.1:8000/admin/>，健康检查为 <http://127.0.0.1:8000/health>。

**方式 B：在本机开发后端**（从仓库根目录运行）

```sh
# 这里只启动数据库；不要与方式 A 的 API 同时运行。
# Compose 也会读取 server/.env，因此应先完成上面的配置。
(cd server && docker compose up postgres -d)
npm run build
npm run dev --workspace=@pi-bot/server
```

API 启动时自动执行数据库迁移。绑定的执行电脑离线时要继续云端对话，还需在另外两个终端分别运行：

```sh
npm run runner --workspace=@pi-bot/server
npm run worker --workspace=@pi-bot/server
```

### 3. 添加模型、创建用户

1. 使用 `.env` 中的管理员账号登录 `/admin/`。管理员只在数据库没有管理员时初始化，修改 `.env` 不会重置已有密码。
2. 在「模型」中配置 **支持 Responses API** 的服务地址、模型名和 API Key，并测试连通性。Base URL 一般填到 `/v1`，不含 `/responses`；仅支持 Chat Completions 的接口不能直接使用。
3. 在「用户」中创建普通用户，客户端用该账号登录。项目没有开放注册入口。
4. 可选：填写服务端 `PI_BOT_TAVILY_API_KEY` 并重启 API、Worker，启用搜索。Langfuse 配置见 [记忆与可观测性](server/MEMORY-OBSERVABILITY.md)。

### 4. 连接客户端

在仓库根目录的另一个终端运行 Mac 客户端：

```sh
npm run desktop:dev
```

| 客户端 | 连接电脑上的本地后端 |
| --- | --- |
| macOS | 默认 `http://127.0.0.1:8000` |
| Android 官方模拟器 | 默认 `http://10.0.2.2:8000`，该地址映射到宿主电脑 |
| Android 真机 | 在登录页改为电脑的局域网地址，例如 `http://192.168.1.100:8000`；手机和电脑须在同一网络，防火墙须允许该端口 |
| 远程部署 | 使用你自己的 HTTPS 域名，例如 `https://bot.example.com` |

`127.0.0.1` 在真机上指手机本身。客户端会保留已登录/已保存的服务器地址，更改默认值不会覆盖已有配置。Mac 临时连接非本机 HTTP 地址的显式配置方法见 [Mac 文档](desktop/README.md)。

登录 Mac 后创建一个 Bot，发送消息即可开始使用。执行电脑休眠、退出应用或断网时不能执行本地任务；Android 当前不提供系统后台推送。

## 目标

可以直接在对话中安排：

- “我的目标是把周报写进资料库，有进展再告诉我。”
- “现在有哪些目标？最近推进了什么？”
- “暂停这个目标。” / “停止全部目标。”

没有进行中的目标时不会自动检查。有目标时，空闲会把检查间隔逐步拉长，最多六小时一次；没有新进展就保持安静。目标检查只在登录且保持运行的执行电脑上进行，重连后合并检查。更换执行电脑会暂停检查，确认后再恢复。后台任务和目标的升级要求见 [整体架构](server/ARCHITECTURE.md)。

## 开发与验证

```sh
npm run typecheck
npm run build
npm test  # 未指定测试数据库时，依赖数据库的测试会跳过
```

完整集成测试需要**独立的测试数据库**。测试会删除并重建该库的 `public` schema，不能使用实际业务数据库。准备与命令见 [贡献指南](CONTRIBUTING.md)。GitHub PR 的 `Project checks` 会运行带 PostgreSQL 的完整 Node.js 测试。

Android 的构建和单元测试单独执行：

```sh
(cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug)
```

## 部署与安全边界

- 自托管部署见 [服务端说明](server/README.md)；Ubuntu 长期运行见 [Ubuntu 部署指南](server/deploy/ubuntu/README.md)。生产入口使用 HTTPS/WSS；Runner 只在内部网络供 Worker 调用。
- API 当前须保持单副本，设备长连接和资料库 RPC 存于进程内存。Worker 可多副本。
- 电脑的命令执行工具**不是操作系统沙箱**；它限制默认工作目录，但命令可以调用系统能力。请理解任务内容和审批范围后使用，详见 [安全政策](SECURITY.md)。
- 数据库、vault 和资料库应定期备份；仓库不包含托管服务、可用性承诺或自动备份保障。

## 参与与许可证

请先阅读 [贡献指南](CONTRIBUTING.md)。普通贡献者通过 Fork → 功能分支 → PR 提交；由维护者决定是否合并。`main` 的规则和开源发布步骤记录在 [维护指南](docs/MAINTAINING.md)。安全问题请按 [安全政策](SECURITY.md) 私下报告。

本项目的原创代码按 [Apache License 2.0](LICENSE) 提供；第三方代码保留其原有许可，详见 [NOTICE](NOTICE) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。仓库各 npm workspace 保留 `private: true`，用于防止误发布到 npm，不影响 GitHub 开源。
