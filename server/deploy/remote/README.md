# 云端操作环境

首版支持 Ubuntu 24.04 LTS amd64。API、Worker、Runner 和两端客户端应一起升级；默认 `PI_BOT_REMOTE_BACKEND=none` 不开启机器操作。SSH／KubeVirt 是全局互斥后端，每用户一台云端机器，和现有用户电脑分别管理。

## SSH：管理员准备虚机

推荐使用 Ubuntu 官方 **Ubuntu Server 24.04 LTS amd64** 安装镜像，或 **Ubuntu 24.04 Server Cloud Image amd64**。普通容器、只有终端依赖的最小镜像和 Windows 不属于本版本支持环境。

1. 将仓库的 `server/remote-guest/` 和 `server/deploy/remote/` 一起复制到虚机，保持目录关系。管理员运行 `sudo bash server/deploy/remote/install.sh`。脚本会安装 Node.js 24、固定版本 Playwright／Chromium、Xfce、Xvfb、VNC、中文字体以及 systemd 服务；联网下载及 apt 软件源需要可用。
2. 为专用非 root 用户 `pibot` 配置 SSH 公钥，确认 SFTP 可用。默认工作目录 `/home/pibot/workspaces`，每个 Bot 使用自己的 slug 子目录和 `.browser` 登录资料目录。
3. 运行 `sudo -u pibot bash server/deploy/remote/healthcheck.sh`。预期返回 version 1，能力包含 shell、files、browser、desktop、vnc；记录输出的 SSH 主机 SHA256 指纹。
4. API 和 Worker 启动配置填写 `PI_BOT_REMOTE_BACKEND=ssh`，保留现有 vault 配置。在管理后台的用户列表点击“云端环境”，填写地址、端口、`pibot` 用户名、指纹、工作目录及私钥／密码，然后运行连接和能力检测。

浏览器使用有界面 Chromium，保留其沙箱。Ubuntu 24.04 的 AppArmor 用户命名空间规则由脚本为固定 Chromium 可执行文件安装；升级 Chromium 后重新运行安装脚本。虚机不要求 sudo 授权给智能体。

运行 `systemctl status pibot-desktop pibot-remote`、`journalctl -u pibot-remote` 检查组件。VNC 的 5901（控制）和 5902（只读）只监听虚机 localhost，不应对外开放。图形环境需要由这两个服务维护，不连接原有其他登录桌面。

## KubeVirt：自动创建每用户虚机

集群需预先安装 KubeVirt 和 CDI，具有可用 StorageClass，并能访问镜像 URL。服务端不会安装集群组件。API 需要 `virtctl`，版本应与目标集群匹配。

