import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { Hub } from "../src/hub.js";
import { insertRun } from "../src/bots.js";
import { issueLlmToken } from "../src/security.js";
import { libraryFileId } from "../src/devices.js";
import { resetDatabase, TEST_DB, tempDir, vaultFile } from "./helpers.js";

test("the cloud computer is listed like a computer, holds the library and receives files generated on a computer", { skip: !TEST_DB }, async (t) => {
  await resetDatabase(TEST_DB!);
  const dir = tempDir(), db = new Database(TEST_DB!), hub = new Hub();
  const root = join(dir.path, "workspaces");
  const s = settings({ PI_BOT_DATABASE_URL: TEST_DB, PI_BOT_JWT_SECRET: "j".repeat(40), PI_BOT_ADMIN_PASSWORD: "test-password", PI_BOT_VAULT_FILE: vaultFile(dir.path), PI_BOT_LOCAL_WORK_ROOT: root });
  const app = await createApp(s, db, hub);
  t.after(async () => { await app.close(); dir.cleanup(); });
  const login = (await app.inject({ method: "POST", url: "/auth/login", payload: { username: "admin", password: "test-password" } })).json(), user = login.user.id;
  const api = (method: "GET" | "POST", url: string, payload?: object) => app.inject({ method, url, payload, headers: { authorization: "Bearer " + login.access_token } });

  const me = (await api("GET", "/me")).json();
  assert.equal(me.cloud_computer.label, "云端电脑");
  assert.equal(me.cloud_computer.online, true);
  const bot = (await api("GET", "/bots")).json().bots[0];

  const sources = (await api("GET", `/bots/${bot.id}/files/sources`)).json().sources;
  assert.equal(sources[0].kind, "cloud", "the cloud library is listed first");
  assert.equal(new Set(sources.map((x: { target: string }) => x.target)).size, sources.length);

  const device = randomUUID();
  await db.tx((tx) => tx.insert("devices", { device_id: device, user_id: user, label: "Mac", public_key: device, platform: "darwin" }));
  const run = await db.tx(async (tx) => {
    const r = await insertRun(tx, { userId: user, botId: bot.id, requestId: randomUUID(), text: "写报告", computer: { deviceId: device }, lane: "task" });
    return tx.update("bot_runs", r.run_id, { status: "running" });
  });
  assert.equal(run.executor, "device");
  const token = await issueLlmToken({ sub: user, src: "device", bot: bot.id, did: device }, s);
  const upload = (path: string, content: string) => app.inject({ method: "POST", url: "/agent/library/files", headers: { authorization: "Bearer " + token }, payload: { run_id: run.run_id, path, content_base64: Buffer.from(content).toString("base64") } });

  const sent = await upload("outputs/report.md", "# 报告");
  assert.equal(sent.statusCode, 200, sent.body);
  assert.equal(sent.json().id, libraryFileId(bot.id, "outputs/report.md"));
  assert.equal(await readFile(join(root, bot.slug, "outputs", "report.md"), "utf8"), "# 报告");
  assert.equal((await upload("../escape.txt", "x")).statusCode, 422);
  assert.equal((await upload("/etc/passwd", "x")).statusCode, 422);

  const listing = (await api("GET", `/bots/${bot.id}/files?path=outputs`)).json();
  assert.equal(listing.target, sources[0].target, "the cloud computer is browsed by default");
  assert.deepEqual(listing.entries.map((e: { id: string; name: string }) => [e.name, e.id]), [["report.md", sent.json().id]]);
});
