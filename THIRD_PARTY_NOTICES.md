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
