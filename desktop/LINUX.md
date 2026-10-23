# Linux 执行电脑

支持 Ubuntu 24.04/26.04 x86_64。Linux 与 Mac 可以同时登录同一账号；每个 Bot 在编辑界面选择一台执行电脑。聊天、记忆和 skills 共用服务端记录，资料库文件分别留在各电脑，不自动同步。

## 无图形界面的服务

从源码构建只需 Node.js 24+，不需要 Electron、Swift 或桌面环境：

```sh
npm ci --ignore-scripts
npm run build:service --workspace=pi-bot-desktop
npm run service --workspace=pi-bot-desktop -- serve
```

另开终端登录，密码会隐藏输入：

```sh
npm run service --workspace=pi-bot-desktop -- login --server https://bot.example.com --username alice
npm run service --workspace=pi-bot-desktop -- status
```

账号由管理后台创建。登录后可在 Android 上创建 Bot、选择执行电脑、聊天和审批；后台服务保持运行即可执行本地任务。`logout` 会解绑本机身份并保留资料库。暂停服务不会解绑，重启后自动连接。

## 使用发行包与 systemd

后台包携带 Node.js 和运行依赖，不要求另外安装 Node.js。解压并安装到用户目录：

```sh
mkdir -p ~/.local/lib/pi-bot ~/.local/bin ~/.config/systemd/user ~/.config/pi-bot
tar -xzf pi-bot-service-linux-x64.tar.gz -C ~/.local/lib/pi-bot --strip-components=1
ln -sf ~/.local/lib/pi-bot/pi-bot ~/.local/bin/pi-bot
cp ~/.local/lib/pi-bot/pi-bot.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now pi-bot
~/.local/bin/pi-bot login --server https://bot.example.com --username alice
systemctl --user status pi-bot
journalctl --user -u pi-bot -f
```

如需退出系统登录后继续运行，由系统管理员为该用户配置 `loginctl enable-linger USER`。服务以普通用户身份运行，不要求 root。

可选配置写到 `~/.config/pi-bot/environment`，权限设为 `0600`。不要在该文件保存账号密码或模型 API Key。

| 配置 | 默认值 |
| --- | --- |
| `PI_BOT_DATA_DIR` | `$XDG_DATA_HOME/pi-bot`，或 `~/.local/share/pi-bot` |
| `PI_BOT_LIBRARY_ROOT` | `~/pi-bot` |
| `PI_BOT_SHELL` | `/bin/bash`，覆盖时须填写可执行文件的绝对路径 |
| `PI_BOT_HTTP_SERVER_URL` | 默认仅回环地址允许 HTTP；测试局域网后端时显式填写其完整 HTTP 地址 |

若网络依赖 `HTTP_PROXY` / `HTTPS_PROXY`，在同一配置文件中加入 `NODE_USE_ENV_PROXY=1`，并配置代理地址与 `NO_PROXY=localhost,127.0.0.1,[::1]`，再重启服务。Node.js 24 的 [环境代理支持](https://nodejs.org/download/release/latest-v24.x/docs/api/http.html#built-in-proxy-support)需要显式启用；HTTP 请求和 WebSocket 长连接均使用该代理，桌面端复用后台服务的网络配置。

账号、设备私钥和 IPC 令牌放在数据目录。目录权限为 `0700`，凭据与 socket 为 `0600`。桌面和后台服务须使用相同的数据目录；不同目录代表不同设备身份。

## 桌面版

源码运行 `npm run desktop:dev`；发行包解压后运行目录内的 `Pi Bot`。需要可用的 Linux 图形会话及 Electron 的系统运行库。窗口使用现有界面，支持设备列表、每个 Bot 选择执行电脑和审批。

![Linux 桌面客户端登录界面](docs/linux-login.png)

桌面包可安装到 `~/.local/lib/pi-bot-desktop`：

```sh
mkdir -p ~/.local/lib/pi-bot-desktop
tar -xzf pi-bot-desktop-linux-x64.tar.gz -C ~/.local/lib/pi-bot-desktop --strip-components=1
~/.local/lib/pi-bot-desktop/'Pi Bot'
```

Ubuntu 默认限制未授权应用创建用户命名空间。如果启动时提示 `SUID sandbox helper binary ... not configured correctly`，由管理员为安装目录内的 Chromium helper 配置所有者和权限后再启动：

```sh
sudo chown root:root ~/.local/lib/pi-bot-desktop/chrome-sandbox
sudo chmod 4755 ~/.local/lib/pi-bot-desktop/chrome-sandbox
```

更新桌面包后如覆盖了该文件，需要重新配置 helper。后台服务不依赖此 helper。

桌面版优先连接已有后台服务；退出窗口不会停止 systemd 管理的服务。如果桌面版自行启动服务，退出应用会同时停止该服务。Bot 绑定其他电脑时，本机的“打开资料库”不可用，可通过 Android 浏览目标电脑文件。

## 任务与设备变更

- 绑定电脑离线时，云端继续聊天和联网搜索。本地文件任务、命令和定时工作等待指定电脑，不切换到其他在线设备。
- 尚未开始的本地任务可在原电脑重连后执行；已经开始但断线的操作标记失败，需核实结果后重新安排，避免重复副作用。
- 更换执行电脑前先结束或取消所有未完成任务。更换后资料库使用目标电脑的文件，目标检查暂停；确认环境后通过对话恢复。
- 解绑只影响该设备，其他电脑继续工作。被解绑设备的排队和运行任务会结束，Bot 保留原绑定，用户可重新选择电脑。
- `run_command` 沿用现有权限边界，只约束工作目录，不提供操作系统沙箱。

## 构建发行包

```sh
npm run pack:linux --workspace=pi-bot-desktop -- --service-only
# 桌面与后台两个包，需要先安装 Electron：
npm run pack:linux --workspace=pi-bot-desktop
```

输出位于 `desktop/out/linux/`。服务端启动自动执行 `0010-multi-device` 迁移；升级前备份数据库、vault 和资料库并结束运行，服务端、Mac/Linux 客户端和 Android 须同步升级。旧客户端协议不兼容本版本。
