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
