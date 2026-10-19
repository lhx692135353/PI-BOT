import { isRealToolResult, ResponseStream } from "./responses.js";
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createBotAgent, type ToolActivity } from "../src/index.js";

const text = (content: any): string => Array.isArray(content) ? content.map(part => part.text ?? "").join("") : String(content ?? "");

test("the Pi extension loads private skills without read/bash or filesystem discovery, hides internal remarks, and refreshes its token", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-bot-private-skills-"));
  const requests: any[] = [], calls: any[] = [], tools: ToolActivity[] = [], progress: string[][] = [], output: string[] = [];
  let token = "first-private-token";
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    if (req.url === "/agent/skills") {
      calls.push({ body, token: req.headers.authorization });
      res.writeHead(200, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ name: "weekly-report", version: 1, instructions: "先核实来源再整理。", references: [] }));
    }
    requests.push(body);
    const done = isRealToolResult(body.input);
    assert.equal(req.url, "/v1/responses");
    const stream = new ResponseStream(res, body.model);
    if (!done) {
      stream.text("内部：我正在读取 skill weekly-report。");
      stream.tool("skill_load", { name: "weekly-report" }, "load_1");
    } else { stream.text("周报已完成。"); }
    stream.end();
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${(server.address() as any).port}`;
  // These must never be discovered, even when the library contains Pi files.
  mkdirSync(join(dir, ".pi", "extensions"), { recursive: true });
  writeFileSync(join(dir, ".pi", "extensions", "untrusted.ts"), "throw new Error('untrusted extension loaded');");
  mkdirSync(join(dir, ".agents", "skills", "foreign"), { recursive: true });
  writeFileSync(join(dir, ".agents", "skills", "foreign", "SKILL.md"), "---\nname: foreign\ndescription: FORBIDDEN-SKILL-CATALOG\n---\nprivate");
  writeFileSync(join(dir, "AGENTS.md"), "FORBIDDEN-PROJECT-CONTEXT");
  let agent: Awaited<ReturnType<typeof createBotAgent>> | undefined;
  try {
    agent = await createBotAgent({
      model: { id: "skills", name: "test", baseUrl: `${root}/v1`, modelId: "test", contextWindow: 32000, maxTokens: 1000 },
      apiKey: token, cwd: dir, agentDir: join(dir, "private"), systemPrompt: "你是测试 Bot。", tools: [], history: [],
      skills: { baseUrl: root, token: () => token, runId: "my-run", catalog: [{ name: "weekly-report", description: "编写周报时使用", version: 1 }] },
      onTool: tool => tools.push(tool), onProgress: lines => progress.push(lines),
    });
    assert.deepEqual(agent.tools, ["skill_manage", "skill_load"]);
    token = "refreshed-private-token";
    await agent.setApiKey(token);
    assert.equal(await agent.prompt("整理周报", value => output.push(value)), "周报已完成。");
    assert.deepEqual(calls, [{ body: { action: "load", name: "weekly-report", run_id: "my-run" }, token: "Bearer refreshed-private-token" }]);
    assert.deepEqual(tools, []);
    assert.deepEqual(progress, []);
    assert.ok(output.every(value => !value.includes("内部") && !value.includes("skill")));
    const system = text(requests[0].input[0].content);
    assert.match(system, /weekly-report/);
    assert.match(system, /skill_load/);
    assert.doesNotMatch(system, /FORBIDDEN/);
    assert.deepEqual(requests[0].tools.map((tool: any) => tool.name), ["skill_manage", "skill_load"]);
    assert.match(JSON.stringify(requests[1].input), /先核实来源再整理/);
  } finally {
    agent?.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  }
});

test("callers cannot replace the platform's private tools", async () => {
  await assert.rejects(createBotAgent({ tools: [{ name: "skill_manage" }] } as any), /内部工具名称/);
});
