import { RuntimeError, errorInfo } from "@pi-bot/runtime-contracts";
import { Client, type SFTPWrapper, type ClientChannel } from "ssh2";
import { createHash } from "node:crypto";
import type { Duplex } from "node:stream";
import { z } from "zod";
export const sshConfig = z.object({
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .refine((s) => !/[\s\x00]/.test(s)),
  port: z.number().int().min(1).max(65535).default(22),
  username: z
    .string()
    .regex(/^[a-z_][a-z0-9_-]{0,63}$/i)
    .default("pibot"),
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}=?$/),
  work_root: z
    .string()
    .regex(/^\/[a-zA-Z0-9_./-]+$/)
    .default("/home/pibot/workspaces"),
});
export const sshSecret = z
  .object({
    private_key: z.string().max(65536).optional(),
    passphrase: z.string().max(1000).optional(),
    password: z.string().max(1000).optional(),
  })
  .refine((v) => !!v.private_key || !!v.password, "需要 SSH 私钥或密码");
export type SshConfig = z.infer<typeof sshConfig>;
export type SshSecret = z.infer<typeof sshSecret>;
export interface RemoteConnection {
  alive?(): boolean;
  call(request: object, signal?: AbortSignal): Promise<any>;
  sftp(): Promise<SFTPWrapper>;
  forward(port: number): Promise<Duplex>;
  close(): void;
}
export function fingerprint(key: Buffer) {
  return (
    "SHA256:" +
    createHash("sha256").update(key).digest("base64").replace(/=+$/, "")
  );
}
export async function connectSsh(
  config: SshConfig,
  secret: SshSecret,
  cleanup = () => {},
): Promise<RemoteConnection> {
  const client = new Client();
  try {
    await new Promise<void>((resolve, reject) => {
      client
        .once("ready", resolve)
        .once("error", () =>
          reject(new RuntimeError({code:"transport_closed",scope:"ssh",retryable:false,outcome:"not_started",message:"SSH 连接失败，请检查网络、凭据和主机指纹"})),
        )
        .connect({
          host: config.host,
          port: config.port,
          username: config.username,
          privateKey: secret.private_key,
          passphrase: secret.passphrase,
          password: secret.password,
          hostVerifier: (key: Buffer) =>
            fingerprint(key) === config.fingerprint.replace(/=+$/, ""),
          readyTimeout: 15000,
          keepaliveInterval: 10000,
          keepaliveCountMax: 3,
        });
    });
  } catch (e) {
    client.destroy();
    throw e;
  }
  let alive = true;
  client.once("close", () => {
    alive = false;
    cleanup();
  });
  client.on("error", () => {});
  const call = async (request: object, signal?: AbortSignal) => {
    if (signal?.aborted) throw new Error("操作已取消");
    return new Promise<any>((resolve, reject) => {
      let channel: ClientChannel | undefined,
        output = "",
        settled = false;
      const finish = (error?: Error, value?: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value);
      };
      const abort = () => {
        channel?.signal("TERM");
        channel?.destroy();
        finish(new RuntimeError({code:"result_unknown",scope:"ssh",retryable:false,outcome:"unknown",message:"操作已取消，未确认结果的操作不可重放"}));
      };
      const timer = setTimeout(() => {
        abort();
      }, 625000);
      signal?.addEventListener("abort", abort, { once: true });
      client.exec("node /opt/pibot-remote/client.mjs", (error, stream) => {
        if (error) return finish(new Error("云端操作组件无法启动"));
        channel = stream;
        if (settled) {
          stream.destroy();
          return;
        }
        stream.on("data", (b: Buffer) => {
          output += b.toString();
          if (output.length > 12_000_000) {
            stream.destroy();
            finish(new Error("操作结果过大"));
          }
        });
        stream.on("error", () =>
          finish(new RuntimeError({code:"transport_closed",scope:"ssh",retryable:false,outcome:"unknown",message:"SSH 通道中断，操作结果未知，请核实后继续"})),
        );
        stream.on("close", () => {
          try {
            const data = JSON.parse(output);
            if (data.error) finish(new RuntimeError(errorInfo(data) ?? {code:"internal",scope:"remote",retryable:false,outcome:"unknown",message:String(data.error).slice(0,400)}));
            else finish(undefined, data.result ?? data);
          } catch {
            finish(
              new RuntimeError({code:"transport_closed",scope:"ssh",retryable:false,outcome:"unknown",message:"远端组件连接中断或返回无效结果，操作结果需要核实"}),
            );
          }
        });
        stream.end(JSON.stringify(request));
      });
    });
  };
  return {
    alive: () => alive,
    call,
    sftp: () =>
      new Promise((resolve, reject) =>
        client.sftp((e, s) =>
          e ? reject(new Error("SFTP 不可用")) : resolve(s),
        ),
      ),
    forward: (port) =>
      new Promise((resolve, reject) =>
        client.forwardOut("127.0.0.1", 0, "127.0.0.1", port, (e, s) =>
          e ? reject(new Error("云端桌面连接失败")) : resolve(s),
        ),
      ),
    close() {
      client.end();
      cleanup();
    },
  };
}
