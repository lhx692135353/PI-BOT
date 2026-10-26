# Pi Bot Android

手机上的 Pi Bot：看 Bot 们在干什么、发消息、批准访问请求、浏览 Mac 上的资料库、新建和编辑 Bot。整体设计见 [ARCHITECTURE.md](ARCHITECTURE.md)，需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## Android Studio

1. 首次准备时，在仓库根目录运行 `npm ci`，安装构建 A2UI 资源使用的 Node.js 和依赖。
2. 在 Android Studio 中选择 **Open**，打开本仓库的 `android/` 目录，等待 Gradle Sync 完成。
3. 使用项目自带的 Gradle Wrapper；Gradle Daemon JVM 已通过 `gradle/gradle-daemon-jvm.properties` 固定为 Java 25。请使用 Android Studio 自带的 JBR 25（带 `jlink`）。应用源码的 Java 编译目标仍为 17。Cursor / VS Code 的 Red Hat Java 扩展自带 JRE 没有 `jlink`，拿它跑 Gradle 时 `:app:compileDebugJavaWithJavac` 会在生成 `androidJdkImage` 时失败。
4. 在 SDK Manager 中安装项目要求的 Android SDK Platform（`compileSdk = 37`）；本地 SDK 位置由 Android Studio 写入 `local.properties`。
5. 在 **Build Variants** 中选择 `app` 的 `debug`，再从工具栏选择运行配置和模拟器或真机。

共享运行配置位于 `.run/`，打开 `android/` 工程后自动加载：

| 配置 | 用途 |
| --- | --- |
| `Pi Bot Android` | 构建、安装并启动默认 Activity；Run 正常运行，Debug 可断点调试，自动显示 Logcat |
| `Android Unit Tests` | 执行 `:app:testDebugUnitTest`，无需连接设备 |
| `Android Debug APK` | 执行 `:app:assembleDebug`，生成 Debug APK，无需连接设备 |

配置使用工程相对路径，不绑定设备；`.idea/`、SDK 路径与个人 IDE 设置继续保持本地文件。

## 命令行构建

需要 Gradle Daemon 使用 Java 25，以及 Android SDK（`compileSdk = 37`）。在 `android/local.properties` 写 `sdk.dir=/path/to/android-sdk`，并先在仓库根目录完成 `npm ci`，然后：

```sh
cd android
./gradlew :app:testDebugUnitTest   # 单元测试
./gradlew :app:assembleDebug       # app/build/outputs/apk/debug/app-debug.apk
```

GitHub Actions 的 `Android` 工作流在 pull request 和 `main` 推送上执行同样的两条任务，并上传 debug APK。

构建会把 `packages/bot-face/spec.json` 复制进 APK 的 `assets/bot-face/`，角色规格只维护那一份。

## 使用

聊天输入框的「＋」可从系统文件选择器添加图片。发送前可预览、移除，支持只发图片；历史图片点击可放大。支持 JPEG、PNG、WebP、GIF，每条最多 4 张，单张不超过 2 MB、合计不超过 4 MB。图片理解需要视觉模型，并同步升级 API、Worker、Runner 和客户端；服务端自动应用 `0011-message-images` 迁移。

1. 登录页默认填写 `http://10.0.2.2:8000`，连接 Android 官方模拟器宿主电脑上的本地后端。真机请点击服务器地址，改为电脑的局域网 IP 或你部署的 HTTPS 域名；`127.0.0.1` 在手机上指手机自身。账号由管理员在后台创建，已保存的地址不会被新默认值覆盖。
2. 首页上方展示主 Bot，下方为会话列表，支持搜索名字与最近消息、下拉刷新。窄屏点列表进入对话；窗口宽度达到 720dp 时自动显示左列表、右对话，默认选中主 Bot。对话右上角「更多选项」可进入「资料库」「虚拟手机」或「编辑 Bot」；虚拟手机默认只读预览，确认接管后才能点击、滑动和输入，离开页面或进入后台自动释放。资料库在执行电脑在线时可用。虚拟手机部署、安全和排障见 [虚拟手机说明](../docs/virtual-phone.md)。
3. 有审批时 Bot 会话头像出现红点，时间线最下方出现审批卡片。

Debug 和 release 均支持 HTTP 与 HTTPS 服务器地址，包括公网域名、IP 和带路径前缀的地址（如 `http://example.com:8000/pibot`）；实时连接随协议使用 `ws://` 或 `wss://`。在登录页点击服务器地址即可修改。HTTP 仅建议用于本地开发；远程部署使用 HTTPS。

A2UI 交互工具显示在 Bot 回复中；输入会保存，提交后进入正常任务流程。构建会自动打包 `packages/a2ui` 的 Web 渲染器，需要先在仓库根目录运行 `npm ci`；桥接仅处理交互事件，不在页面中提供账号凭据。

异步任务模式：对话持续接话，每个 Bot 最多并行执行两个后台任务，其余排队；用聊天查询进度、补充要求或取消，结果完成后另发。两端需与 API、Worker、Runner 同步升级，服务端自动应用 `0007-async-tasks`；升级前结束旧运行。详情见 [整体架构](ARCHITECTURE.md)。

主 Bot 在进入首页时会跳动并转身，之后保持呼吸、眨眼；系统关闭动画时保持静止。会话列表的小头像使用静态帧以减少开销。折叠、调整窗口或切换 Bot 时保留各自的输入草稿。


## 目标

没有进行中的目标时不会自动检查。有目标时，空闲会把检查间隔逐步拉长，最多六小时一次。目标检查只在登录且保持运行的 Mac 上执行；Mac 离线、退出应用或休眠时等待，重连后合并检查。云端仍可接受聊天、保存和管理目标。

直接在聊天中使用：

- “我的目标是把周报写进资料库，有进展再告诉我。”
- “现在有哪些目标？最近推进了什么？”
- “暂停这个目标。” / “恢复目标检查。”
- “这个目标完成了。” / “停止全部目标。”

没有新进展不发消息。某个目标有新进展时，在原时间线发一条；同一状态不重复发。检查可以在该目标写明的授权范围内改文件或跑命令，资料库外访问仍需审批。中断时操作结果无法确认会暂停并请你核实。

首次升级需同步更新 API、Worker、Runner 和 Mac，服务端自动应用 `0009-always-on`；旧 Mac 不启动自动轮次。Android 无需新增配置，不提供系统后台推送。


## 云端操作环境

服务端启用 SSH 或 KubeVirt 后，安卓发起的新机器操作默认在用户自己的云端虚机执行。追问已有电脑文件／任务时仍使用原机器，离线会明确说明，不自动迁移。目标检查保存各自的执行环境，也可以在云端运行；本次没有新增固定时刻调度。

对话更多菜单的“云端桌面与文件”在系统浏览器中打开本人环境，可查看／人工接管桌面、浏览资料库并上传下载。人工接管期间 Agent 命令和界面操作暂停。消息中的云端结果提供独立查看按钮，入口只能读取指定文件。准备方式见 [部署说明](../server/deploy/remote/README.md)。
