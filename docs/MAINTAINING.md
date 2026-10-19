# 维护与开源发布

适用于个人仓库 `lhx692135353/PI-BOT`，维护者为 `@lhx692135353`。本文件和 JSON 模板记录目标配置；**把文件放进仓库不会自动修改 GitHub 设置**。

## main 的目标规则

模板：[.github/rulesets/main.json](../.github/rulesets/main.json)。

| 项目 | 配置 |
| --- | --- |
| 范围 | `refs/heads/main`，Enforcement 为 Active |
| 修改入口 | 必须通过 Pull Request |
| 批准人数 | 0；维护者不能批准自己的 PR，单人阶段不强制批准 |
| Code owner 审核 | 不设为必需；CODEOWNERS 仅自动请求维护者审核 |
| 讨论 | 合并前解决所有 review 讨论 |
| CI | GitHub Actions 的 `Project checks` 必须通过 |
| 分支更新 | 合并前与最新 main 同步，并重新通过检查 |
| 强推 / 删除 | 均禁止 |
| 绕过角色 | 空；管理员也按流程操作 |

不向普通贡献者授予 Write、Maintain 或 Admin 权限；他们通过 Fork 提 PR。批准人数为 0 不会给普通访客合并权限。只有仓库所有者或已有写权限的人可以合并，以后邀请协作者前须重新评估权限和审核规则。

推荐仅允许 Squash merge，合并后自动删除功能分支，不启用自动合并。规则可以约束普通 Git 推送和 PR 合并，但管理员仍能修改规则本身；不要共享管理员令牌。

## 首次启用顺序

1. 先在私有仓库提交开源准备改动，通过 PR 运行新 CI 并合并，让 main 包含 `ci.yml`。不要在 CI 尚不存在时先要求 `Project checks`，否则 PR 会一直等待检查。
2. 检查当前目录及全部拟公开的 Git 历史、分支与 tag，处理真实泄漏，核实第三方许可与素材来源。扫描工具只能辅助，不能证明不存在敏感信息。
3. 设置 main 规则并确认生效；如果账号方案不支持私有仓库规则，先保存规则草案，在公开后立即激活。公开仓库可使用 GitHub Free 的分支规则。
4. 最后在 Settings → General → Danger Zone → Change repository visibility 改为 Public，再核实保护状态、许可识别和 PR 检查。公开后别人可能复制代码，改回 Private 无法收回已有副本。
5. 在 Settings → Code security and analysis 中启用可用的 Secret scanning、Push protection 和 Private vulnerability reporting，以实际账号和方案支持情况为准。

## 使用 GitHub 网页配置

Settings → Rules → Rulesets → New ruleset → New branch ruleset，按上表创建规则；也可用 Import a ruleset 导入模板。确认 Enforcement 为 Active，目标 main，Bypass list 为空，状态检查来自 GitHub Actions。

如果已有规则，先检查其要求，与模板合并，保留更严格且适用于当前团队的设置，不直接覆盖或创建重复规则。

## 使用 gh 配置

先运行 `gh auth login`，认证仓库所有者账号。Token 需要本仓库 Administration 写权限；仅有 Contents 权限的连接器不能完成这些设置。

```sh
gh repo view lhx692135353/PI-BOT --json visibility,defaultBranchRef,viewerPermission
gh api repos/lhx692135353/PI-BOT/rulesets
```

CI 已运行、确认没有需要合并的既有规则后，从仓库根目录创建：

```sh
gh api --method POST repos/lhx692135353/PI-BOT/rulesets \
  --input .github/rulesets/main.json
gh repo edit lhx692135353/PI-BOT \
  --enable-squash-merge --enable-merge-commit=false --enable-rebase-merge=false \
  --delete-branch-on-merge --enable-auto-merge=false
```

修改已有同名规则时，先读取完整内容，使用 PUT 到 `repos/lhx692135353/PI-BOT/rulesets/RULESET_ID`，不要盲目 POST 或删除已有规则。

完成发布检查后，显式公开仓库并核实实际生效规则：

```sh
gh repo edit lhx692135353/PI-BOT --visibility public --accept-visibility-change-consequences
gh repo view lhx692135353/PI-BOT --json visibility
gh api repos/lhx692135353/PI-BOT/rules/branches/main
```

核实输出包含 PR、状态检查、禁止删除和禁止强推的要求。若没有，先修正规则后再接受贡献。

## 日常开发

```sh
git switch main
git pull --ff-only
git switch -c fix/short-description
# 修改并验证后，只添加本次修改的文件
git add <本次修改的文件>
git commit -m "fix: describe the change"
git push -u origin HEAD
gh pr create --base main
```

等待 `Project checks` 通过并解决讨论，再由维护者 Squash merge。不直接 push main，不用管理员 bypass；不能合并时先查看阻塞原因。外部贡献者的首次 Actions 运行可能需要维护者批准，先确认代码再允许运行。

## CI 与镜像发布

- `ci.yml` 对所有指向 main 的 PR 和 main 推送运行，权限只读，不使用部署密钥；包括类型检查、PostgreSQL 集成测试、构建和 Ubuntu 脚本测试，不覆盖 Android 和 macOS 安装包签名。
- `server-image.yml` 是维护者的镜像发布工作流，在匹配路径的 main 推送或手动触发后验证并发布。`ALIYUN_REGISTRY_USER` 和 `ALIYUN_REGISTRY_PASSWORD` 只放 GitHub Actions Secrets。
- Fork 发布自己的镜像前，应修改 registry、image tags 和部署清单，配置自己的凭据。
- 不把镜像发布作为 PR 的必需检查，以免外部贡献被部署凭据阻塞。

## 发布前检查

检查 LICENSE、NOTICE、第三方声明和启动文档；运行完整 Node.js 检查，并按改动范围运行 Android/Mac 构建。分发镜像、Mac 安装包或 APK 时，保留项目许可与内置 Hermes Memory 的 MIT 文本，相关构建已包含这些文件。包管理器依赖自身的许可也须保留。

可使用 Gitleaks 扫描完整 Git 历史：

```sh
gitleaks git . --redact=100 --log-opts=--all
```

测试值或类型名可能误报，必须逐项核实，不能自动忽略所有测试文件。发现真实凭据时，先轮换并评估历史清理；不要为通过扫描而擅自改写历史、扩大忽略规则或关闭保护。
