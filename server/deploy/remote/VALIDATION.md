# 本地验证记录（2026-10-26）

没有连接生产／用户 SSH 虚机或真实 KubeVirt 集群。本记录区分可复现的本地结果和需要现场验收的部分。

| 检查 | 结果 |
|---|---|
| `npm run typecheck` | 通过：Server、共享 Agent、桌面端、管理后台、A2UI |
| `npm run build` | 通过：管理后台、API、Worker、Runner |
| `npm run build --workspace=pi-bot-desktop` | 通过；Vite 有现有体积提示 |
| Android `:app:testDebugUnitTest :app:assembleDebug` | 39 项单元测试通过，Debug APK 构建通过 |
| Node 24 仓库回归，PostgreSQL 16 临时测试库 | 179 项通过、0 失败、9 项跳过；跳过 8 项 Windows 原生测试及 1 项真实 Ubuntu 环境验收 |
| Linux 手机控制测试 | 6 项在 Node 24 Debian 容器中通过 |
| 最后针对云端能力／目标检查的补充回归 | 34 项通过，其中云端能力 14 项、页面交互 1 项；含接管前等待远端取消确认 |
| 编译后的 API 冒烟 | `/health`、`/remote-desktop/`、noVNC 模块、`/openapi.json` 均返回 200 |
| 云端桌面页面交互测试 | 通过：只读启动、接管前禁止发送文字、取得租约后发送中文输入 |
| 部署脚本 | `bash -n` 通过 |

Node 回归使用 `TMPDIR=/tmp`，Linux 专用的 `desktop/tests/phone.test.ts` 单独在 Linux 容器运行。直接在 macOS 默认长临时目录运行时，原有多电脑测试会因测试任务标题包含长路径而超限；手机测试依赖 Linux 的 `/bin/true` 和 `/usr/bin/flock`。使用未修改的基线也复现了这些失败；短临时目录及对应 Linux 环境下均通过。没有为消除这些平台差异而改动手机控制实现。

新增验证覆盖真实 SSH 协议通道与主机指纹拒绝、模拟 KubeVirt 资源与并发预留、Worker／Runner／API 工具链、机器目标固定、凭据隔离、操作去重、符号链接、远端命令超时／取消、目标分组、接管互斥／取消确认、SFTP 流式文件往返、结果查看权限及页面资源。

仍需在真实环境验收：标准 qcow2 镜像构建与首次启动、集群 RBAC／CDI／virtctl 转发、真实 Chromium／Xfce 的操作与中文输入、VNC 只读及接管交互、实际网络中断及进程停止。部署 README 提供人工清单和 `remote-live.test.ts` 显式验收入口。


## 提交 PR 前基于最新 main 复核

- 已将本次功能移到最新 `main`，保留其独立语音模型和虚拟手机能力。
- `npm run typecheck`、`npm run build` 通过。
- Node 24／独立 PostgreSQL 16：187 项通过、0 失败、18 项跳过；Linux 专用手机文件另在 Linux 容器验证。
- Linux 容器补跑桌面手机控制、Agent 手机工具和 extras 虚拟手机测试：26 项全部通过。
- Android 单元测试 46 项通过，Debug APK 构建通过。
- 已用本地演示账号检查管理后台的用户云端环境入口及 SSH 配置表单，截图见 `screenshots/admin-environment.png`；未填写或截图真实凭据。
- 真实 Ubuntu／KubeVirt 环境仍按上面的清单验收。
