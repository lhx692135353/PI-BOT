import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { cliLaunch, discoverCodexThreads, parseCliLine, runCliProcess } from "../packages/service/src/cli-engine.js";
import { resolveCliBin, scanCliProfiles } from "../packages/service/src/cli-profiles.js";
import { writeMcpConfig, writeMcpServer } from "../packages/service/src/cli-mcp.js";
import { runCliTurn, type CliTurnRun } from "../packages/service/src/cli-run.js";
import { Executor, type RunContext } from "../packages/service/src/executor.js";

const root = mkdtempSync(join(tmpdir(), "pi-bot-cli-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

test("cursor and codex argv stay out of the user's mcp config", () => {
  const cursor = cliLaunch({ runtime: "cursor", profile: "/home/me/.cursor", directory: "/work", prompt: "继续", resume: "sess-1" });
  assert.deepEqual(cursor.args.slice(0, 8), ["--print", "--force", "--trust", "--workspace", "/work", "--output-format", "stream-json", "--stream-partial-output"]);
  assert.deepEqual(cursor.args.slice(8), ["--resume", "sess-1", "继续"]);
  assert.equal(cursor.env.CURSOR_CONFIG_DIR, "/home/me/.cursor");
  assert.equal(cursor.args.join(" ").includes("mcp"), false);

  const codex = cliLaunch({
    runtime: "codex", profile: "work", directory: "/work", prompt: "继续", resume: "thread-1",
    mcp: { node: "/usr/bin/node", script: "/data/cli-mcp-server.mjs", configPath: "/data/cli-mcp.json" },
  });
  const resumeAt = codex.args.indexOf("resume");
  assert.ok(codex.args.indexOf("--cd") < resumeAt);
  assert.deepEqual(codex.args.slice(resumeAt, resumeAt + 2), ["resume", "thread-1"]);
  assert.ok(codex.args.includes("--profile"));
  assert.ok(codex.args.includes("workspace-write"));
  assert.equal(codex.args.at(-1), "-");
  assert.equal(codex.stdin, "继续");
  assert.equal(codex.args.filter(arg => arg === "-c").length, 2);
  assert.equal(codex.args.some(arg => /(^|[\\/])mcp\.json/.test(arg)), false);
  assert.equal(cliLaunch({ runtime: "codex", profile: "default", directory: "/work", prompt: "hi" }).args.includes("--profile"), false);
});

test("stream-json and codex JSONL become text and tool pieces", () => {
  const cursor = [
    JSON.stringify({ type: "system", session_id: "sess-1" }),
    JSON.stringify({ type: "assistant", subtype: "delta", delta: "你" }),
    JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { name: "shell", call_id: "c1", args: { command: "ls" } } }),
    JSON.stringify({ type: "result", result: "你好" }),
    "not json",
  ].flatMap(line => parseCliLine("cursor", line));
  assert.equal(cursor.find(piece => piece.kind === "session")?.id, "sess-1");
  assert.equal(cursor.find(piece => piece.kind === "text")?.text, "你");
  assert.equal(cursor.find(piece => piece.kind === "tool")?.summary, "ls");
  assert.equal(cursor.filter(piece => piece.kind === "text").at(-1)?.mode, "final");

  const codex = parseCliLine("codex", JSON.stringify({
    type: "item.completed", thread_id: "thread-9",
    item: { type: "command_execution", id: "cmd", command: "pwd", exit_code: 0 },
  }));
  assert.equal(codex[0].id, "thread-9");
  assert.equal(codex[1].kind, "tool");
  assert.equal(codex[1].state, "completed");
});

