# 设备身份、消息来源与执行经验

对应 #67，关联 #62；完整已批准规格见任务目录 `../device-refactor-spec.md`。

桌面登录在已有账号令牌授权下注册。`hardware_fingerprint` 为可选的 `v1:<sha256>`：macOS 使用 IOPlatformUUID，Linux 优先 DMI product UUID、其次 machine-id，Windows 使用 CIM UUID。标识采集失败就省略指纹，继续公钥注册；不使用 hostname、随机数伪造稳定身份。不会上传原始标识。

服务端按账号加锁，优先匹配未吊销公钥，其次只归并唯一未吊销指纹。零或多命中新建；同名不归并、跨账号不归并、吊销不复活。归并沿用 device_id、增加 key_version，并在 device_key_rotations 留下旧/新公钥哈希审计。旧 socket 被断开，HTTP 签名、模型令牌、socket 握手和执行事件均重新检查当前密钥版本。旧客户端不提供指纹仍兼容；旧模型令牌仅在 key_version=0 时有效。桌面显示重绑提示。

每条用户消息有独立 provenance（client、可选 device_id/device_label）；入口为 android/ios 时标记 cloud，web 独立，历史缺失来源为 unknown。来源设备必须属于账号且未吊销。任务转发保留原消息来源快照，历史和当前消息分别进入模型上下文。语音转写逐条保存来源，不能用后一次消息覆盖前一次来源。

endpoint_experiences 是每 bot 的追加式执行证据。只在任务终结时从真实工具事件记录实际执行 target、能力、工具调用证据、时间和实际文件操作路径。manifest、在线宣告、任务要求均不能建立已观察能力或路径。没有磁盘扫描或定时采集。失败记录为 conflict；endpoint_experience 工具允许 AI 在核查后引用同一 bot/端/能力/路径的更新成功证据解决冲突，旧条目保留。经验不是授权，也不证明历史路径目前存在。

AI 通过 start_task/ask_agent 的结构化参数决定执行端：明确本轮设备 > resource_key 精确匹配的唯一且无未解决冲突的经验资源 > 纯文字/搜索 cloud > 询问。resources 可直接携带已知真实来源；服务器检查归属。不会解析用户文本中的危险关键字来推断意图。无目标但要求机器能力时返回澄清错误；浏览器/Electron 测试也不能仅凭来源或在线候选自动选机。AI 用一句话说明所选端和理由，用户可以覆盖。

任务创建前验证目标在线和能力/资源约束。明确离线不会保存任务、排队或改派；连接在开始前消失时失败，运行后不换端、不重放外部动作。CLI 只使用其绑定端，离线直接报错。替代方案由用户选择（连接原机、确认其他电脑资源或改用云端）。已有审批和 sandbox 规则保持不变。

## 验证

- `npm run typecheck`（含生成的 runtime contracts 一致性）
- `npm run openapi --workspace=@pi-bot/server` 后运行 route-registry 测试
- `node --import tsx --test --test-timeout=15000 packages/agent/tests/endpoint-experience.test.ts server/tests/device-identity-decision.test.ts server/tests/browser-test-routing.test.ts server/tests/task-routing.test.ts server/tests/devices.test.ts server/tests/route-registry.test.ts packages/agent/tests/memory-extension.test.ts`
- `npm run build`

PostgreSQL 专用测试需要隔离测试库 PI_BOT_TEST_DATABASE_URL，包含并发注册和迁移测试；会重建该测试库，不能指向生产库。已使用 supervisor 提供的隔离 PostgreSQL（127.0.0.1:55437 的 pibot_device_test）执行真实迁移、并发注册、工具终结账本、CLI、路由、Worker/Runner、语音与桌面集成测试；未访问生产服务。真实系统硬件采集通过注入探针测试三平台与失败回退，实际 OS/重装验证仍需平台 CI。当前无沙箱监听限制，本地 HTTP、WebSocket、Electron 集成已实际运行。配置式浏览器测试仍需显式配置浏览器；依赖 /usr/bin/flock 的手机控制测试仅在 Linux CI 运行。GitHub CI 尚未核实。

## 安全边界

硬件指纹只是辅助身份线索，可克隆/伪造；持有账号登录权限的客户端仍可提供相同指纹。它不是认证凭据或硬件证明。哈希仍有可关联性，不应公开设备表或审计表。轮换会终止已有执行，应先核查未知外部操作结果。经验与来源均作为带证据的上下文，不能扩大磁盘访问权限。

Linux 的 `/etc/machine-id` 回退仅有“当前 OS 安装内”的稳定性，重装可能改变；不能宣称它是稳定硬件标识。全 0 和全 f 被视为已知占位值；由 0/f 混合组成的合法 UUID 不会被拒绝。

账本通过 `(run_id, tool_call_id)` 幂等记录，同一路径的不同调用保留独立证据。终结读取独立的 endpoint_observations，不依赖时间线最后 50 条工具摘要。cloud 执行也记录为真实 cloud target；不会将移动入口当成执行设备。上下文按 target/能力/资源聚合，每个 target 最多 200 组、每组 5 条近期证据；资源精确查询使用完整账本，不受上下文摘要截断影响。

本地最终验收（2026-11-18）：隔离 PostgreSQL 全量 407 项，359 通过、0 失败、48 条件跳过；typecheck、build、生成契约一致性和 git diff --check 均通过。详见任务目录 implementation-result.md 和 acceptance-full-db.log。GitHub 及其余平台检查仍待 supervisor 验证。
