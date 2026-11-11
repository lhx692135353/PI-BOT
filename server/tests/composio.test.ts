import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";
import { ComposioGateway, composioIsActive, normalizeComposioBaseUrl } from "../src/composio.js";

test("未启用或缺少地址、密钥时连接器保持关闭", () => {
  assert.equal(composioIsActive(undefined), false);
  assert.equal(composioIsActive({ enabled: true, base_url: "https://connect.example", secret: null }), false);
  assert.equal(composioIsActive({ enabled: false, base_url: "https://connect.example", secret: { key_id: "a" } }), false);
  assert.equal(composioIsActive({ enabled: true, base_url: "https://connect.example", secret: { key_id: "a" } }), true);
});

test("连接器地址只接受不带账号的 http 或 https", () => {
  assert.equal(normalizeComposioBaseUrl(" https://connect.example/api/ "), "https://connect.example/api");
  assert.throws(() => normalizeComposioBaseUrl("https://user:secret@connect.example"), /不能携带账号或密钥/);
  assert.throws(() => normalizeComposioBaseUrl("ftp://connect.example"), /只接受 http 或 https/);
});

test("搜索、授权和执行都使用当前用户，并关闭远端代码沙箱", async () => {
  const seen: { path: string; body: any; key: string | undefined }[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    seen.push({ path: req.url ?? "", body: JSON.parse(Buffer.concat(chunks).toString("utf8")), key: req.headers["x-api-key"] as string });
    const path = req.url ?? "";
    if (path.endsWith("/session")) res.end(JSON.stringify({ session_id: "sess-1" }));
    else if (path.endsWith("/search")) res.end(JSON.stringify({ tools: [{ slug: "GMAIL_SEND", secret: "gateway-key" }] }));
    else if (path.endsWith("/link")) res.end(JSON.stringify({ redirect_url: "https://accounts.example/allow" }));
    else if (path.endsWith("/execute")) res.end(JSON.stringify({ data: { id: "msg-1" }, error: "gateway-key leaked" }));
    else { res.writeHead(500); res.end("{}"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有端口");
  const gateway = new ComposioGateway(`http://127.0.0.1:${address.port}`, "gateway-key");
  try {
    const found = await gateway.search("user-7", "发邮件");
    assert.match(found, /GMAIL_SEND/);
    const linked = await gateway.connect("user-7", "gmail");
    assert.equal(linked.redirect_url, "https://accounts.example/allow");
    const done = await gateway.execute("user-7", "GMAIL_SEND", { to: "a@example.com" });
    assert.match(done, /msg-1/);
    assert.match(done, /\[已隐藏密钥\]/);
    assert.doesNotMatch(found, /gateway-key/);
    const sessions = seen.filter((item) => item.path.endsWith("/session"));
    assert.equal(sessions.length, 3);
    assert.ok(sessions.every((item) => item.body.user_id === "user-7" && item.body.workbench.enable === false && item.body.proxy_execute.enable === false && item.body.manage_connections.enable_connection_removal === false));
    assert.equal(seen.find((item) => item.path.endsWith("/link"))?.body.toolkit, "gmail");
    assert.equal(seen.find((item) => item.path.endsWith("/execute"))?.body.tool_slug, "GMAIL_SEND");
    assert.ok(seen.every((item) => item.key === "gateway-key"));
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