test("a fake CLI binary becomes run events and a saved session", async () => {
  const dir = join(root, "workspace");
  mkdirSync(dir);
  const bin = join(root, "fake-agent.mjs");
  writeFileSync(bin, `#!/usr/bin/env node
process.stdout.write(JSON.stringify({ type: "system", session_id: "eng-1" }) + "\\n");
process.stdout.write(JSON.stringify({ type: "assistant", subtype: "delta", delta: "hello " }) + "\\n");
process.stdout.write(JSON.stringify({ type: "tool_call", subtype: "completed", tool_call: { name: "read", call_id: "t1", args: { command: "cat" } } }) + "\\n");
process.stdout.write(JSON.stringify({ type: "result", result: "hello world" }) + "\\n");
`);
  chmodSync(bin, 0o755);
  const saved: unknown[] = [];
  const events: Record<string, unknown>[] = [];
  const run: CliTurnRun = {
    run_id: "11111111-1111-1111-1111-111111111111",
    text: "看一下",
    model: { id: "model-1" },
    bot: { name: "本地" },
    cli: { runtime: "cursor", profile: "/home/me/.cursor", directory: dir, persona: "简洁", fresh: true, recent: [], sessions: [] },
  };
  await runCliTurn(run, event => events.push(event), new AbortController().signal, {
    token: async () => "device-token",
    proxyUrl: "http://api.example/llm/v1",
    bins: { cursor: bin },
    fetchImpl: async (url, init) => {
      assert.equal(String(url), "http://api.example/agent/cli-sessions");
      assert.equal((init?.headers as Record<string, string>).authorization, "Bearer device-token");
      saved.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ id: "sess" }), { status: 200 });
    },
  });
  assert.equal(events.some(event => event.kind === "text" && event.text === "hello world"), true);
  assert.equal(events.some(event => event.kind === "tool" && event.name === "read"), true);
  assert.deepEqual(events.at(-1), { kind: "done", state: "completed", text: "hello world" });
  assert.equal((saved[0] as { engine_session_id: string }).engine_session_id, "eng-1");
});

