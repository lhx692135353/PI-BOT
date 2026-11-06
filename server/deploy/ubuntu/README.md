# Ubuntu Docker 后端

运行 API（含 `/admin/`）、Worker、Runner、PostgreSQL。从阿里云拉取 GitHub 构建的镜像，服务器不编译项目。只有 API 的 8000 端口对外开放，数据库和 Runner 只在 Compose 网络内通信；联网搜索调用 Tavily SaaS。

## 首次部署

将 `server/deploy/ubuntu` 复制到 Ubuntu，执行：

```sh
sudo bash server/deploy/ubuntu/install.sh
sudo docker login registry.cn-beijing.aliyuncs.com
sudo /opt/pi-bot/deploy.sh
sudo systemctl enable --now pi-bot-update.timer
```

安装脚本使用 [Docker 官方 Ubuntu 软件源](https://docs.docker.com/engine/install/ubuntu/)。已有 Docker 和 Compose 时保留现有安装。

部署文件位于 `/opt/pi-bot`：

| 文件 | 内容 |
|---|---|
| `.env` | 管理员账号、数据库密码、JWT、Runner token、Tavily API Key、vault key；权限 600 |
| `vault.json` | 从 `.env` 生成的模型密钥加密文件；权限 400，UID 1000 供容器读取 |
| `.release.env` | 本次部署的不可变镜像 digest |
| `.previous-release.env` | 上次部署的镜像 digest |

管理员和数据库密码由 16 个随机字节生成（32 个十六进制字符）；JWT 和 Runner 使用 32 个随机字节（64 个十六进制字符）；AES-256 vault key 是 32 个随机字节的 Base64。全部在目标机生成。重复运行 `init-env.py` 保留原密钥，遇到 vault 不一致时拒绝覆盖。

管理员初始账号是 `admin`。在服务器本地查看密码：

```sh
sudo sed -n 's/^PI_BOT_ADMIN_PASSWORD=//p' /opt/pi-bot/.env
```

访问 `http://服务器IP:8000/admin/`。IP + HTTP 用于首次连通验证；正式接入客户端时配置域名、HTTPS 和 WebSocket 转发。可在 `.env` 将绑定地址改为 `127.0.0.1`，由同机反向代理提供入口。

联网搜索只使用 Tavily SaaS。在 `/opt/pi-bot/.env` 填写 `PI_BOT_TAVILY_API_KEY=tvly-...`，留空则不提供搜索工具；运行下方部署命令重新创建服务加载环境变量。后台「用量」页显示剩余 credits，达到套餐或 Key 上限后返回「搜索额度到了」，不使用按量付费额度。升级后旧的 SearXNG 容器会移除，已有数据卷保留。

已有管理员密码保存在数据库中；修改 `.env` 的引导密码不会重置已有账号。

## 自动部署

GitHub Actions 测试通过后构建并推送 `latest` 和 commit SHA 标签。目标机的 systemd timer 每两分钟向阿里云检查 `latest`；只有镜像 ID 变化才更新。无需向 GitHub 上传服务器 SSH 私钥或应用密钥。可从 [Actions 部署文档](https://docs.github.com/en/actions/get-started/continuous-deployment)了解构建与发布流程。

更新时使用文件锁避免并发，保存旧 digest，停止旧 Worker / Runner，然后用不可变 digest 更新并等待健康检查。按当前部署约定，不自动备份数据库。更新失败会写入 `.deployment-failed` 并暂停自动更新，避免持续重启；检查日志后手动运行 `deploy.sh` 恢复。部署成功后删除本仓库的旧镜像和悬空镜像，只保留当前与上一版本，避免旧镜像占满磁盘；正在被容器使用的镜像不会删除。数据库迁移可能使旧镜像不兼容，镜像回退不等于数据库回退。首次服务尚未启动时 timer 不会替代人工完成初次部署。

```sh
sudo systemctl list-timers pi-bot-update.timer
sudo journalctl -u pi-bot-update.service -n 100 --no-pager
sudo docker compose --env-file /opt/pi-bot/.env --env-file /opt/pi-bot/.release.env -f /opt/pi-bot/compose.yml ps
sudo /opt/pi-bot/deploy.sh                  # 立即检查并部署 latest
sudo /opt/pi-bot/deploy.sh <40位commit-SHA>  # 部署指定的 GitHub 构建
sudo systemctl disable --now pi-bot-update.timer  # 暂停自动更新
```

数据库保存在 PostgreSQL 持久卷中；更新应用镜像不会清空数据，也不会生成数据库备份。已有备份文件不自动删除。切勿执行 `docker compose down -v`，它会删除持久数据卷。发布脚本只更新应用镜像；未来变更 Compose 或部署脚本时，需重新同步本目录并运行安装脚本。

该配置针对约 2GB 内存机器限制容器内存并将 Worker 并发设为 2；更大负载需增加内存和调整并发。API 仍为单实例。
