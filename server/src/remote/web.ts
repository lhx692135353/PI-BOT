import type { FastifyInstance } from "fastify";
import { readFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { SignJWT, jwtVerify } from "jose";
import { randomUUID } from "node:crypto";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable } from "node:stream";
import type { RemoteService } from "./service.js";
import { readDesktopTicket } from "./routes.js";
import { ownEnvironment } from "./environments.js";
import { user, device, isSigned } from "../security.js";
import { fail } from "../db.js";
async function receiveFile(body: Readable, sftp: any, target: string) {
  const temp = target + "." + randomUUID() + ".upload";
  let size = 0;
  const limit = new Transform({
    transform(chunk, _encoding, done) {
      size += chunk.length;
      if (size > 100 * 1024 * 1024) done(new Error("上传最多 100MiB"));
      else done(null, chunk);
    },
  });
  try {
    await pipeline(body, limit, sftp.createWriteStream(temp));
    await new Promise<void>((resolve, reject) =>
      sftp.ext_openssh_rename(temp, target, (error: Error) =>
        error ? reject(error) : resolve(),
      ),
    );
  } catch (error) {
    sftp.unlink(temp, () => {});
    throw error;
  }
}
export async function remoteWeb(app: FastifyInstance, remote: RemoteService) {
  const { db, s } = remote,
    key = new TextEncoder().encode(s.jwtSecret),
    used = new Map<string, number>();
  const staticRoot = dirname(
    dirname(fileURLToPath(import.meta.resolve("@novnc/novnc"))),
  );
  app.get("/remote-desktop/", async (_req, reply) =>
    reply
      .header("referrer-policy", "no-referrer")
      .header("cache-control", "no-store")
      .type("text/html")
      .send(
        await readFile(
          new URL("../remote-guest/desktop.html", import.meta.url),
        ).catch(() =>
          readFile(new URL("../../remote-guest/desktop.html", import.meta.url)),
        ),
      ),
  );
  app.get("/remote-desktop/novnc/*", async (req, reply) => {
    const rel = (req.params as any)["*"],
      file = resolve(staticRoot, rel);
    if (!file.startsWith(staticRoot + sep) || !file.endsWith(".js"))
      return reply.code(404).send();
    return reply.type("text/javascript").send(await readFile(file));
  });
  app.post("/remote-desktop/session", async (req, reply) => {
    const token = String(req.headers.authorization ?? "").replace(
      /^Bearer /,
      "",
    );
    let p;
    try {
      p = (await jwtVerify(token, key, { algorithms: ["HS256"] })).payload;
    } catch {
      return reply.code(401).send({ detail: "桌面入口已过期，请重新打开" });
    }
    if (p.artifact) fail(403, "此入口只允许查看指定文件");
    if (
      p.typ !== "remote-launch" ||
      typeof p.sub !== "string" ||
      typeof p.environment !== "string"
    )
      fail(401, "认证失败");
    const env = await db.tx(async (tx) => {
      const u = await tx.get("users", p.sub!);
      if (!u || u.disabled) fail(401, "账号不可用");
      return ownEnvironment(tx, s, p.sub!, p.environment as string);
    });
    const body = JSON.parse(
        Buffer.isBuffer(req.body) ? req.body.toString() : "{}",
      ),
      action = body.action;
    if (action === "text") {
      if (typeof body.text !== "string" || body.text.length > 20000)
        fail(422, "输入文字无效");
      remote.renew(env.environment_id, String(body.session_id));
      const bot = p.bot
        ? await db.tx((tx) =>
            tx.one(
              "SELECT slug FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL",
              [p.bot, p.sub],
            ),
          )
        : undefined;
      return (await remote.connect(env)).call({
        action: "desktop_input",
        operation_id: randomUUID(),
        slug: bot?.slug ?? "manual-desktop",
        args: { type: "text", text: body.text },
      });
    }
    if (action === "renew")
      return remote.renew(env.environment_id, String(body.session_id));
    if (action === "release") {
      remote.release(env.environment_id, String(body.session_id));
      return { ok: true };
    }
    if (action !== "view" && action !== "acquire") fail(422, "未知桌面操作");
    const session =
      action === "acquire" ? (await remote.acquire(env)).id : undefined;
    const ticket = await new SignJWT({
      typ: "remote-desktop",
      environment: env.environment_id,
      session,
    })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(p.sub!)
      .setJti(randomUUID())
      .setExpirationTime("60s")
      .sign(key);
    return { ticket, session_id: session };
  });
  app.get("/ws/remote-desktop", { websocket: true }, (ws, req) => {
    let close = () => {},
      timer: NodeJS.Timeout | undefined;
    const pending: Buffer[] = [];
    let send: ((b: Buffer) => void) | undefined;
    ws.on("message", (b) => {
      const data = Buffer.isBuffer(b) ? b : Buffer.from(b as any);
      if (send) send(data);
      else if (pending.reduce((n, b) => n + b.length, 0) + data.length < 65536)
        pending.push(data);
      else ws.close(4400);
    });
    ws.on("close", () => {
      clearInterval(timer);
      close();
    });
    void (async () => {
      try {
        const ticket = String((req.query as any).ticket ?? ""),
          p = await readDesktopTicket(ticket, s.jwtSecret);
        for (const [id, end] of used) if (end < Date.now()) used.delete(id);
        if (!p.jti || used.has(p.jti)) throw new Error();
        used.set(p.jti, (p.exp ?? 0) * 1000);
        const env = await db.tx(async (tx) => {
          const u = await tx.get("users", p.sub);
          if (!u || u.disabled) throw new Error();
          return ownEnvironment(tx, s, p.sub, p.environment);
        });
        const connection = await remote.desktop(env, p.session);
        close = () => {
          connection.stream.destroy();
          if (p.session) remote.release(env.environment_id, p.session);
        };
        if (ws.readyState !== 1) {
          close();
          return;
        }
        send = (b) => {
          if (!connection.check()) return ws.close(4401);
          if (connection.stream.writableLength > 4_000_000)
            return ws.close(4400);
          connection.stream.write(b);
        };
        for (const b of pending) send(b);
        connection.stream.on("data", (b) => {
          if (ws.bufferedAmount > 4_000_000) ws.close(4400);
          else if (ws.readyState === 1) ws.send(b);
        });
        connection.stream.on("error", () => ws.close(4400));
        connection.stream.on("close", () => ws.close());
        timer = setInterval(() => {
          void db
            .tx((tx) => tx.get("users", p.sub))
            .then((u) => {
              if (!u || u.disabled || !connection.check()) ws.close(4401);
            })
            .catch(() => ws.close(4401));
        }, 5000);
      } catch {
        ws.close(4401);
      }
    })();
  });
  // Binary transfers use dedicated routes, so the JSON API parser never buffers a large file.
  app.register(async (binary) => {
    binary.addContentTypeParser(
      "application/octet-stream",
      (_req, stream, done) => done(null, stream),
    );
    binary.route({
      method: ["GET", "POST"],
      url: "/remote-desktop/file",
      bodyLimit: 100 * 1024 * 1024,
      handler: async (req, reply) => {
        const token = String(req.headers.authorization ?? "").replace(
          /^Bearer /,
          "",
        );
        let p;
        try {
          p = (await jwtVerify(token, key, { algorithms: ["HS256"] })).payload;
        } catch {
          fail(401, "入口已过期，请重新打开");
        }
        if (
          p!.typ !== "remote-launch" ||
          typeof p!.sub !== "string" ||
          typeof p!.environment !== "string"
        )
          fail(401, "认证失败");
        const query = req.query as any,
          botId = String(query.bot ?? p!.bot ?? ""),
          path = String(query.path ?? "");
        if (p!.bot && p!.bot !== botId) fail(403, "入口未授权此 Bot");
        if (
          p!.artifact &&
          (req.method !== "GET" || query.list === "1" || path !== p!.artifact)
        )
          fail(403, "此入口只允许读取指定结果");
        const env = await db.tx(async (tx) => {
          const u = await tx.get("users", p!.sub!);
          if (!u || u.disabled) fail(401, "账号不可用");
          return ownEnvironment(
            tx,
            s,
            p!.sub!,
            p!.environment as string,
            !!p!.artifact,
          );
        });
        const bot = await db.tx((tx) =>
          tx.one(
            "SELECT * FROM bots WHERE bot_id=$1 AND user_id=$2 AND archived_at IS NULL",
            [botId, p!.sub],
          ),
        );
        if (!bot) fail(404, "Bot 不存在");
        if (query.list === "1") {
          if (req.method !== "GET") fail(405, "仅允许读取");
          return (await remote.connect(env)).call({
            action: "list_files",
            operation_id: randomUUID(),
            slug: bot!.slug,
            args: { path },
          });
        }
        const info = await remote.file(
          p!.sub!,
          botId,
          env.environment_id,
          path,
          req.method === "POST",
        );
        reply.raw.once("close", () => info.sftp.end());
        if (req.method === "GET") {
          reply
            .header("cache-control", "no-store")
            .type("application/octet-stream");
          return reply.send(info.sftp.createReadStream(info.path));
        }
        await receiveFile(req.body as Readable, info.sftp, info.path);
        return { ok: true };
      },
    });
    binary.route({
      method: ["GET", "POST"],
      url: "/bots/:id/remote/file",
      bodyLimit: 100 * 1024 * 1024,
      handler: async (req, reply) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0),
          path = String((req.query as any).path ?? "");
        if (req.method === "POST" && isSigned(req.headers))
          fail(400, "二进制上传请使用用户凭据或云端文件入口");
        const actor = await db.tx((tx) =>
          isSigned(req.headers)
            ? device(tx, req.headers, req.method, req.url.split("?")[0], raw, s)
            : user(tx, req.headers, s).then((user) => ({ user })),
        );
        const env = await db.tx((tx) =>
          tx.one(
            "SELECT * FROM remote_environments WHERE user_id=$1 AND status<>'retired'",
            [actor.user.user_id],
          ),
        );
        if (!env) fail(404, "云端环境尚未创建");
        const info = await remote.file(
          actor.user.user_id,
          (req.params as any).id,
          env!.environment_id,
          path,
          req.method === "POST",
        );
        reply.raw.once("close", () => info.sftp.end());
        if (req.method === "GET") {
          reply
            .header("cache-control", "no-store")
            .header(
              "content-disposition",
              `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) || "download")}`,
            );
          return reply
            .type("application/octet-stream")
            .send(info.sftp.createReadStream(info.path));
        }
        await receiveFile(req.body as Readable, info.sftp, info.path);
        return { ok: true };
      },
    });
  });
  app.get("/remote/artifacts/:id", async (req, reply) => {
    const u = await db.tx((tx) => user(tx, req.headers, s)),
      a = await db.tx((tx) =>
        tx.one(
          "SELECT * FROM remote_artifacts WHERE artifact_id=$1 AND user_id=$2",
          [(req.params as any).id, u.user_id],
        ),
      );
    if (!a) fail(404, "文件不存在");
    const file = await remote.file(
      u.user_id,
      a!.bot_id,
      a!.environment_id,
      a!.path,
    );
    reply.raw.once("close", () => file.sftp.end());
    reply
      .header("cache-control", "no-store")
      .header("x-content-type-options", "nosniff")
      .type(a!.mime);
    return reply.send(file.sftp.createReadStream(file.path));
  });
}
