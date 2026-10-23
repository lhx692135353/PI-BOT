import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Database, HttpError, fail, type Row, type Tx } from "./db.js";
import { migrate } from "./migrate.js";
import { device, isSigned, llmCaller, passwordHash, user } from "./security.js";
import { settings, type Settings } from "./config.js";
import { Hub } from "./hub.js";
import { routes, type Context, type Route } from "./routes.js";
import { sockets } from "./sockets.js";
import { failOrphanedDeviceRuns } from "./runs.js";
import { WebSearch } from "./search.js";
import { AgentDispatcher } from "./agents.js";
import { VoiceHub } from "./voice.js";

export async function bootstrapAdmin(db: Database, s: Settings) {
  await db.tx(async (tx) => {
    if (await tx.one("SELECT 1 FROM users WHERE role='admin' LIMIT 1")) return;
    if (!s.adminPassword)
      throw new Error("首次启动需要设置 PI_BOT_ADMIN_PASSWORD 来创建管理员");
    await tx.insert("users", {
      user_id: randomUUID(),
      username: s.adminUsername,
      display_name: "管理员",
      password_hash: await passwordHash(s.adminPassword),
      role: "admin",
    });
  });
}

function issues(error: z.ZodError, where: string) {
  return error.issues.map((i) => ({
    loc: [where, ...i.path.map(String)],
    msg: i.message,
    type: i.code,
  }));
}
function parse(schema: z.ZodType | undefined, value: unknown, where: string) {
  if (!schema) return value;
  const r = schema.safeParse(value);
  if (!r.success) fail(422, issues(r.error, where));
  return r.data;
}
async function authenticate(
  tx: Tx,
  route: Route,
  req: FastifyRequest,
  raw: Buffer,
  s: Settings,
): Promise<Pick<Context, "user" | "device" | "llm">> {
  const signedPath = req.url.split("?")[0];
  switch (route.auth) {
    case "none":
      return { user: {} };
    case "user":
      return { user: await user(tx, req.headers, s) };
    case "admin": {
      const u = await user(tx, req.headers, s);
      if (u.role !== "admin") fail(403, "需要管理员权限");
      return { user: u };
    }
    case "device":
      return device(tx, req.headers, req.method, signedPath, raw, s);
    case "actor":
      return isSigned(req.headers)
        ? device(tx, req.headers, req.method, signedPath, raw, s)
        : { user: await user(tx, req.headers, s) };
    case "llm": {
      const { user: u, claims } = await llmCaller(tx, req.headers, s);
      return { user: u, llm: claims };
    }
  }
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".woff2": "font/woff2",
};
function adminRoot(s: Settings) {
  return resolve(
    s.adminDir ?? fileURLToPath(new URL("../../admin/dist", import.meta.url)),
  );
}

