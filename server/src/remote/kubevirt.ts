import { request } from "node:https";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn } from "node:child_process";
import ssh2 from "ssh2";
const { utils } = ssh2;
import type { Settings } from "../config.js";
import { connectSsh, type RemoteConnection } from "./transport.js";
import type { Row } from "../db.js";
export function vmCredentials() {
  const login = utils.generateKeyPairSync("ed25519"),
    host = utils.generateKeyPairSync("ed25519");
  return {
    private_key: login.private,
    public_key: login.public,
    host_private: host.private,
    host_public: host.public,
  };
}
export function vmResources(
  id: string,
  s: Settings["kubevirt"],
  credentials: ReturnType<typeof vmCredentials>,
) {
  const name = "pibot-" + id.replace(/-/g, ""),
    labels = { "pibot.io/environment": id },
    metadata = { name, namespace: s.namespace, labels };
  const cloud = {
    users: [
      {
        name: "pibot",
        shell: "/bin/bash",
        lock_passwd: true,
        ssh_authorized_keys: [credentials.public_key],
      },
    ],
    ssh_keys: {
      ed25519_private: credentials.host_private,
      ed25519_public: credentials.host_public,
    },
    runcmd: [
      [
        "systemctl",
        "enable",
        "--now",
        "pibot-desktop.service",
        "pibot-remote.service",
      ],
    ],
  };
  return {
    name,
    secret: {
      apiVersion: "v1",
      kind: "Secret",
      metadata,
      stringData: { userdata: "#cloud-config\n" + JSON.stringify(cloud) },
    },
    disk: {
      apiVersion: "cdi.kubevirt.io/v1beta1",
      kind: "DataVolume",
      metadata,
      spec: {
        source: { http: { url: s.imageUrl } },
        pvc: {
          accessModes: ["ReadWriteOnce"],
          resources: { requests: { storage: s.disk } },
          ...(s.storageClass ? { storageClassName: s.storageClass } : {}),
        },
      },
    },
    vm: {
      apiVersion: "kubevirt.io/v1",
      kind: "VirtualMachine",
      metadata,
      spec: {
        runStrategy: "Always",
        template: {
          metadata: { labels },
          spec: {
            domain: {
              cpu: { cores: s.cpu },
              resources: { requests: { memory: s.memory } },
              devices: {
                disks: [
                  { name: "root", disk: { bus: "virtio" } },
                  { name: "cloudinit", disk: { bus: "virtio" } },
                ],
                interfaces: [{ name: "default", masquerade: {} }],
              },
            },
            networks: [{ name: "default", pod: {} }],
            volumes: [
              { name: "root", dataVolume: { name } },
              { name: "cloudinit", cloudInitNoCloud: { secretRef: { name } } },
            ],
          },
        },
      },
    },
  };
}
export class Kubevirt {
  constructor(private s: Settings["kubevirt"]) {}
  async api(path: string, method = "GET", body?: object): Promise<any> {
    const [token, ca] = await Promise.all([
      readFile(this.s.tokenFile!, "utf8"),
      readFile(this.s.caFile!),
    ]);
    const url = new URL(path, this.s.server);
    if (url.protocol !== "https:")
      throw new Error("Kubernetes API 必须使用 HTTPS");
    return new Promise((resolve, reject) => {
      const req = request(
        url,
        {
          method,
          ca,
          headers: {
            Authorization: "Bearer " + token.trim(),
            "Content-Type": "application/json",
          },
          timeout: 20000,
        },
        (res) => {
          let data = "";
          res.on("data", (b) => {
            data += b;
            if (data.length > 4_000_000) req.destroy();
          });
          res.on("end", () => {
            let value: any;
            try {
              value = JSON.parse(data);
            } catch {
              return reject(new Error("Kubernetes API 返回无效结果"));
            }
            resolve({ status: res.statusCode, body: value });
          });
        },
      );
      req.on("error", () => reject(new Error("Kubernetes API 连接失败")));
      req.on("timeout", () => req.destroy());
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async ensure(id: string, secret: ReturnType<typeof vmCredentials>) {
    const r = vmResources(id, this.s, secret),
      ns = encodeURIComponent(this.s.namespace);
    for (const [base, resource] of [
      [`/api/v1/namespaces/${ns}/secrets`, r.secret],
      [`/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes`, r.disk],
      [`/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachines`, r.vm],
    ] as const) {
      let response = await this.api(base + "/" + r.name);
      if (response.status === 404)
        response = await this.api(base, "POST", resource);
      if (response.status === 409)
        response = await this.api(base + "/" + r.name);
      if (
        response.status < 200 ||
        response.status >= 300 ||
        response.body.metadata?.labels?.["pibot.io/environment"] !== id
      )
        throw new Error(
          "KubeVirt 资源创建失败或资源归属不匹配，请检查 RBAC、镜像及存储",
        );
    }
    const end = Date.now() + this.s.timeoutSeconds * 1000;
    while (Date.now() < end) {
      const disk = await this.api(
        `/apis/cdi.kubevirt.io/v1beta1/namespaces/${ns}/datavolumes/${r.name}`,
      );
      if (disk.body.status?.phase === "Failed")
        throw new Error("虚机磁盘镜像导入失败，请检查镜像地址及存储");
      const vmi = await this.api(
        `/apis/kubevirt.io/v1/namespaces/${ns}/virtualmachineinstances/${r.name}`,
      );
      if (vmi.status === 200 && vmi.body.status?.phase === "Running")
        return r.name;
      if (vmi.status !== 404 && vmi.status !== 200)
        throw new Error("无法查询虚机状态，请检查集群权限");
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    throw new Error("虚机启动超时，已保留资源，下次连接继续检查");
  }
  async connect(
    env: Row,
    secret: ReturnType<typeof vmCredentials>,
  ): Promise<RemoteConnection> {
    const name = await this.ensure(env.environment_id, secret),
      dir = await mkdtemp(join(tmpdir(), "pibot-kube-"));
    const file = join(dir, "config");
    const token = (await readFile(this.s.tokenFile!, "utf8")).trim(),
      ca = (await readFile(this.s.caFile!)).toString("base64");
    await writeFile(
      file,
      JSON.stringify({
        apiVersion: "v1",
        kind: "Config",
        clusters: [
          {
            name: "cluster",
            cluster: {
              server: this.s.server,
              "certificate-authority-data": ca,
            },
          },
        ],
        users: [{ name: "pibot", user: { token } }],
        contexts: [
          {
            name: "pibot",
            context: {
              cluster: "cluster",
              user: "pibot",
              namespace: this.s.namespace,
            },
          },
        ],
        "current-context": "pibot",
      }),
      { mode: 0o600 },
    );
    const listener = createServer();
    await new Promise<void>((r) => listener.listen(0, "127.0.0.1", r));
    const port = (listener.address() as any).port;
    await new Promise<void>((r) => listener.close(() => r()));
    const child = spawn(
      this.s.virtctl,
      [
        "--kubeconfig",
        file,
        "port-forward",
        "--address",
        "127.0.0.1",
        `vmi/${name}`,
        `${port}:22`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let error = false;
    child.on("error", () => {
      error = true;
    });
    child.on("exit", () => {
      error = true;
    });
    child.stdout.resume();
    child.stderr.resume();
    const cleanup = () => {
      child.kill("SIGTERM");
      void rm(dir, { recursive: true, force: true });
    };
    const hostKey = utils.parseKey(secret.host_private);
    if (hostKey instanceof Error) {
      cleanup();
      throw new Error("虚机主机密钥无效");
    }
    const { fingerprint } = await import("./transport.js");
    for (let attempt = 0; attempt < 30 && !error; attempt++) {
      try {
        return await connectSsh(
          {
            host: "127.0.0.1",
            port,
            username: "pibot",
            fingerprint: fingerprint(hostKey.getPublicSSH()),
            work_root: "/home/pibot/workspaces",
          },
          secret,
          cleanup,
        );
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
    cleanup();
    throw new Error("虚机 SSH 尚未就绪，请检查 cloud-init 和操作组件");
  }
}
