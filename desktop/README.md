# Pi Bot 电脑端

Pi Bot 的电脑端是 Bot 们的 **harness**：登录后这台电脑注册到你的账号，Bot 在这里读写资料库、执行命令。支持文件与命令工具，以及通过 Server 提供的联网搜索；支持 Bot 私有 skills，没有浏览器自动化或 MCP。

聊天输入框的「＋」可选择图片，也支持拖入图片或粘贴截图。发送前可预览、移除，支持只发图片；历史图片点击可放大。支持 JPEG、PNG、WebP、GIF，每条最多 4 张，单张不超过 2 MB、合计不超过 4 MB；模型需要支持视觉输入。

图片功能需同步升级 API、Worker、Runner 和客户端；服务端启动时自动应用 `0011-message-images` 迁移。

- 每个 Bot 的资料库是 `~/pi-bot/<slug>/`，可以用文件管理器打开。
- Bot 默认只能碰自己的资料库；要访问外面的路径（如 `~/Desktop`）会先弹出审批，由你在电脑或手机上批准，只对本次任务有效。
- 模型由管理员在云端后台配置，执行电脑通过云端模型代理调用，本机不保存任何模型密钥。
- 绑定电脑离线时，发给 Bot 的消息会在云端运行（只能对话和联网搜索，看不到资料库）。

## 启动

