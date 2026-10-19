import { isRealToolResult, latestUserText, ResponseStream } from "../../packages/agent/tests/responses.js";
import { createServer, type IncomingMessage } from "node:http";
import { generateKeyPairSync, randomBytes, randomUUID, sign } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import WebSocket from "ws";
import {EXAMPLE} from "@pi-bot/a2ui";
import { sha256 } from "../src/security.js";

export const TEST_DB = process.env.PI_BOT_TEST_DATABASE_URL;

export async function resetDatabase(url: string) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  await c.query("DROP SCHEMA public CASCADE; CREATE SCHEMA public;");
  await c.end();
}

export function tempDir() {
  const path = mkdtempSync(join(tmpdir(), "pi-bot-test-"));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
export function vaultFile(dir: string) {
  const id = randomUUID(),
    path = join(dir, "vault.json");
  writeFileSync(path, JSON.stringify({ active: id, keys: { [id]: randomBytes(32).toString("base64") } }));
  return path;
}

async function body(req: IncomingMessage) {
  let text = "";
  for await (const chunk of req) text += chunk;
  return text ? JSON.parse(text) : {};
}
/** User messages that make the mock model call `ask_agent` with these arguments. */
const DELEGATIONS: Record<string, object> = {
  委托链路测试: { agent: "写作助手", task: "写一份本周周报", wait: true },
  转交链路测试: { agent: "写作助手", task: "写一份本周周报", wait: false },
};
const SKILLS: Record<string, { name: string; args: object }> = {
  创建能力链路测试: { name: "skill_manage", args: { action: "create", name: "report-test", description: "整理周报时使用", instructions: "PRIVATE-WORKFLOW：先核实来源，再整理结论。", references: { "format.md": "先写结论，再写依据。" } } },
  加载能力链路测试: { name: "skill_load", args: { name: "report-test" } },
};
/** OpenAI-compatible provider double that records what the proxy forwarded. */
export async function mockProvider() {
  const requests: { headers: IncomingMessage["headers"]; body: any }[] = [];
  const server = createServer(async (req, res) => {
    if (req.url !== "/v1/responses") return void res.writeHead(404).end();
    const json = await body(req);
    requests.push({ headers: req.headers, body: json });
    const input = typeof json.input === "string" ? [{ role: "user", content: json.input }] : json.input;
    const text = (c: any): string => (Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : String(c ?? ""));
    const last = latestUserText(input);
    const all = JSON.stringify(json.input);
    const toolDone = isRealToolResult(json.input);
    const delegation = DELEGATIONS[last];
    const skill = SKILLS[last];
    const answer = (() => {
      if (last === "纯交互界面链路测试" && toolDone) return "";
      if(text(input[0]?.content).includes('维护私有记忆')) {
        const source=last.match(/\[([0-9a-f-]{36})\]/)?.[1];
        return JSON.stringify({memories:source?[{content:'用户喜欢蓝鲸。',kind:'fact',source_message_id:source}]:[],topics:['海洋知识']});
      }
      if (last.includes("新增对话")) return "用户喜欢蓝鲸。";
      if (skill && toolDone) return "已按方法完成任务。";
      if (last.includes("你收到来自智能体")) return "委托结果：周报写好了";
      if (last.includes("这是你之前委托给")) return last.includes("周报写好了") ? "回报已收到：周报写好了" : last.split("结果：\n").at(-1)!;
      if (delegation && toolDone) return `综合：${text(json.input.at(-1).output)}`;
      if (last.includes("记住")) return "好的，我记住了蓝鲸。";
      if (last.includes("之前")) return all.includes("蓝鲸") ? "你之前说的是蓝鲸。" : "没有记录。";
      if (last === "联网搜索链路测试" && toolDone) return `搜到：${text(json.input.at(-1).output)}`;
      return `收到：${last.slice(0, 20)}`;
    })();
    if (!json.stream) {
      res.writeHead(200, { "content-type": "application/json" });
      return void res.end(JSON.stringify({ id: "resp_sync", object: "response", status: "completed", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text: answer }] }], usage: { input_tokens: 11, output_tokens: 3 } }));
    }
    const stream = new ResponseStream(res, json.model);
    if (["交互界面链路测试","纯交互界面链路测试"].includes(last) && !toolDone) {
      stream.tool("show_ui", { messages: EXAMPLE }, "ui_1");
      return void stream.end();
    }
    if (skill && !toolDone) {
      stream.text("内部：正在管理 skill。");
      stream.tool(skill.name, skill.args, "skill_1");
      return void stream.end();
    }
    if (last === "联网搜索链路测试" && json.tools.some((t: any) => t.name === "start_task")) {
      if (!toolDone) stream.tool("start_task", { title: "联网核查", task: last }, "start_search");
      else stream.text("已开始核查，完成后告诉你。");
      return void stream.end();
    }
    if (last === "联网搜索链路测试" && !toolDone) {
      stream.tool("web_search", { query: "Pi Bot 搜索测试", language: "zh-CN" }, "search_1");
      return void stream.end();
    }
    if (delegation && !toolDone) {
      stream.tool("ask_agent", delegation, "ask_1");
      return void stream.end();
    }
    for (const piece of Array.from(answer)) stream.text(piece);
    stream.end(42, answer.length);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

