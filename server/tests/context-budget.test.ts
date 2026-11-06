import test from "node:test";
import assert from "node:assert/strict";
import { agentTaskBrief } from "../src/agents.js";
import { inputComposition } from "../src/observations.js";

test("task listings carry a result preview instead of every full result, tool log and checkpoint", () => {
  const result = "结果".repeat(5000);
  const brief = agentTaskBrief({
    task_id: "t1", status: "completed", title: "检查显存", target_bot_id: "b1", bot_name: "研究员",
    tools: [{ name: "run_command" }, { name: "read_file" }], checkpoint: { goal: "很长的检查点" }, routing: { requirements: ["gpu"] },
    result, progress: ["完成"], attachments: [],
  });
  assert.equal(brief.result_chars, result.length);
  assert.equal(brief.result_preview, `${result.slice(0, 300)}…`);
  assert.equal(brief.tool_count, 2);
  for (const key of ["result", "tools", "checkpoint", "routing"]) assert.equal(key in brief, false, key);
  assert.equal(brief.activity, "完成");
  const running = agentTaskBrief({ task_id: "t2", status: "running", title: "进行中", tools: [] });
  assert.equal("result_preview" in running, false);
});

test("generation metadata records how much of the request each input kind took", () => {
  assert.deepEqual(inputComposition([
    { role: "system", content: "系统" },
    { role: "user", content: "问题" },
    { type: "reasoning", content: [{ type: "reasoning_text", text: "思考" }] },
    { type: "function_call", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "c1", output: "结果" },
    { type: "function_call_output", call_id: "c2", output: "结果" },
  ]), {
    system: JSON.stringify({ role: "system", content: "系统" }).length,
    user: JSON.stringify({ role: "user", content: "问题" }).length,
    reasoning: JSON.stringify({ type: "reasoning", content: [{ type: "reasoning_text", text: "思考" }] }).length,
    tool_calls: JSON.stringify({ type: "function_call", name: "lookup", arguments: "{}" }).length,
    tool_results: 2 * JSON.stringify({ type: "function_call_output", call_id: "c1", output: "结果" }).length,
  });
  assert.equal(inputComposition("纯文本输入"), null);
});
