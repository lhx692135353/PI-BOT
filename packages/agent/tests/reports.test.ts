import test from "node:test";
import assert from "node:assert/strict";
import {
  reportContextMessages,
  reportContextExtension,
} from "../src/reports.js";

test("report bodies are excluded from subsequent provider requests and both compaction inputs", () => {
  const messages = [
    {
      role: "assistant",
      content: [
        {
          type: "toolCall",
          name: "publish_report",
          arguments: {
            title: "检查报告",
            summary: "已检查",
            content: "CANARY-BODY",
          },
        },
        { type: "text", text: "已检查" },
      ],
    },
  ];
  const safe = reportContextMessages(messages);
  assert.ok(!JSON.stringify(safe).includes("CANARY-BODY"));
  assert.ok(JSON.stringify(safe).includes("已检查"));
  assert.ok(
    JSON.stringify(messages).includes("CANARY-BODY"),
    "do not mutate source history",
  );
  const handlers = new Map<string, Function>();
  reportContextExtension({
    on: (name: string, handler: Function) => handlers.set(name, handler),
  } as any);
  const compact = {
    preparation: {
      messagesToSummarize: messages,
      turnPrefixMessages: messages,
    },
  };
  handlers.get("session_before_compact")!(compact);
  assert.ok(!JSON.stringify(compact).includes("CANARY-BODY"));
  assert.ok(
    !JSON.stringify(handlers.get("context")!({ messages })).includes(
      "CANARY-BODY",
    ),
  );
});
