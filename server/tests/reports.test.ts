import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createApp } from "../src/app.js";
import { Database } from "../src/db.js";
import { settings } from "../src/config.js";
import { insertRun, finishRun, buildContext } from "../src/bots.js";
import { issueLlmToken } from "../src/security.js";
import { resetDatabase, TEST_DB, tempDir, vaultFile } from "./helpers.js";
import { bounded } from "../src/observations.js";

test(
  "report storage is idempotent, owner scoped, previewable and excluded from chat and next-run context",
  { skip: !TEST_DB },
  async () => {
    await resetDatabase(TEST_DB!);
    const dir = tempDir();
    const db = new Database(TEST_DB!);
    const s = settings({
      PI_BOT_DATABASE_URL: TEST_DB!,
      PI_BOT_ADMIN_PASSWORD: "test-password",
      PI_BOT_JWT_SECRET: "j".repeat(40),
      PI_BOT_VAULT_FILE: vaultFile(dir.path),
    });
    const app = await createApp(s, db);
    try {
      const login = (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: "admin", password: "test-password" },
        })
      ).json();
      const headers = { authorization: `Bearer ${login.access_token}` };
      const user = login.user.id;
      await app.inject({
        method: "POST",
        url: "/admin/api/models",
        headers,
        payload: {
          name: "test",
          base_url: "http://127.0.0.1:1/v1",
          provider_model: "test",
          api_key: "unused",
          context_window: 32000,
          max_tokens: 1000,
        },
      });
      const bot = (
        await app.inject({ method: "GET", url: "/bots", headers })
      ).json().bots[0].id;
      const run = await db.tx((tx) =>
        insertRun(tx, {
          userId: user,
          botId: bot,
          requestId: randomUUID(),
          text: "整理完整报告",
          computer: null,
          lane: "task",
        }),
      );
      const token = await issueLlmToken({ sub: user, src: "cloud", bot }, s);
      const llmHeaders = { authorization: `Bearer ${token}` };
      const marker = "REPORT-BODY-PRIVATE-CANARY";
      const content = `# 报告\n${marker}\n${"正文\n".repeat(5000)}`;
      const save = () =>
        app.inject({
          method: "POST",
          url: "/agent/reports",
          headers: llmHeaders,
          payload: {
            run_id: run.run_id,
            request_id: "call-report-1",
            title: "完整检查报告",
            summary: "检查完成，详情见文件。",
            content,
          },
        });
      const first = await save();
      assert.equal(first.statusCode, 200, first.body);
      const artifact = first.json().artifact;
      assert.equal((await save()).json().artifact.id, artifact.id);
      assert.ok(!first.body.includes(marker));
      assert.equal(
        (
          await db.tx((tx) =>
            tx.rows("SELECT artifact_id FROM report_artifacts"),
          )
        ).length,
        1,
      );
      await app.inject({
        method: "POST",
        url: "/admin/api/users",
        headers,
        payload: {
          username: "other",
          password: "other-password",
          display_name: "其他用户",
        },
      });
      const other = (
        await app.inject({
          method: "POST",
          url: "/auth/login",
          payload: { username: "other", password: "other-password" },
        })
      ).json();
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/reports/${artifact.id}/open`,
            headers: { authorization: `Bearer ${other.access_token}` },
          })
        ).statusCode,
        404,
      );
      const open = await app.inject({
        method: "POST",
        url: `/reports/${artifact.id}/open`,
        headers,
      });
      assert.equal(open.statusCode, 200);
      const ticket = open.json().url.split("#token=")[1];
      const file = await app.inject({
        method: "GET",
        url: `/reports/${artifact.id}/content?ticket=${ticket}`,
      });
      assert.equal(file.body, content);
      assert.equal(file.headers["cache-control"], "no-store");
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/reports/${artifact.id}/content?ticket=bad`,
          })
        ).statusCode,
        401,
      );
      assert.equal(
        (
          await app.inject({
            method: "GET",
            url: `/reports/${randomUUID()}/content?ticket=${ticket}`,
          })
        ).statusCode,
        401,
      );
      const slice = await app.inject({
        method: "POST",
        url: `/agent/reports/${artifact.id}/read`,
        headers: llmHeaders,
        payload: { run_id: run.run_id, limit: 100 },
      });
      assert.equal(slice.statusCode, 200);
      assert.ok(slice.json().text.length <= 100);
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: `/agent/reports/${artifact.id}/read`,
            headers: llmHeaders,
            payload: { run_id: run.run_id, limit: 4001 },
          })
        ).statusCode,
        422,
      );
      await db.tx((tx) =>
        finishRun(tx, run.run_id, "completed", null, content),
      );
      const message = await db.tx((tx) =>
        tx.get("bot_messages", run.assistant_message_id),
      );
      assert.equal(message.content, "检查完成，详情见文件。");
      assert.ok(!JSON.stringify(message).includes(marker));
      const next = await db.tx((tx) =>
        insertRun(tx, {
          userId: user,
          botId: bot,
          requestId: randomUUID(),
          text: "继续聊",
          computer: null,
        }),
      );
      const context = await db.tx((tx) => buildContext(tx, s, next));
      assert.ok(!JSON.stringify(context).includes(marker));
      const stored = await db.tx((tx) =>
        tx.one(
          "SELECT encode(body,'escape') AS content FROM report_artifacts WHERE artifact_id=$1",
          [artifact.id],
        ),
      );
      assert.ok(stored!.content.includes(marker));
    } finally {
      await app.close();
      dir.cleanup();
    }
  },
);

test("provider-native report arguments are omitted from diagnostics without inspecting prose", () => {
  const raw = {
    type: "function_call",
    name: "publish_report",
    arguments: JSON.stringify({ content: "PRIVATE-REPORT-BODY" }),
  };
  assert.ok(!JSON.stringify(bounded(raw)).includes("PRIVATE-REPORT-BODY"));
});
