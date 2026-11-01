# 客户端更新与已保存授权：验证记录

验证日期：2026-10-31。代码基于 `e82c5a7`，位于 `codex/client-updates-saved-authorizations`；本记录对应 PR 分支上的验证结果，尚未发布或部署。

## 实现范围

- Windows / Linux 设置页接通安装包已有更新接口，显示检查中、最新版本、新版本、下载字节进度、校验、安装确认、取消及错误原因。macOS 等暂无自动安装通道的平台也显示官方发布页入口。
- 安装前同步保存文字及图片草稿、保存窗口尺寸并刷新配置存储；重验安装包大小和 SHA256，继续使用原安装器与应用身份。安装回执在重启后比较实际运行构建，启动安装器本身不计为升级成功。
- Android 已有更新入口，补齐下载进度和独立错误反馈。
- 桌面与 Android 提供「拒绝 / 仅本次允许 / 一直允许」，保存前展示范围。服务端持久化、执行前匹配、设置页查看及撤销、授权及使用日志均已接通。
- 持久规则只允许当前账号、指定执行电脑或云端环境、指定文件或目录的**读取**。写入、命令、旧版宽泛请求不能保存为持久规则。运行中撤销对后续权限检查生效；网络验证失败不会放行。
- 服务端上线需要执行 `0020-saved-authorizations` 迁移，并更新执行端。细节见 [已保存授权](saved-authorizations.md) 与 [Windows 更新说明](windows-client-update.md)。

## 已通过的验证

| 范围 | 结果与证据 |
| --- | --- |
| 类型与服务端构建 | `npm run typecheck`、`npm run build` 通过；草稿审查修复后再次通过类型检查，日志 `.cache/draft-switch-typecheck.log`；服务端构建日志 `.cache/client-auth-build-final.log` |
| 服务端及相关组件 | 真实独立 PostgreSQL；server、agent、a2ui、bot-face 共 212 项，210 通过、2 跳过、0 失败；`.cache/client-auth-backend-regression.log` |
| 授权范围与执行 | 跨用户/电脑隔离、路径边界、写入与命令隔离、任务结束/取消、并发审批、运行中撤销、审计及云端操作重试通过；新增执行器测试验证实际文件工具、提前到达的审批决策及网络失败关闭访问 |
| 桌面界面 | 更新和授权聚焦回归通过，包含真实 Electron renderer 与 bridge、手动检查反馈、50% 字节进度、取消安装、安装前草稿、范围确认、决策失败重试、撤销及原手机入口；`.cache/client-auth-desktop-focused-final.log`、`.cache/client-auth-executor-final.log` |
| Windows 安装包 | 原生 13 项测试全部通过；中文路径中的独立运行时启动与认证 IPC smoke 通过；Squirrel 和 ZIP 生成成功；草稿修复后重新打包的日志 `.cache/draft-switch-windows-build.log` |
| 包内一致性 | 包内 main、preload、renderer 文件与最终构建逐一哈希一致；安装器 PE 文件头及产物 SHA256 复核通过 |
| Android | `:app:testDebugUnitTest :app:lintDebug :app:assembleDebug` 通过；`.cache/client-auth-android-final.log` |

审查发现并修复了切换会话时的草稿清理问题：A 的发送请求未结束时切到 B，发送成功后按发送时的 Bot ID 清理 A 的原文字和图片，保留发送期间后来输入的文字及 B 的草稿。新增 `desktop/tests/timeline-drafts.test.ts` 在真实 Electron 中覆盖切换、保存、页面重载、继续编辑和发送失败；修复前在「A 的草稿未清理」断言失败，修复后与设置/手机入口回归共 3 项全部通过。日志 `.cache/draft-switch-ui.log`。

测试数据库和临时服务均已停止。测试未读取或修改真实客户端账号、凭据、配置和资料库。

自动审批以「策略拦截」拒绝清理 Windows 临时目录，未提供进一步原因，因此保留了本次 probe 的三个目录：`%TEMP%/Pi Bot probe 中文 srr3vj`、`%TEMP%/Pi Bot probe 中文 EtzHUA`、`%TEMP%/Pi Bot probe 涓枃 EtzHUA`。它们不影响产物或功能。

扩展测试并非全仓全绿：Windows 下既有 virtual-phone 用例依赖 POSIX 的 `flock`、`printf` 和权限模型，Linux 路径断言也与 Windows 不兼容。首次扩展执行中的代理与工作目录问题，已使用打包自带 Node 和正确目录复测通过；新增设置接口对应的手机界面测试 mock 已同步更新并通过。不能将上述聚焦验证表述为所有平台的全套测试通过。

界面截图：[下载进度](screenshots/client-settings/updates-progress.png)、[安装取消和授权范围](screenshots/client-settings/updates-ready-and-authorizations.png)、[已保存授权](screenshots/client-settings/saved-authorizations.png)。截图来自测试 fixture。

## 本地产物

- Windows：`.w/make/squirrel.windows/x64/Pi-Bot-Windows-x64-Setup.exe`，216,871,424 字节，**未签名测试安装包**。本地构建身份 `0.3.0 / build 0`，不是正式更新发布。
- SHA256：`c690486da66110e3ece2a411d08ce70aa51df5f2202514edf06226390ffcec3f`；完整校验清单 `.w/make/SHA256SUMS.txt`。
- Android：`android/app/build/outputs/apk/debug/app-debug.apk`，调试签名包，不能替代正式签名的升级验收。

## 尚未完成的真实安装验收

**尚未从实际安装的 Windows 客户端完成「检查 → 下载 → 确认 → 安装 → 重启 → 版本变化」验收。** 本次没有替换用户安装或发布测试 Release；当前会话没有可调用的 Windows 桌面交互工具。

机器现有安装为 `0.2.0`。旧客户端需要先覆盖安装包含新入口和更新器的兼容构建，再准备相同应用身份、构建号更高、包含正确 manifest 的发布包。在真实客户端中验证新版本/构建号、升级回执、账号绑定、通道、文字/图片草稿和资料库文件；同时验证取消、网络错误与坏包校验失败。只有完成这些步骤，才能确认用户要求的安装升级验收通过。