export async function createApp(
  s: Settings = settings(),
  db = new Database(s.databaseUrl),
  hub = new Hub(),
  webSearch = new WebSearch(s),
) {
  await migrate(db);
  await bootstrapAdmin(db, s);
  await failOrphanedDeviceRuns(db);
  const app = Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser(
    "application/json",
    { parseAs: "buffer" },
    (_req, body, done) => done(null, body),
  );
  app.setErrorHandler((error, _req, reply) => {
    if (error instanceof HttpError)
      return reply.code(error.status).send({ detail: error.detail });
    const e = error as Row;
    if (e.code === "23505") return reply.code(409).send({ detail: "记录冲突" });
    if (e.statusCode === 413) return reply.code(413).send({ detail: "请求体过大" });
    if (e.statusCode === 415) return reply.code(415).send({ detail: "仅支持 JSON" });
    reply.code(500).send({ detail: "服务暂时不可用" });
  });

  for (const route of routes)
    app.route({
      method: route.method,
      url: route.path,
      handler: async (req, reply) => {
        const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
        let json: unknown = {};
        if (raw.length)
          try {
            json = JSON.parse(raw.toString("utf8"));
          } catch {
            fail(422, "JSON 格式错误");
          }
        const query = parse(route.query, req.query, "query");
        const params = req.params as Record<string, string>;
        for (const [k, v] of Object.entries(params))
          if (k === "id" && !/^[0-9a-f-]{36}$/i.test(v)) fail(404, "记录不存在");
        const after: (() => unknown)[] = [];
        const base = { db, s, hub, webSearch, query, params, req, reply, after: (fn: () => unknown) => void after.push(fn) };
        let result: unknown;
        if (route.tx === false) {
          const who = await db.tx((tx) => authenticate(tx, route, req, raw, s));
          const body = parse(route.body, json, "body") ?? json;
          result = await route.handler({ ...base, ...who, body, tx: undefined as never });
        } else
          result = await db.tx(async (tx) => {
            const who = await authenticate(tx, route, req, raw, s);
            const body = parse(route.body, json, "body") ?? json;
            return route.handler({ ...base, ...who, body, tx });
          });
        for (const fn of after)
          await Promise.resolve()
            .then(fn)
            .catch(() => {});
        return result;
      },
    });

  app.get("/openapi.json", async () => openapi());

  const root = adminRoot(s);
  const serveAdmin = async (req: FastifyRequest, reply: any) => {
    const rel = normalize(decodeURIComponent((req.params as Row)["*"] ?? "")).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(root, rel);
    if (rel.startsWith("api/") || (file !== root && !file.startsWith(root + sep))) fail(404, "Not found");
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) file = join(root, "index.html");
    const body = await readFile(file).catch(() => null);
    if (!body) return reply.code(404).type("text/plain").send("管理后台尚未构建（npm run build -w @pi-bot/admin）");
    return reply
      .header("cache-control", file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable")
      .type(MIME[extname(file)] ?? "application/octet-stream")
      .send(body);
  };
  app.get("/admin", (_req, reply) => reply.redirect("admin/"));
  app.get("/admin/*", serveAdmin);

  await app.register(websocket, { options: { maxPayload: 8 * 1024 * 1024 } });
  const dispatcher = new AgentDispatcher(db, s, hub);
  const voice = new VoiceHub(db, s, hub, dispatcher);
  dispatcher.setAnnouncer(voice);
  await sockets(app, db, s, hub, dispatcher, voice);
  return Object.assign(app, { hub, db });
}

export function openapi() {
  const paths: Row = {};
  const schema = (t: z.ZodType) => z.toJSONSchema(t, { io: "input", unrepresentable: "any" });
  const security: Record<string, Row[]> = {
    none: [],
    user: [{ UserBearer: [] }],
    admin: [{ UserBearer: [] }],
    device: [{ DeviceSignature: [] }],
    actor: [{ UserBearer: [] }, { DeviceSignature: [] }],
    llm: [{ LlmBearer: [] }],
  };
  for (const r of routes) {
    if (r.internal) continue;
    const path = r.path.replace(/:(\w+)/g, "{$1}");
    const parameters: Row[] = [...r.path.matchAll(/:(\w+)/g)].map((m) => ({
      name: m[1], in: "path", required: true, schema: { type: "string", format: "uuid" },
    }));
    if (r.query) {
      const q = schema(r.query) as Row;
      for (const [name, sch] of Object.entries(q.properties ?? {}))
        parameters.push({ name, in: "query", required: (q.required ?? []).includes(name), schema: sch });
    }
    (paths[path] ??= {})[r.method.toLowerCase()] = {
      tags: [r.tag],
      summary: r.summary,
      security: security[r.auth],
      ...(parameters.length ? { parameters } : {}),
      ...(r.body ? { requestBody: { required: true, content: { "application/json": { schema: schema(r.body) } } } } : {}),
      responses: { "200": { description: "OK" }, default: { description: "{ detail }" } },
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: "Pi Bot API", version: "0.4.0" },
    paths,
    components: {
      securitySchemes: {
        UserBearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
        LlmBearer: { type: "http", scheme: "bearer", description: "POST /device/llm-token 签发的短期模型代理令牌" },
        DeviceSignature: {
          type: "apiKey", in: "header", name: "x-pibot-signature",
          description: "Ed25519 签名 `${timestamp}.${nonce}.${METHOD}.${path}.${sha256(body)}`，配合 x-pibot-device-id / x-pibot-timestamp / x-pibot-nonce",
        },
      },
    },
  };
}
