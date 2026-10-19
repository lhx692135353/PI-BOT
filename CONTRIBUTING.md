# 贡献指南

感谢参与 Pi Bot。项目目前由 [@lhx692135353](https://github.com/lhx692135353) 个人维护，欢迎问题反馈、文档改进和代码贡献。维护者根据项目方向和维护成本决定是否合并；CI 通过并不代表自动接受。

## 先沟通问题

- Bug：提供复现步骤、预期与实际结果、相关版本，以及脱敏后的日志。
- 功能：说明使用场景、希望解决的问题和替代方案。较大改动请先开 Issue，避免重复投入。
- 安全漏洞：请阅读 [SECURITY.md](SECURITY.md)，不要公开凭据或可直接利用的细节。

## 本地环境

按照 [README 快速开始](README.md#快速开始) 安装 Node.js 24、依赖和后端。数据库、`.env`、模型 API Key、vault、设备私钥和本机 IDE 配置不要提交。纯文档修改无需准备模型账号。

VS Code 配置从 `.vscode/*.example.json` 复制到本机的 `launch.json` / `settings.json` 后使用，具体步骤见 [Mac 文档](desktop/README.md)。示例中只使用本地默认地址，不写个人后端、账号或绝对路径。Android `.run/` 中使用工程相对路径的共享运行配置可以提交；`.idea/`、SDK 路径、日志和构建缓存留在本地。

```sh
npm ci
npm run typecheck
npm run build
```

普通单元测试可以直接运行 `npm test`。完整集成测试使用 PostgreSQL 16 和单独数据库；以下命令在 `127.0.0.1:55432` 创建一次性测试服务，不使用开发数据库：

```sh
docker run --detach --rm --name pi-bot-contributor-tests \
  -e POSTGRES_USER=pibot -e POSTGRES_PASSWORD=pibot -e POSTGRES_DB=pibot_test \
  -p 127.0.0.1:55432:5432 postgres:16-alpine
# 等到输出 accepting connections 后再继续：
docker exec pi-bot-contributor-tests pg_isready -U pibot -d pibot_test
PI_BOT_TEST_DATABASE_URL=postgresql://pibot:pibot@127.0.0.1:55432/pibot_test npm test
docker stop pi-bot-contributor-tests
```

测试会清空目标库的 `public` schema。务必核对连接字符串，测试用凭据只用于本机一次性容器。未设置 `PI_BOT_TEST_DATABASE_URL` 时，依赖数据库的测试会跳过，不能据此声称完整集成测试通过。

Android 改动请额外执行 `cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug`；环境要求见 [Android 文档](android/README.md)。Mac 客户端运行与打包见 [Mac 文档](desktop/README.md)。

## 提交 Pull Request

1. Fork 仓库，在你自己的 Fork 中创建功能分支，例如 `fix/login-error`。
2. 让每个 PR 聚焦一个问题，遵循周边代码风格；行为、配置或接口变化须同步更新文档。
3. 按修改范围运行检查，写明实际执行的命令、结果和未验证部分。修复逻辑问题时补充能复现问题的测试；文档和默认值调整无需堆叠重复测试。
4. 向本仓库的 `main` 提 PR，在描述中说明问题、改动和验证方式，UI 改动附界面截图。
5. 根据维护者反馈调整，CI 通过且讨论解决后，由维护者手动合并。

不需要仓库写权限就能提交 PR。请勿请求直接推送 `main`、强制推送受保护分支，或通过自动化绕过规则。单人维护阶段不强制要求批准票数，避免维护者自己的 PR 因无人审核而阻塞；这不赋予外部贡献者合并权限。

## 许可证与第三方代码

提交你有权贡献的内容；除非另有明确说明，你的贡献按本项目 Apache License 2.0 提供。不添加来源不明的代码、图片、字体或模型产物。引入或修改第三方代码时，保留其版权与许可声明，更新 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；Apache 2.0 不会替代第三方原有许可证。
