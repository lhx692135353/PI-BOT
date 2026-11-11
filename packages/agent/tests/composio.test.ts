import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { composioTools } from "../src/composio.js";

test("连接器工具只把当前运行令牌交给 API", async () => {
  const seen: { path: string; authorization: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    res.end(JSON.stringify({ text: "已找到动作" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有端口");
  const [search, connect, execute] = composioTools(`http://127.0.0.1:${address.port}`, () => "run-token");
  try {
    assert.deepEqual([search!.name, connect!.name, execute!.name], ["composio_search", "composio_connect", "composio_execute"]);
    const ctx = undefined as never;
    await search!.execute("call-1", { query: "发邮件" }, undefined, undefined, ctx);
    await connect!.execute("call-2", { toolkit: "gmail" }, undefined, undefined, ctx);
    await execute!.execute("call-3", { tool_slug: "GMAIL_SEND", arguments: { to: "a@example.com" } }, undefined, undefined, ctx);
    assert.deepEqual(seen.map((item) => item.path), ["/agent/composio/search", "/agent/composio/connect", "/agent/composio/execute"]);
    assert.ok(seen.every((item) => item.authorization === "Bearer run-token"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
