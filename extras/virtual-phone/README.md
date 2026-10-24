# Pi Bot Virtual Phone Addon

Pi Bot 的可选虚拟手机控制组件。它是现有 `PhoneController` 的独立源码包，而不是另一个云手机平台或公开 ADB 网关。

**当前支持**：Linux、显式配置的一台 Android 设备、本机显式 ADB 端口、720×1280 竖屏、JPEG 定时预览、显式接管/释放、点击/滑动/导航键/受限文字输入。

**不包含**：账号系统、认证服务端、模拟器创建/删除、Docker 调度、noVNC/视频串流、旧版 vphone Agent/MCP/跑批系统、手机账号登录、语音模型配置。旧 Redroid 服务与本组件不是同一设备链路。

## 架构

```text
客户端 → Pi Bot 认证 API → 授权执行节点 → 本组件 → 本机 ADB → 指定 Android
```

组件只提供进程内接口，不监听 HTTP/TCP，不转发任意 URL。认证、账号隔离、设备归属和请求路由仍由 Pi Bot 负责，不能绕过该层直接向公网暴露组件。

## 安装与开发

需要 Node.js 24+、ADB、FFmpeg 和 `/usr/bin/flock`，Android 设备由管理员自行准备。本包不提供镜像或 Google 服务的授权。

从独立源码目录执行：

```sh
npm install
npm run typecheck
npm test
npm run build
npm pack --dry-run
# 生成固定白名单源码包及包内 SHA-256 清单（需本机 tar，不联网发布）
npm run export -- /absolute/path/to/virtual-phone-source.tar.gz
```

以上不会安装 APK、启动模拟器或重启服务。`npm pack --dry-run` 仅核对分发清单，不等于公开发布。源码仓库：https://github.com/TYzzt/pi-bot-virtual-phone 。尚未发布 npm 包；请从源码或本地打包安装。

在 Pi Bot 源码中，`desktop/packages/service/src/phone.ts` 兼容重导出本包，执行节点通过现有执行器挂钩调用它。这样测试与生产使用同一份源码，不复制一个平行控制器。

## 配置

将 `phone.example.json` 复制到**运行节点数据目录**的 `phone.json`，替换示例中的绝对路径。文件必须为运行用户所有、普通文件、非符号链接、权限 `0600`。锁目录须是用户自己的私有可写目录。

`enabled` 必须显式为 `true`。`serial` 必须明确指定设备序列号（不接受空值），`adbPort` 必须明确指定 1..65535 的本机端口；没有默认值。分辨率目前仍限 720×1280。示例中的端口不是通用默认，必须按自己的节点填写。未配置时 `phone.status` 返回不可用，其他操作拒绝。绝不自动扫描设备或选择默认 ADB。

## 进程内接入

构建后的本地使用示例（`configPath` 由宿主进程确定）：

```js
import { PhoneController } from './dist/index.js';

// suspendCommands/resumeCommands 必须与宿主真实执行器联动，不能使用空挂钩冒充互斥。
const phone = new PhoneController(configPath, {
  acquired: async () => { await executor.suspendCommands(); },
  released: () => { executor.resumeCommands(); },
});
// 此前必须已通过 Pi Bot 的账号、设备归属和撤销状态校验。
const status = await phone.call('phone.status', {});
const preview = await phone.call('phone.preview', {}); // 无需接管，无副作用，不续租
// 仅收到用户明确接管指令后调用 acquire；之后 frame/input/release 携带返回的 sessionId。
// 不用时调用 phone.close()，释放租约与定时器。
```

输入白名单为 `tap`、`swipe`、`key`、`text`。坐标分别限制在 0..719、0..1279；滑动时长 50..2000ms；导航键仅 3、4、67、66、187；直接文字最多 1000 个可打印 ASCII 字符。中文用设备内软键盘。

## 使用与安全

- 客户端默认只读预览；用户确认接管才申请人工租约。Android 入口：Bot 更多菜单 →「虚拟手机」。
- `phone.preview` 不获取控制锁、不暂停自动化、不延长已有人工会话。
- 所有 ADB 调用都显式指定 `-H 127.0.0.1 -P <adbPort> -s <serial>`，不依赖默认 ADB、环境里的远程 host 或设备列表顺序；目标离线即报错，不换其他设备。
- 人工会话绑定配置快照。配置变更/删除会使旧会话失效并释放锁，必须重新确认目标后接管；配置被禁用后仍可主动释放旧会话。
- 状态标签展示实际配置的 serial 和端口，不再将任何设备都称为 Google Play 验证机。`google-play-validation` 仅为兼容旧客户端的单手机逻辑槽位，不是设备身份断言。
- 接管使用 `flock`，并通过宿主挂钩暂停 Pi Bot 命令。最长 10 分钟；45 秒没有成功取图或输入即释放，失败不续活。
- 客户端离开/后台应主动释放，节点超时兜底；节点关闭时调用 `close()`。
- ADB 不得公开。使用 Pi Bot 已有认证连接，不需要 Tailscale 或独立截图公网代理。
- 锁仅约束遵守该锁的合作程序，不能阻止外部原始 ADB；宿主机权限仍由管理员负责。
- 不保存账号、画面或输入日志。敏感输入走子进程 stdin，不进命令行参数；不要额外记录 RPC 请求正文。
- 发布时仅带必要源码、说明、示例和测试，不带实际 `phone.json`、环境变量、凭据、截图、日志、模拟器磁盘或 ADB 密钥。

## 排障与限制

| 问题 | 检查 |
| --- | --- |
| 预览报会话失效 | 确认 API 和节点都支持 `phone.preview`；不要让用户通过先接管来修复只读预览。 |
| 状态不可用 | 检查配置文件权限/归属/路径及本机配置的 ADB 端口和 serial，不能拿裸 adb 的设备列表代替。 |
| 取图失败 | 检查设备为 720×1280 竖屏，ADB screencap 和 FFmpeg 正常。 |
| 无法接管 | 手机可能被合作程序占用或宿主暂停命令失败，等待释放；勿强行解锁。 |
| 输入失败 | 检查有效 sessionId、网络和白名单，不自动重试写入，以免重复操作。 |

这不是通用多机管理；锁无法覆盖外部原始 ADB；截图非实时视频。单测不代表 Android 真机、大字体布局、持续控制或账号登录已验收。Pi Bot 的管理端语音配置与本包无关，不写死任何通话/文字模型。

## 许可证与发布边界

本包从 PI-BOT 原有控制器提取，使用 Apache-2.0，保留 `LICENSE`、`NOTICE`。依赖 Zod 的发布包还应遵守其 MIT 许可证；Node.js、ADB、FFmpeg、Android 及 Google 服务分别遵守各自许可，不由本包重新授权。未纳入 vphone 历史代码，不代表历史项目整体的许可证问题已经解决。

导出脚本仅复制固定的源码、测试、构建产物、示例和许可文件，拒绝符号链接、已知凭据格式和本机专有路径。自动扫描不能替代人工审查；它不包含旧 Go SDK，也不会复制历史 vphone 仓库。`close()` 后组件不可再次调用，重新启用应创建新实例。

## 控制目标核验

宿主代理或运维工具也必须读取节点的有效配置，使用相同 host/port/serial，再只读核对设备系统指纹、AVD 名称或管理员资产记录。不要猜测模拟器编号，不得用另一套 Redroid 或“应用已安装”来证明目标正确。组件目前不保存硬件指纹，因此同端口同序列号被外部替换的设备不能仅靠 serial 证明身份；配置文件及宿主机权限仍是信任边界。
