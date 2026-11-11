import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { settings } from "../src/config.js";
import { jevCredentials, jevPublic, normalizeJevBaseUrl, probeJev, saveJev } from "../src/jev.js";
import { TEST_DB, resetDatabase, tempDir, vaultFile } from "./helpers.js";

test("JEV 地址只接受不带账号的 http 或 https", () => {
  assert.equal(normalizeJevBaseUrl(" https://jev.example/v1/systemone/ "), "https://jev.example/v1/systemone");
  assert.throws(() => normalizeJevBaseUrl("https://user:secret@jev.example"), /不能携带账号或密钥/);
  assert.throws(() => normalizeJevBaseUrl("ftp://jev.example"), /只接受 http 或 https/);
});

test("连接测试不回传密钥", async () => {
  let authorization = "";
  const server = createServer((req, res) => {
    authorization = String(req.headers.authorization ?? "");
    res.writeHead(401);
    res.end(JSON.stringify({ error: "bad key sk-jev" }));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("测试服务没有端口");
  try {
    await assert.rejects(
      probeJev({ baseUrl: `http://127.0.0.1:${address.port}`, model: "jev-latest", apiKey: "sk-jev" }),
      /密钥被拒绝/,
    );
    assert.equal(authorization, "Bearer sk-jev");
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test("后台保存的 JEV 覆盖环境变量，且接口不返回密钥", { skip: !TEST_DB }, async () => {
  await resetDatabase(TEST_DB!);
  const db = new Database(TEST_DB!);
  const dir = tempDir();
  const s = settings({
    PI_BOT_DATABASE_URL: TEST_DB,
    PI_BOT_JWT_SECRET: "j".repeat(40),
    PI_BOT_ADMIN_PASSWORD: "test-password",
    PI_BOT_VAULT_FILE: vaultFile(dir.path),
    PI_BOT_JEV_BASE_URL: "https://env.example",
    PI_BOT_JEV_API_KEY: "env-key",
    PI_BOT_JEV_MODEL: "jev-env",
  });
  await migrate(db);
  const before = await db.tx(tx => jevPublic(tx, s));
  assert.equal(before.source, "environment");
  assert.equal(before.base_url, "https://env.example");
  assert.equal(JSON.stringify(before).includes("env-key"), false);
  assert.equal((await db.tx(tx => jevCredentials(tx, s)))?.apiKey, "env-key");

  const saved = await db.tx(tx => saveJev(tx, s, { enabled: true, base_url: "https://admin.example/v1/systemone", model: "jev-admin", api_key: "admin-key" }));
  assert.equal(saved.source, "database");
  assert.equal(saved.model, "jev-admin");
  assert.equal(saved.configured, true);
  assert.equal(JSON.stringify(saved).includes("admin-key"), false);
  assert.deepEqual(await db.tx(tx => jevCredentials(tx, s)), {
    baseUrl: "https://admin.example/v1/systemone", model: "jev-admin", apiKey: "admin-key",
  });

  const kept = await db.tx(tx => saveJev(tx, s, { enabled: true, base_url: "https://admin.example", model: "jev-kept" }));
  assert.equal(kept.model, "jev-kept");
  assert.equal((await db.tx(tx => jevCredentials(tx, s)))?.apiKey, "admin-key");

  await db.tx(tx => saveJev(tx, s, { enabled: false, base_url: "https://admin.example", model: "jev-kept" }));
  assert.equal(await db.tx(tx => jevCredentials(tx, s)), undefined);
  await assert.rejects(db.tx(tx => saveJev(tx, s, { enabled: true, base_url: "notaurl", model: "jev-latest", api_key: "x" })), /JEV 地址无效/);
  dir.cleanup();
  await db.close();
});