安装包入口：[GitHub Releases](https://github.com/lhx692135353/PI-BOT/releases)。桌面 beta 发布流程提供 Windows x64 未签名测试安装器、ZIP、Linux x64 桌面/服务压缩包和 SHA256 校验和；维护者发布版本后才会出现在该页。桌面端、它依赖的共享包或桌面工作流有改动时，`Desktop platforms` 会把 Linux、Windows 和未公证的 macOS arm64 DMG 上传为 Actions artifacts，属于有保留期限的测试产物。只改服务端、Android 或文档时不会生成这些包。该 DMG 使用临时签名，下载后会被系统拦截；日常开发仍按下文从源码构建。正式 Release 不附带该 DMG。

Windows beta 的安装与验收说明见 [Windows 指南](../docs/windows-client.md)。

Linux 安装、后台服务与 systemd 请看 [Linux 指南](LINUX.md)。

Mac 前置条件：macOS、Xcode Command Line Tools（`xcrun swiftc --version` 可执行），以及一个可访问的 Pi Bot 服务器（见 [server/README.md](../server/README.md)）。

```sh
npm ci              # 在仓库根目录；会下载 Electron
npm run desktop:dev
```

使用 VS Code 调试时，先在仓库根目录复制示例：

```sh
cp .vscode/launch.example.json .vscode/launch.json
cp .vscode/settings.example.json .vscode/settings.json
```

然后在「运行和调试」中选择 `Pi Bot Desktop (Mac)`。在本地 `launch.json` 的 `env` 中配置默认后端和 HTTP 例外；本机 JDK 路径可写入 `settings.json`。这两个本地配置文件已被 Git 忽略，仓库只共享示例；调试账号与资料库保存在同样被忽略的 `.local/` 中。

`npm run dev` 在 macOS 上先构建 Swift Keychain helper、本地服务和 UI，再启动独立服务进程和 Electron。修改源码后重新执行。

开发启动和打包应用的登录页默认服务器都是本机 `http://127.0.0.1:8000`，可用 `PI_BOT_SERVER_URL` 覆盖默认填写值，或在登录页手动修改。已保存的服务器地址优先于默认值。本机回环地址允许 HTTP；远程部署默认要求 HTTPS。临时连接局域网 HTTP 后端时，用 `PI_BOT_HTTP_SERVER_URL` 明确允许那一个完整后端地址，不会放开其他 HTTP 地址。

```sh
PI_BOT_SERVER_URL=http://192.168.1.100:8000 \
PI_BOT_HTTP_SERVER_URL=http://192.168.1.100:8000 \
npm run desktop:dev
```

## 使用

1. 用管理员创建的账号登录。登录把本机添加为执行电脑，不替换其他设备。每个 Bot 可选择自己的执行电脑。
2. 「新建 Bot」：取名、写人设、选模型（默认跟随管理员设置的默认模型）、挑造型和颜色。资料库文件夹按名字生成，改名不会移动文件夹。
3. 在时间线里给 Bot 发消息。每个 Bot 只有一条连续的时间线，较早的对话由云端压缩为长期记忆。
4. Bot 工作时，侧栏里它的表情会变化：思考、工作、搜索、等你批准、完成庆祝；3 天没动静会睡着，并显示睡了几天。
5. 「打开资料库」直接看 Bot 产出的文件。手机在绑定电脑在线时也能浏览这些文件。

## Bot 的工具

| 工具 | 说明 |
|---|---|
| `web_search` | 通过 Server 调用 Tavily SaaS，返回标题、链接和摘要（服务器配置 Tavily Key 时可用） |
| `list_files` / `read_file` / `search_files` | 浏览、读取、搜索资料库 |
| `write_file` / `edit_file` | 写文件、精确替换文本 |
| `run_command` | Mac 使用 zsh，Linux 使用 bash 执行命令，工作目录默认是资料库（也可以是已批准的外部目录），默认 2 分钟超时，可取消 |
| `request_outside_access` | 申请访问资料库以外的目录或文件 |

文件工具会解析符号链接，不能借链接逃出资料库；`run_command` 只限制工作目录，命令本身不做沙箱隔离，人设和审批是主要防线。联网搜索由电脑与云端共用 Server 的鉴权接口，不在客户端保存搜索密钥，也无需在执行电脑上安装搜索服务。

## 数据位置

| 内容 | 位置 |
|---|---|
| 资料库 | `~/pi-bot/<slug>/`（`PI_BOT_LIBRARY_ROOT` 可改） |
| 账号与设备信息 | Mac：`~/Library/Application Support/Pi Bot/account.json`；Linux：`$XDG_DATA_HOME/pi-bot/account.json`，默认 `~/.local/share/pi-bot/account.json`（`PI_BOT_DATA_DIR` 可改） |
| 设备私钥 | Mac 打包应用使用钥匙串 `dev.pi-bot.device`；Linux 与开发模式使用数据目录的 `secrets.json`（0600） |
| 服务 socket | `/tmp/pi-bot-<uid>-<hash>/service.sock` |

消息、记忆和审批都在云端；本机只有资料库文件和设备身份。

## 测试与打包

```sh
npm test --workspace=pi-bot-desktop          # 沙箱与工具测试
PI_BOT_TEST_DATABASE_URL=postgresql://... \
  npm test --workspace=pi-bot-desktop        # 加上真实服务器 + 真实 Pi agent 的端到端测试
npm run pack:mac --workspace=pi-bot-desktop  # 生成 Pi Bot.app / dmg
```

列表头像动画可在无账号的本地验证页检查：从仓库根目录运行 `npx vite --host 127.0.0.1`，打开 `/desktop/tests/bot-face-browser/`。页面挂载真实桌面 UI，提供任务状态切换和“减少动态效果”模拟开关；可检查整行悬停、键盘聚焦、睡眠唤醒及完成后的恢复。此页仅用于开发，不进入应用构建。

架构见 [ARCHITECTURE.md](./ARCHITECTURE.md)，需求与验收标准见 [REQUIREMENTS.md](./REQUIREMENTS.md)。

应用图标由 `scripts/build-icon.ts` 从共享 Bot 绘制代码生成，Dock、安装包和主智能体均使用默认橙色小人。登录后，Pi Bot 主智能体自动固定在列表顶部，其他 Bot 按最近活动排序。

A2UI 交互工具直接显示在时间线里，支持表单、实时计算、联动图表和表格。输入会保存，提交后 Bot 继续工作；组件和协议由 `packages/a2ui` 与 Android 共用。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。各客户端需与 API、Worker、Runner 同步升级，服务端自动应用 `0010-multi-device`；升级前结束旧运行。详情见 [整体架构](ARCHITECTURE.md)。

记忆、协作目录、任务续接与云端 Langfuse 配置见[实现说明](../server/MEMORY-OBSERVABILITY.md)。


## 目标

没有进行中的目标时不会自动检查。有目标时，空闲会把检查间隔逐步拉长，最多六小时一次。目标检查只在绑定且保持运行的电脑上执行；电脑离线、退出应用或休眠时等待，重连后合并检查。云端仍可接受聊天、保存和管理目标。

直接在聊天中使用：

- “我的目标是把周报写进资料库，有进展再告诉我。”
- “现在有哪些目标？最近推进了什么？”
- “暂停这个目标。” / “恢复目标检查。”
- “这个目标完成了。” / “停止全部目标。”

没有新进展不发消息。某个目标有新进展时，在原时间线发一条；同一状态不重复发。检查可以在该目标写明的授权范围内改文件或跑命令，资料库外访问仍需审批。中断时操作结果无法确认会暂停并请你核实。

本版本升级需同步更新 API、Worker、Runner、Mac/Linux 执行端及 Android，服务端自动应用 `0010-multi-device`。升级说明与 Linux 安装见 [LINUX.md](LINUX.md)。Android 不提供系统后台推送。
