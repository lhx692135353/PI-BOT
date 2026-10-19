import type { ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";

const textOf = (c: any): string => (Array.isArray(c) ? c.map((p) => p.text ?? "").join("") : String(c ?? ""));

/** User input is carried by standard Responses user messages. */
export function latestUserText(input: any): string {
  const messages = Array.isArray(input) ? input : [];
  const user = [...messages].reverse().find((m) => m?.role === "user");
  return textOf(user?.content);
}

/** Results of tool calls returned by the model. */
export function realToolOutputs(input: any): any[] {
  const messages = Array.isArray(input) ? input : [];
  return messages.filter((m) => m?.type === "function_call_output");
}

export function isRealToolResult(input: any): boolean {
  const messages = Array.isArray(input) ? input : [];
  const last = messages.at(-1);
  if (last?.type !== "function_call_output") return false;
  const call = messages.find((m) => m?.type === "function_call" && m.call_id === last.call_id);
  return !!call;
}

/** Native Responses events shared by provider doubles, including complete-call xAI events. */
export class ResponseStream {
  private output: any[] = [];
  private sequence = 0;
  private id = `resp_${randomUUID()}`;
  private message: any;
  constructor(private res: ServerResponse, private model: string) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    this.event("response.created", { response: { id: this.id, status: "in_progress", output: [] } });
  }
  private event(type: string, data: object) {
    this.res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: this.sequence++, ...data })}\n\n`);
  }
  text(delta: string) {
    if (!this.message) {
      this.message = { id: `msg_${randomUUID()}`, type: "message", role: "assistant", status: "in_progress", content: [{ type: "output_text", text: "", annotations: [] }] };
      this.output.push(this.message);
      this.event("response.output_item.added", { output_index: this.output.length - 1, item: { ...this.message, content: [] } });
      this.event("response.content_part.added", { output_index: this.output.length - 1, item_id: this.message.id, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
    }
    this.message.content[0].text += delta;
    this.event("response.output_text.delta", { output_index: this.output.length - 1, item_id: this.message.id, content_index: 0, delta });
  }
  private endText() {
    if (!this.message) return;
    this.message.status = "completed";
    this.event("response.output_text.done", { output_index: this.output.length - 1, item_id: this.message.id, content_index: 0, text: this.message.content[0].text });
    this.event("response.output_item.done", { output_index: this.output.length - 1, item: this.message });
    this.message = undefined;
  }
  tool(name: string, args: object, callId: string, fragmented = false) {
    this.endText();
    const item = { type: "function_call", id: `fc_${randomUUID()}`, call_id: callId, name, arguments: JSON.stringify(args), status: "completed" };
    const output_index = this.output.length;
    this.output.push(item);
    this.event("response.output_item.added", { output_index, item: { ...item, status: "in_progress", arguments: fragmented ? "" : item.arguments } });
    if (fragmented) {
      for (const delta of Array.from(item.arguments)) this.event("response.function_call_arguments.delta", { output_index, item_id: item.id, delta });
      this.event("response.function_call_arguments.done", { output_index, item_id: item.id, arguments: item.arguments });
    }
    this.event("response.output_item.done", { output_index, item });
  }
  end(inputTokens = 42, outputTokens = 3) {
    this.endText();
    this.event("response.completed", { response: { id: this.id, object: "response", model: this.model, status: "completed", output: this.output, usage: { input_tokens: inputTokens, output_tokens: outputTokens, total_tokens: inputTokens + outputTokens } } });
    this.res.end();
  }
}
