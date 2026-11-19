# 第三方代码与许可声明

根目录的 Apache License 2.0 适用于本项目原创内容，不改变第三方内容的版权与许可证。

## Pi Hermes Memory

- 上游：<https://github.com/chandra447/pi-hermes-memory>
- 基准版本：npm `0.9.10`
- 版权：Copyright (c) 2025 Chandra Teja
- 许可证：MIT，完整文本见 [原有 LICENSE](packages/agent/src/hermes-memory/LICENSE)
- 目录：`packages/agent/src/hermes-memory/`
- 修改说明：[managed-storage fork](packages/agent/src/hermes-memory/README.md)；保留内容扫描和查询规范化，调整写入策略，并将持久化、搜索历史、后台审核迁移到按 Bot 隔离的 PostgreSQL 服务。

分发涉及该代码的源代码或构建产物时，应附带上述版权和完整 MIT 许可；不能仅附根目录的 Apache 2.0。

## 包管理器依赖

项目通过 npm、Gradle 和容器镜像使用其他开源组件，它们分别遵循各自许可证。`package-lock.json` 和 Android 版本目录记录依赖版本；依赖包自身的 LICENSE/NOTICE 应在再分发时保留。本文件不是全部传递依赖的法律审计或 SBOM。引入新的内置第三方代码时，请在这里记录来源、版本、许可证和本地修改。


## 云端操作依赖

- `ssh2`：npm 锁定版本 1.17.0，MIT；来源 <https://github.com/mscdex/ssh2>。用于 SSH、SFTP 和虚机内端口转发，未修改依赖源码。
- `@novnc/novnc`：npm 锁定版本 1.7.0；来源 <https://github.com/novnc/noVNC>。核心库采用 MPL-2.0，具体组件遵循包内 LICENSE／AUTHORS；服务端按原文件提供 core／vendor JavaScript，未修改依赖源码。发布镜像保留 npm 包中的许可文件。
- `playwright`：虚机组件锁定版本 1.58.2，Apache-2.0；来源 <https://github.com/microsoft/playwright>。浏览器二进制及系统组件保留各自许可证，由虚机安装脚本安装；未将它们作为本项目原创代码重新许可。

## pstack

- 上游：<https://github.com/michael-denyer/pstack-claude/tree/a12b04786023e762f12f5de7bb5fafb8c23f8c36>
- 许可证：MIT，完整文本见 [pstack-LICENSE](packages/agent/src/pstack-LICENSE)。
- 修改说明：在 Pi Bot 内实现小修、完整开发、验证和只读审查的流程，复用 Pi Bot 的执行工具、模型代理和权限。

## 桌面端浏览器和 Electron 测试依赖

- `playwright` 和 `playwright-core`：桌面运行时锁定版本 1.65.1，Apache-2.0；来源 <https://github.com/microsoft/playwright>。打包保留依赖的许可文件。浏览器由用户安装，遵循各自的许可证。

## 文档引擎

随 npm 依赖分发，保留每个包内的 LICENSE/NOTICE，未修改上游源码：

- PDF.js (`pdfjs-dist` 6.5.438)：Apache-2.0；https://github.com/mozilla/pdf.js 。提供 PDF 文字读取。
- Mammoth 1.13.0：BSD-2-Clause；https://github.com/mwilliamson/mammoth.js 。提供 DOCX 内容读取。
- docx 9.15.4：MIT；https://github.com/dolanmiu/docx 。提供 DOCX 编写。
- ExcelJS 4.4.0：MIT；https://github.com/exceljs/exceljs 。提供 XLSX 读写。
- JSZip 3.10.1：选用 MIT 许可（上游提供 MIT/GPL-3.0 双许可）；https://github.com/Stuk/jszip 。用于 Office ZIP 格式验证。

文档操作在有超时和堆内存限制的独立 Node 子进程中运行；内置技能为本项目原创说明，不安装或执行第三方 skill 包。

## sharp / libvips

Model-only image derivatives use sharp (Apache-2.0) and its prebuilt libvips
runtime (LGPL-3.0-or-later and bundled codec licenses). Originals are not modified.
The optional platform packages include their own LICENSE/NOTICE files; these are
retained under node_modules in the server and packaged desktop runtime.
See https://sharp.pixelplumbing.com/ and https://www.libvips.org/.