test("two close sessions ask and do not launch the CLI", async () => {
  const dir = join(root, "ask");
  mkdirSync(dir);
  let launched = false;
  const events: Record<string, unknown>[] = [];
  const sessions = [
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", engine_session_id: "a", title: "修登录", summary: "登录", last_user_text: "按钮", updated_at: "2026-11-01T00:00:00.000Z" },
    { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", engine_session_id: "b", title: "写测试", summary: "测试", last_user_text: "补上", updated_at: "2026-11-02T00:00:00.000Z" },
  ];
  await runCliTurn({
    run_id: "22222222-2222-2222-2222-222222222222", text: "继续", model: { id: "model-1" }, bot: { name: "本地" },
    cli: { runtime: "codex", profile: "work", directory: dir, persona: "", fresh: false, recent: [], sessions },
  }, event => events.push(event), new AbortController().signal, {
    token: async () => "t",
    proxyUrl: "http://api.example/llm/v1",
    launch: async () => { launched = true; return { code: 0, stderr: "" }; },
    fetchImpl: async () => new Response(JSON.stringify({
      answers: { session: { choice: sessions[1].id, probabilities: { [sessions[0].id]: 0.42, [sessions[1].id]: 0.48, __new__: 0.1 } }, clear: { noul: 0.91 } },
    }), { status: 200 }),
  });
  assert.equal(launched, false);
  assert.equal(events.at(-1)?.state, "completed");
  assert.match(String(events.at(-1)?.text), /请回复编号/);
});

test("thread.started is the Codex session id", () => {
  const pieces = parseCliLine("codex", JSON.stringify({ type: "thread.started", thread_id: "019ce6ce-65fd-7530-8e6b-9ccce0436091" }));
  assert.equal(pieces.find(piece => piece.kind === "session")?.id, "019ce6ce-65fd-7530-8e6b-9ccce0436091");
});

test("existing Codex rollout files for this directory are visible to routing", () => {
  const home = join(root, "codex-home-sessions");
  const directory = "/Users/liuhx/personal/T-AGENT";
  const day = join(home, "sessions", "2026", "11", "12");
  mkdirSync(day, { recursive: true });
  writeFileSync(join(day, "rollout-2026-11-12T08-00-00-019ce6ce-65fd-7530-8e6b-9ccce0436091.jsonl"), `{"cwd":"${directory}","source":"exec"}\n`);
  writeFileSync(join(day, "rollout-2026-11-12T08-05-00-11111111-1111-4111-8111-111111111111.jsonl"), `{"cwd":"/somewhere/else"}\n`);
  const found = discoverCodexThreads(directory, { CODEX_HOME: home });
  assert.deepEqual(found.map(thread => thread.id), ["019ce6ce-65fd-7530-8e6b-9ccce0436091"]);
});

test("profile scan reads codex names and cursor config directories", () => {
  const home = join(root, "codex-home");
  const cursor = join(root, "cursor-home");
  const extra = join(root, "cursor-extra");
  mkdirSync(home); mkdirSync(cursor); mkdirSync(extra);
  writeFileSync(join(home, "config.toml"), "");
  writeFileSync(join(home, "work.config.toml"), "");
  writeFileSync(join(root, "cursor-profiles.json"), JSON.stringify({ profiles: [{ label: "工作", dir: extra }] }));
  const scan = scanCliProfiles(root, { ...process.env, CODEX_HOME: home, CURSOR_CONFIG_DIR: cursor, PI_BOT_CURSOR_BIN: process.execPath, PI_BOT_CODEX_BIN: "codex-not-installed" });
  assert.deepEqual(scan.codex.profiles.map(profile => profile.id), ["default", "work"]);
  assert.deepEqual(scan.cursor.profiles.map(profile => profile.id), [cursor, extra]);
  assert.equal(scan.cursor.installed, true);
  assert.equal(scan.codex.installed, false);
});

test("codex in the user bin is visible when the app PATH cannot see it", () => {
  const cliHome = join(root, "cli-home");
  const binDir = join(cliHome, ".local", "bin");
  mkdirSync(binDir, { recursive: true });
  const codex = join(binDir, "codex");
  writeFileSync(codex, "#!/bin/sh\n");
  chmodSync(codex, 0o755);
  const hidden = { HOME: cliHome, PATH: "/usr/bin:/bin", PI_BOT_SKIP_LOGIN_PATH: "1" };
  assert.equal(scanCliProfiles(root, hidden).codex.installed, true);
  assert.equal(resolveCliBin("codex", hidden), codex);
  const previous = process.env.PI_BOT_CODEX_BIN;
  process.env.PI_BOT_CODEX_BIN = codex;
  try { assert.equal(cliLaunch({ runtime: "codex", profile: "default", directory: "/work", prompt: "hi" }).command, codex); }
  finally { if (previous === undefined) delete process.env.PI_BOT_CODEX_BIN; else process.env.PI_BOT_CODEX_BIN = previous; }
});

test("the one-shot MCP server lists and delegates without a global config file", async () => {
  const data = join(root, "mcp");
  mkdirSync(data);
  const seen: unknown[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => { raw += chunk; });
    req.on("end", () => {
      seen.push({ url: req.url, body: JSON.parse(raw || "{}") });
      const body = req.url === "/agent/directory" ? { agents: [{ name: "研究" }] } : { task: { id: "task-1" } };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("no port");
  const script = writeMcpServer(data);
  const config = writeMcpConfig(data, { api: `http://127.0.0.1:${address.port}`, token: "mcp-token", runId: "33333333-3333-3333-3333-333333333333" });
  const child = spawn(process.execPath, [script, config], { stdio: ["pipe", "pipe", "pipe"] });
  let buffer = Buffer.alloc(0);
  const frames: any[] = [];
  const pending: ((message: any) => void)[] = [];
  child.stdout.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      const headerEnd = buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) return;
      const match = /Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, headerEnd).toString("utf8"));
      if (!match) { buffer = buffer.subarray(headerEnd + 4); continue; }
      const length = Number(match[1]);
      const start = headerEnd + 4;
      if (buffer.length < start + length) return;
      const message = JSON.parse(buffer.subarray(start, start + length).toString("utf8"));
      buffer = buffer.subarray(start + length);
      const waiter = pending.shift();
      if (waiter) waiter(message); else frames.push(message);
    }
  });
  const call = (message: unknown) => new Promise<any>(resolve => {
    pending.push(resolve);
    const body = Buffer.from(JSON.stringify(message));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
  });
  const init = await call({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  assert.equal(init.result.serverInfo.name, "pi-bot");
  const listed = await call({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "list_agents", arguments: { query: "研" } } });
  const asked = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_agent", arguments: { agent: "研究", task: "总结目录" } } });
  child.stdin.end();
  child.kill();
  await new Promise(resolve => child.once("exit", resolve));
  await new Promise(resolve => server.close(() => resolve(undefined)));
  assert.match(listed.result.content[0].text, /研究/);
  assert.match(asked.result.content[0].text, /task-1/);
  assert.equal((seen[0] as { body: { run_id: string } }).body.run_id, "33333333-3333-3333-3333-333333333333");
  assert.equal((seen[1] as { url: string }).url, "/agent/tasks");
  assert.equal(frames.length, 0);
});

