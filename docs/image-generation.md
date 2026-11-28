# CLIProxy 图片生成

在管理后台的「生图」页填写 CLIProxy 地址和 API Key，选择可用模型、默认模型并启用。保存配置不会调用付费接口。密钥使用服务端 vault 加密保存，客户端和 Agent 拿不到供应商密钥。

首批支持：

| 模型 | CLIProxy 接口 |
| --- | --- |
| `grok-imagine-image-2.0` | `POST /v1/images/generations` |
| `gpt-image-2.6-sunburst` | `POST /v1/images/generations` |
| `gemini-3.1-flash-image` | `POST /v1beta/models/gemini-3.1-flash-image:generateContent` |

地址可以填写网关根地址或 `/v1` 地址，例如 `https://proxy.example.com/v1`；反向代理路径前缀会保留。CLIProxy 必须已配置对应供应商凭据和模型访问权限，且支持上述接口。API 部署在容器中时，地址必须从 API 容器可达；`127.0.0.1` 指容器本身。

![生图配置](screenshots/image-generation/image-generation-settings.png)

用户可以直接说「用 gemini-3.1-flash-image 生成一张横版海报……」，也可以省略模型使用后台默认模型。对话会安排云端后台任务；云端和桌面 Pi 执行器都通过服务端提供相同工具：

- `image_models`：查询实际启用的模型与默认模型，不返回网关地址或密钥。
- `image_generate`：根据提示词生成一张图，可选 `model` 和 `aspect_ratio`（`1:1`、`3:2`、`2:3`）。仅可写的交互后台任务可用；对话、只读任务和自动检查不能调用生图接口。

图片作为当前任务的附件保存，桌面、Android 和 iOS 在聊天中自动展示预览，点击可以放大或下载。Agent 可以用 AuiImage 的 artifact_id 把图片组合进卡片或多图布局；已展示的图片不会再重复出现默认预览。同步委托的附件也关联到发起任务。详见 [Generative UI](generative-ui.md)。支持 PNG、JPEG、WebP 静态图片，单张最多 10 MiB。工具只返回文件引用和模型名，不把图片 base64 放进后续模型上下文。生成接口要求 CLIProxy 返回 base64/内联图片，不会自动抓取供应商返回的远程图片 URL。

生图等待上限为三分钟。同一工具调用 ID 在请求外部服务前就会写入持久记录，成功后重放返回原附件，不再次生成。每个用户同时最多一张图在生成。发生超时、中断、供应商失败或进程退出时，提交结果可能无法确认；同一调用不会自动再次调用供应商，避免重复计费。需要重新生成时，由用户明确要求发起新的调用。取消任务或客户端断开会中止等待；供应商已经消耗的额度可能无法退回。

升级时 API、Runner、桌面执行器应同步更新。API 自动应用 `0035-image-generation` 迁移；旧配置默认关闭。

验证包括三种协议适配、图片大小/解码限制、任务权限与用户隔离、幂等和并发、取消后不发布、附件下载，以及后台配置和预览的浏览器测试。测试使用模拟网关，不会消耗真实生图额度。


## 原图标注、裁剪和 AI 编辑

除文生图外，后台任务现在支持：

- `image_read(source)`：读取预览及 EXIF 方向校正后的原图尺寸。`source` 为 `{message_id,image_id}` 或 `{artifact_id}`；模型上下文提供消息图片 ID，输出附件可继续作为来源。
- `image_annotate(source,annotations)`：在原图上叠加 `point`、`text`、`line`、`arrow`、`rectangle`、`circle`。位置使用 0–1 的比例坐标，左上为原点；半径、线宽和字号相对短边，文字 y 是基线。教学图表上的标点使用此工具，不重新生成曲线。
- `image_crop(source,crop)`：按比例坐标独立裁剪，结果是新附件，不覆盖原图。
- `image_edit(source,prompt,model?,mask?,aspect_ratio?)`：基于真实原图编辑；GPT Image 和 Grok 使用 CLIProxy `/v1/images/edits`，Gemini 使用原生接口的图片 parts。省略比例不强制改图为方形；蒙版仅 GPT Image 支持，需透明通道且与原图尺寸一致。

标注和裁剪不依赖 CLIProxy 配置，不产生模型生图费用。容器包含 Noto CJK 字体；直接在 Linux 运行时安装 `fontconfig fonts-noto-cjk`，Windows 使用已安装的中文字体。字体由发行包附带其许可证，KaTeX 字体与服务端中文标注字体独立。

`image_models` 保持 `models` 和 `default_model`，新增各模型的 `capabilities`（generate/edit/mask）及本地 annotation/crop 能力。这描述已接入的协议；网关版本、供应商权限仍须支持对应操作。失败不会自动换模型或改成文生图。

创建图片任务时设置 `expected_output: "image"`，涉及原图时显式传 `image_refs`。服务端校验并传递引用，续接时保留。只有本任务或子任务实际产生、并关联到回复的新图片附件才算完成；输入图片不能当作输出。缺少图片时不会发布成功的最终回答。操作记录包含来源和参数摘要，成功重放复用附件；超时或中断保留未知状态，不自动重复调用收费接口。

数据库迁移 `0037-image-editing` 为新增字段，原始消息图片不重复存储。API、Runner 和桌面执行器应同步升级；旧客户端仍能显示标准图片附件。