export async function mockSearch() {
  const queries: { query: string; language?: string }[] = [];
  let used = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url!, "http://localhost");
    res.writeHead(200, { "content-type": "application/json" });
    if (url.pathname === "/usage") {
      res.end(JSON.stringify({ key: { usage: used, limit: null }, account: { current_plan: "Researcher", plan_usage: used, plan_limit: 1000 } }));
    } else {
      queries.push(await body(req));
      used++;
      res.end(JSON.stringify({ results: [{ title: "Pi Bot 官方资料", url: "https://example.com/pi", content: "搜索结果用于链路测试" }], usage: { credits: 1 } }));
    }
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return {
    fetch: ((input, init) => {
      const url = new URL(String(input));
      if (url.origin !== "https://api.tavily.com") throw new Error("Unexpected search provider");
      return fetch(`http://127.0.0.1:${(server.address() as any).port}${url.pathname}`, init);
    }) as typeof fetch, queries,
    close: () => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

export function deviceKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const raw = publicKey.export({ format: "der", type: "spki" }).subarray(-32);
  let id = "";
  return {
    publicKey: raw.toString("base64"),
    setId: (value: string) => void (id = value),
    headers(method: string, path: string, payload = "") {
      const timestamp = String(Math.floor(Date.now() / 1000)),
        nonce = randomBytes(16).toString("hex");
      const signature = sign(null, Buffer.from(`${timestamp}.${nonce}.${method}.${path}.${sha256(payload)}`), privateKey).toString("base64");
      return {
        "x-pibot-device-id": id,
        "x-pibot-timestamp": timestamp,
        "x-pibot-nonce": nonce,
        "x-pibot-signature": signature,
      };
    },
  };
}

/** Collects JSON frames from a socket so tests can await specific messages. */
export function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  const frames: any[] = [];
  const waiters: { match: (m: any) => boolean; resolve: (m: any) => void }[] = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    frames.push(m);
    for (const w of [...waiters])
      if (w.match(m)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(m);
      }
  });
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  return {
    ws,
    frames,
    closed,
    send: (m: object) => ws.send(JSON.stringify(m)),
    next(match: (m: any) => boolean, timeout = 10000) {
      const found = frames.find(match);
      if (found) {
        frames.splice(frames.indexOf(found), 1);
        return Promise.resolve(found);
      }
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("等待 WebSocket 消息超时")), timeout);
        waiters.push({ match, resolve: (m) => { clearTimeout(timer); frames.splice(frames.indexOf(m), 1); resolve(m); } });
      });
    },
    close: () => ws.close(),
  };
}

export async function eventually<T>(fn: () => Promise<T | undefined | false> | T | undefined | false, timeout = 10000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await fn();
    if (value) return value as T;
    if (Date.now() - start > timeout) throw new Error("等待条件超时");
    await new Promise((r) => setTimeout(r, 50));
  }
}