1. 从 [Ubuntu 官方镜像站](https://cloud-images.ubuntu.com/noble/current/) 下载 `noble-server-cloudimg-amd64.img`，按站点提供的 SHA256SUMS 核对。
2. 在 Linux 构建机安装 `libguestfs-tools qemu-utils`，运行：

   ```sh
   bash server/deploy/remote/build-image.sh noble-server-cloudimg-amd64.img pibot-ubuntu-24.04.qcow2
   ```

   脚本默认创建 16GiB 的构建磁盘并扩展官方镜像的根分区，为桌面及浏览器安装预留空间；可用 `PI_BOT_IMAGE_SIZE` 调整，发布磁盘应小于目标 PVC 的可用容量。脚本创建新的输出文件，不覆盖输入；使用相同安装脚本准备环境，清理镜像中的主机密钥和身份。首次构建需要联网。输出的 qcow2 可通过 HTTP(S) 镜像服务器供 CDI 导入；必须使用你自己可控、校验过的固定镜像地址。
3. 参考 `rbac.yaml` 在专用 namespace 创建 ServiceAccount／Role／RoleBinding。API 只需读取和创建 Secret、VM、VMI、DataVolume 以及 VMI SSH 转发，不具有删除虚机或磁盘的权限。
4. 在 `.env` 或启动环境填写：

   ```dotenv
   PI_BOT_REMOTE_BACKEND=kubevirt
   PI_BOT_K8S_SERVER=https://kubernetes.default.svc
   PI_BOT_K8S_TOKEN_FILE=/var/run/secrets/kubernetes.io/serviceaccount/token
   PI_BOT_K8S_CA_FILE=/var/run/secrets/kubernetes.io/serviceaccount/ca.crt
   PI_BOT_K8S_NAMESPACE=pibot
   PI_BOT_KUBEVIRT_IMAGE_URL=https://images.example.com/pibot-ubuntu-24.04.qcow2
   PI_BOT_KUBEVIRT_STORAGE_CLASS=your-storage-class
   PI_BOT_KUBEVIRT_CPU=2
   PI_BOT_KUBEVIRT_MEMORY=4Gi
   PI_BOT_KUBEVIRT_DISK=40Gi
   PI_BOT_REMOTE_READY_SECONDS=300
   PI_BOT_VIRTCTL_PATH=/usr/local/bin/virtctl
   ```

   API 挂载 CA 和 Token；Token 每次 API 请求和创建隧道时重新读取。Worker 需要相同后端设置以校验目标和认领轮次，但不读取集群 Token。Runner 无需集群或 SSH 凭据。
5. 首次云端任务或打开“云端桌面与文件”时创建环境。数据库先持久保存专属登录／主机密钥，再以环境 ID 生成稳定资源名 `pibot-<environment UUID without dashes>`，创建 cloud-init Secret、CDI DataVolume 和 VM；并发和失败重试复用原资源。VM 从 DataVolume 引用持久根磁盘，`runStrategy=Always`。cloud-init 注入每台 VM 独立的 SSH 登录公钥和主机密钥。

首次导入慢时调大准备超时。镜像导入失败查看 `kubectl -n pibot describe dv <name>`；启动失败查看 VM、VMI 事件和 cloud-init；连接失败检查 `virtctl` 版本、转发权限、镜像中的服务和 SSH。

## Docker／Kubernetes 部署

- 镜像默认不安装 virtctl；需要 KubeVirt 时用 `docker build --build-arg VIRTCTL_VERSION=v<与集群匹配的版本> -f server/Dockerfile .` 构建，或者把可执行文件只读挂载进 API 并设置路径。
- Compose 的配置文件传入所有环境参数；使用额外 Compose override 将 Token、CA 和可选 virtctl 挂载到 API。不要把集群 Token 放入仓库。启动配置仍使用现有 `.env`；不会增加另一套配置优先级。
- Kubernetes 的 API Deployment 配置 `serviceAccountName: pibot-virtualization`，在 `pibot` Secret 中添加上述启动配置；Worker 设置同一后端类型。外部集群则将 Token／CA 放入 Secret 后挂载 API。保留 API 单副本约束，SSH 会话和人工接管锁都在 API 进程中。
- 反向代理需转发 `/ws/remote-desktop` 的 WebSocket，保留现有 URL 路径前缀；生产使用 HTTPS。端口不需要暴露 VNC 或 VM SSH。
- 云端桌面入口使用仅限本人环境／Bot 的短期页面凭据，页面再换取一次性的一分钟 WebSocket 票据；页面凭据一小时过期后需从客户端重新打开。

## 使用及限制

- 桌面端在 Bot 资料侧栏点击“云端桌面与文件”；Android 在对话更多菜单打开同名入口。共用浏览器页面，支持只读查看、人工接管和释放控制；手机可用工具栏“发送文字”向当前远端输入框输入中文或登录信息，文字不进入 Agent 上下文。文件页支持浏览、文本／图片预览及上传下载（单文件上传最多 100MiB）。其他类型下载后打开。
- 云端生成文件在原虚机保存，Agent 用 `artifact` 登记结果。文件 API 和图形连接都校验用户与环境归属。云端文件不会自动同步至电脑。
- 每 Bot 独立目录不等同于操作系统沙箱；同一用户的 Bot 共用 Linux 账号和 VM。文件工具检查目录，shell 权限仍由该 Linux 账号决定。目录外文件工具访问沿用逐任务审批。
- 人工接管使用 45 秒租约，每 15 秒续期；断线或过期释放。接管前取消正在运行的命令和界面操作，并等待结束。接管结束后智能体必须重新截图或读取页面再进行界面操作，未确认的命令不会自动重放。
- 一台 VM 的界面操作按任务串行，其他任务收到忙碌原因；可在原任务后重试或由用户安排后续任务。普通电脑操作离线立即说明；旧客户端沿用原来的排队行为，不获得新增云端能力。
- 持续目标按机器分组，不增加固定时间任务。历史目标保持原电脑；无法确定目标的记录等待用户指定。任务的机器不会因当前客户端变化而迁移。
- 删除用户不会删除 KubeVirt VM、Secret、DataVolume 或 PVC。管理员按环境标签 `pibot.io/environment` 核对并手工清理；删除前先备份磁盘。备份数据库时也要保管 vault 文件，否则无法解密 SSH 凭据。

## 验证清单

自动化测试入口：

```sh
PI_BOT_TEST_DATABASE_URL=postgresql://... node --import tsx --test --test-concurrency=1 server/tests/remote.test.ts
npm run typecheck
npm run build
cd android && ./gradlew :app:testDebugUnitTest :app:assembleDebug
```

数据库必须是可清空的测试库；测试会重建 public schema。测试覆盖真实 SSH 协议通道、模拟远端组件与虚机 API、任务固定目标、重复调用、接管互斥、符号链接、命令取消、目标分组和 Worker／Runner／API 调用链。真实 Ubuntu 图形环境与真实 KubeVirt 集群需要另行验收，不能用模拟测试替代：

1. SSH 模式保存／更新私钥、错误指纹拒绝、SFTP 文件往返、目录外审批、长命令取消及断网后核实。
2. 云端浏览器登录、中文输入、点击、截图、网站上传下载；换 Bot 后确认资料目录独立。
3. 桌面与安卓均查看、接管、释放；接管期间启动 Agent 操作应被阻止；断开后租约释放并要求重新读界面。
4. 同用户并发首次请求只得到一台 VM；模拟磁盘导入失败／启动超时后重试不重复创建；重启 VM 后文件仍在。
5. 桌面新任务在当前电脑，安卓新操作在云端；从安卓追问桌面文件仍定位原电脑，离线不转移。
6. 为同 Bot 建立电脑和云端两个目标，确认各自只访问对应环境，安静轮次不通知，重要回报不重复。


真实虚机的可选自动化验收入口（只在你显式提供的测试虚机运行；会在单独的 `acceptance-*` 资料库中写测试文件、启动临时 HTTP 服务并操作浏览器）：

```sh
PI_BOT_REMOTE_TEST_HOST=your-test-vm \
PI_BOT_REMOTE_TEST_USER=pibot \
PI_BOT_REMOTE_TEST_KEY=/absolute/path/to/test-key \
PI_BOT_REMOTE_TEST_FINGERPRINT=SHA256:your-host-fingerprint \
node --import tsx --test server/tests/remote-live.test.ts
```

也支持 `PI_BOT_REMOTE_TEST_PORT` 和 `PI_BOT_REMOTE_TEST_PASSWORD`。测试完成后临时服务会停止，验收资料库保留供检查。镜像和规格配置改变只作用于之后创建的环境，不会自动改动已有 VM 或磁盘。
