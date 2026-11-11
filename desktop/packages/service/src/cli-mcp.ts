import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Stdio MCP server. Codex starts it for one run; the token file is rewritten while the run is alive. */
export const MCP_SERVER_SOURCE = `import { readFileSync } from "node:fs";
const configPath = process.argv[2];
function config() { return JSON.parse(readFileSync(configPath, "utf8")); }
const tools = [
  { name: "list_agents", description: "列出同一用户的其他 Pi Bot 智能体。", inputSchema: { type: "object", properties: { query: { type: "string" } } } },
  { name: "ask_agent", description: "把一个自包含的任务交给另一个 Pi Bot 智能体。对方看不到当前 CLI 对话。", inputSchema: { type: "object", properties: { agent: { type: "string" }, task: { type: "string" } }, required: ["agent", "task"] } },
];
function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write("Content-Length: " + body.length + "\\r\\n\\r\\n");
  process.stdout.write(body);
}
async function post(path, body) {
  const current = config();
  const response = await fetch(current.api.replace(/\\/+$/, "") + path, {
    method: "POST",
    headers: { authorization: "Bearer " + current.token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(text.slice(0, 500) || "HTTP " + response.status);
  return text ? JSON.parse(text) : {};
}
async function handle(message) {
  const id = message.id;
  const method = message.method;
  if (typeof method === "string" && method.startsWith("notifications/")) return;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: message.params?.protocolVersion ?? "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "pi-bot", version: "0.1.0" } } });
    return;
  }
  if (method === "tools/list") { send({ jsonrpc: "2.0", id, result: { tools } }); return; }
  if (method === "tools/call") {
    try {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      const current = config();
      const text = name === "list_agents"
        ? JSON.stringify((await post("/agent/directory", { run_id: current.runId, query: String(args.query ?? "") })).agents ?? [])
        : name === "ask_agent"
          ? JSON.stringify(await post("/agent/tasks", { run_id: current.runId, agent: args.agent, task: args.task, wait: false }))
          : null;
      if (text === null) throw new Error("未知工具");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }] } });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: error instanceof Error ? error.message : "调用失败" }], isError: true } });
    }
    return;
  }
  if (id !== undefined) send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } });
}
let buffer = Buffer.alloc(0);
process.stdin.on("data", chunk => {
  buffer = Buffer.concat([buffer, chunk]);
  for (;;) {
    const headerEnd = buffer.indexOf("\\r\\n\\r\\n");
    if (headerEnd < 0) return;
    const match = /Content-Length:\\s*(\\d+)/i.exec(buffer.slice(0, headerEnd).toString("utf8"));
    if (!match) { buffer = buffer.slice(headerEnd + 4); continue; }
    const length = Number(match[1]);
    const start = headerEnd + 4;
    if (buffer.length < start + length) return;
    const body = buffer.slice(start, start + length).toString("utf8");
    buffer = buffer.slice(start + length);
    try { void handle(JSON.parse(body)); } catch { /* ignore malformed frames */ }
  }
});
`;

export function writeMcpServer(dataDir: string) {
  mkdirSync(dataDir, { recursive: true });
  const path = join(dataDir, "cli-mcp-server.mjs");
  writeFileSync(path, MCP_SERVER_SOURCE, { mode: 0o600 });
  try { chmodSync(path, 0o600); } catch { /* Windows may ignore the mode. */ }
  return path;
}

export function writeMcpConfig(dataDir: string, config: { api: string; token: string; runId: string }) {
  const path = join(dataDir, `cli-mcp-${randomUUID()}.json`);
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}
