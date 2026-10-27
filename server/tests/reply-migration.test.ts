import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Database } from "../src/db.js";
import { migrate } from "../src/migrate.js";
import { createBot, insertRun } from "../src/bots.js";
import { resetDatabase, TEST_DB } from "./helpers.js";

test("upgrade reconstructs old delegation messages once and leaves unknown progress times empty", { skip: !TEST_DB }, async () => {
  await resetDatabase(TEST_DB!);
  const db = new Database(TEST_DB!);
  try {
    await migrate(db);
    const taskId = randomUUID(), userId = randomUUID();
    await db.tx(async tx => {
      await tx.insert("users", { user_id: userId, username: "migration-user", password_hash: "unused", role: "user" });
      const a = await createBot(tx, userId, { name: "甲", persona: "" });
      const b = await createBot(tx, userId, { name: "乙", persona: "" });
      const parent = await insertRun(tx, { userId, botId: a.bot_id, requestId: randomUUID(), text: "检查", computer: null });
      await tx.insert("agent_tasks", { task_id: taskId, user_id: userId, parent_run_id: parent.run_id, parent_bot_id: a.bot_id, target_bot_id: b.bot_id, mode: "report", kind: "delegation", depth: 1, task: "核对服务", status: "completed", result: "服务正常", finished_at: new Date("2026-10-27T10:00:00Z") });
      const child = await insertRun(tx, { userId, botId: b.bot_id, requestId: randomUUID(), text: "核对服务", computer: null, taskId, origin: "agent", lane: "task", fromBotId: a.bot_id });
      await tx.rows("UPDATE agent_tasks SET child_run_id=$2 WHERE task_id=$1", [taskId, child.run_id]);
      await tx.rows("UPDATE bot_messages SET progress='[\"正在核对\"]' WHERE message_id=$1", [child.assistant_message_id]);
      await tx.rows("INSERT INTO agent_task_instructions(instruction_id,task_id,request_id,text) VALUES($1,$2,'more','再检查测试机器')", [randomUUID(), taskId]);
      await tx.rows("DROP TABLE agent_task_messages");
      await tx.rows("ALTER TABLE bot_messages DROP COLUMN reply_segments");
      await tx.rows("ALTER TABLE bot_runs DROP COLUMN first_reply_at, DROP COLUMN first_reply_generated_at, DROP COLUMN first_reply_generation_ms");
      await tx.rows("DELETE FROM schema_migrations WHERE version='0017-replies-conversations'");
    });
    await migrate(db); await migrate(db);
    await db.tx(async tx => {
      const rows = await tx.rows("SELECT * FROM agent_task_messages WHERE task_id=$1 ORDER BY seq", [taskId]);
      assert.deepEqual(rows.map(r => r.kind), ["request", "instruction", "update", "answer"]);
      assert.equal(rows[2].created_at, null);
      assert.equal(rows[3].created_at.toISOString(), "2026-10-27T10:00:00.000Z");
      assert.deepEqual(rows.map(r => r.content), ["核对服务", "再检查测试机器", "正在核对", "服务正常"]);
    });
  } finally { await db.close(); }
});