test("the executor resumes one CLI session and asks before a second close match", async () => {
  const dir = join(root, "executor");
  mkdirSync(dir);
  const launched: string[] = [];
  const events: any[] = [];
  const base = {
    executor: "device" as const,
    bot: { id: "bot", name: "本地", slug: "local" },
    model: { id: "model-1", name: "路由", context_window: 8000, max_tokens: 1000 },
    system: "", history: [], images: [],
  };
  const executor = new Executor({
    libraryRoot: join(root, "libraries"), agentDir: join(root, "agents"), phoneConfigPath: join(root, "phone.json"),
    proxyUrl: "http://api.example/llm/v1", llmToken: async () => "t", activity() {},
    send: message => events.push(message),
    factory: async () => { throw new Error("Pi 路径不该启动"); },
    cli: {
      dataDir: join(root, "no-mcp"),
      launch: async spec => {
        launched.push(spec.resume ?? "new");
        return { code: 0, stderr: "" };
      },
      fetchImpl: async (url, init) => {
        if (String(url).endsWith("/systemone")) {
          const close = launched.length > 0;
          const probabilities = close
            ? { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": 0.42, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": 0.48, __new__: 0.1 }
            : { "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa": 0.05, "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb": 0.9, __new__: 0.05 };
          return new Response(JSON.stringify({
            answers: { session: { choice: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", probabilities }, clear: { noul: close ? 0.91 : 0.95 } },
          }), { status: 200 });
        }
        assert.equal(String(url), "http://api.example/agent/cli-sessions");
        assert.equal(JSON.parse(String(init?.body)).engine_session_id, "thread-b");
        return new Response("{}", { status: 200 });
      },
    },
  });
  const sessions = [
    { id: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", engine_session_id: "thread-a", title: "甲", summary: "", last_user_text: "", updated_at: "2026-11-01T00:00:00.000Z" },
    { id: "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", engine_session_id: "thread-b", title: "乙", summary: "", last_user_text: "", updated_at: "2026-11-02T00:00:00.000Z" },
  ];
  await executor.start({ ...base, run_id: "r1", text: "接着改", cli: { runtime: "codex", profile: "default", directory: dir, persona: "", fresh: false, recent: [], sessions } } as RunContext);
  assert.deepEqual(launched, ["thread-b"]);
  assert.equal(events.at(-1).event.state, "completed");
  events.length = 0;
  await executor.start({ ...base, run_id: "r2", text: "继续", cli: { runtime: "codex", profile: "default", directory: dir, persona: "", fresh: false, recent: [], sessions } } as RunContext);
  assert.deepEqual(launched, ["thread-b"]);
  assert.match(events.at(-1).event.text, /请回复编号/);
});
