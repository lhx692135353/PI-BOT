# Pi Bot iOS

iPhone 和 iPad 上的 Pi Bot：看 Bot 们在干什么、发消息和图片、语音通话、批准访问请求、浏览资料库、新建和编辑 Bot。功能对齐 [Android 客户端](../android/README.md)，不包含虚拟手机。需求与验收见 [REQUIREMENTS.md](REQUIREMENTS.md)。

## 目录

| 路径 | 内容 |
| --- | --- |
| `PiBotKit/` | Swift Package：数据模型、REST 与实时事件、会话钥匙串存储、时间线与 Markdown、角色规格与动画引擎、SwiftUI 角色绘制。可在 macOS 上用 `swift test` 测试 |
| `PiBot/` | App 界面：登录、Bot 列表、对话、编辑、资料库、设置、语音通话 |
| `PiBot.xcodeproj` | Xcode 工程，`PiBot/` 为文件夹同步组，新增文件无需改工程 |
| `Config/Info.plist` | 后台音频、HTTP 访问和默认服务器地址 |
| `scripts/copy-shared-assets.sh` | 构建时把 `packages/bot-face/spec.json` 和 `packages/a2ui/dist` 复制进 App |

## 构建

需要 macOS 和 Xcode 16 或更新版本（工程使用文件夹同步组），最低支持 iOS 17。首次准备时在仓库根目录运行 `npm ci`；构建脚本会在缺少 A2UI 渲染器时自动执行 `node packages/a2ui/scripts/build.mjs`。

用 Xcode 打开 `ios/PiBot.xcodeproj`，选择 `PiBot` scheme 和模拟器即可运行。真机运行需要签名：新建 `ios/Config/Signing.local.xcconfig`（已被 git 忽略），写入自己的团队 ID 和唯一的 Bundle ID：

```text
DEVELOPMENT_TEAM = ABCDE12345
PRODUCT_BUNDLE_IDENTIFIER = dev.pibot.ios.yourname
```

免费 Apple ID 也可以，团队 ID 在 Xcode 的 Settings → Accounts 中查看。不要在 Signing & Capabilities 里直接改，那样会写进工程文件。

命令行：

```sh
(cd ios/PiBotKit && swift test)
(cd ios && xcodebuild -project PiBot.xcodeproj -scheme PiBot -destination 'generic/platform=iOS Simulator' CODE_SIGNING_ALLOWED=NO build)
```

## 使用

1. 登录页默认填写 `http://localhost:8000`，连接模拟器所在电脑上的本地后端；可通过构建设置 `PI_BOT_DEFAULT_SERVER_URL` 修改默认值。真机请点击服务器地址，改为电脑的局域网 IP 或你部署的 HTTPS 域名，首次连接时允许「本地网络」权限。已保存的地址不会被新默认值覆盖。HTTP 仅建议用于本地开发。
2. iPhone 竖屏为单页：列表点进对话；iPad 和横屏大屏 iPhone 为左列表、右对话，默认选中主 Bot。支持分屏和台前调度，窗口变窄时自动切换为单页。
3. 对话右上角菜单可进入「云端桌面与文件」「资料库」或「编辑 Bot」。消息文本可长按选择部分内容复制，链接可点击。
4. 输入框的「＋」从相册添加图片，最多 4 张；HEIC 或超过 2 MB 的照片会自动转为 JPEG 并压缩到限制以内。
5. 电话按钮发起语音通话，默认使用扬声器免提并开启系统回声消除；切到后台通话继续，短暂断线 15 秒内自动续接，系统来电等中断会结束通话。
6. 有审批时列表头像出现红点，时间线最下方出现审批卡片。

## 与 Android 的差异

- 不提供虚拟手机。
- 不提供系统后台推送（需要 APNs，服务端暂未接入）；前台保持实时更新。
- 不提供应用内更新，通过 TestFlight 或 App Store 分发。
- 会话令牌保存在钥匙串，服务器地址保存在 `UserDefaults`，退出登录后保留地址。
