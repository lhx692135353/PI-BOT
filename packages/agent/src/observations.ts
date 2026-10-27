import { randomUUID } from "node:crypto";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
/** Backend-neutral events. This module has no exporter, credentials or vendor SDK. */
export interface Observation {
  id: string;
  name: string;
  tool_call_id: string;
  generation_id?: string;
  started_at: string;
  ended_at: string;
  input?: unknown;
  output?: unknown;
  error?: boolean;
  incomplete?: boolean;
  phase?: "start" | "end";
}
/** Image tool results go to the model, never into diagnostic events. */
function diagnosticValue(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[nested value]';
  if (Array.isArray(value)) return value.map(item => diagnosticValue(item, depth + 1));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (record.type === 'image') return { type: 'image', mimeType: record.mimeType, omitted: true };
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, diagnosticValue(item, depth + 1)]));
  }
  return value;
}
export function observationExtension(
  runId: string,
  onObservation?: (event: Observation) => void,
): ExtensionFactory {
  return (pi) => {
    let generation: string | undefined, parentTool: string | undefined;
    const running = new Map<
      string,
      { name: string; input: unknown; started: string; generation?: string }
    >();
    pi.on("before_provider_headers", (e) => {
      generation = randomUUID();
      e.headers["x-pibot-run-id"] = runId;
      e.headers["x-pibot-generation-id"] = generation;
      if (parentTool) e.headers["x-pibot-parent-tool-id"] = parentTool;
    });
    const emit = (o: Observation) => {
      try {
        const bound = (value: unknown) => {
          if (value === undefined) return value;
          try {
            value = diagnosticValue(value);
            const text = JSON.stringify(value);
            return Buffer.byteLength(text) > 65536
              ? {
                  truncated: true,
                  preview: Buffer.from(text)
                    .subarray(0, 64000)
                    .toString("utf8"),
                }
              : value;
          } catch {
            return "[unserializable observation]";
          }
        };
        onObservation?.({
          ...o,
          input: bound(o.input),
          output: bound(o.output),
        });
      } catch {
        /* Diagnostics never abort tools. */
      }
    };
    pi.on("tool_execution_start", (e) => {
      const started = new Date().toISOString();
      running.set(e.toolCallId, {
        name: e.toolName,
        input: e.toolName === "publish_report" ? { title: (e.args as any)?.title, summary: (e.args as any)?.summary, content: "[report body omitted]" } : e.args,
        started,
        generation,
      });
      emit({
        id: randomUUID(),
        name: e.toolName,
        tool_call_id: e.toolCallId,
        generation_id: generation,
        started_at: started,
        ended_at: started,
        input: e.toolName === "publish_report" ? { title: (e.args as any)?.title, summary: (e.args as any)?.summary, content: "[report body omitted]" } : e.args,
        incomplete: true,
        phase: "start",
      });
    });
    pi.on("tool_execution_end", (e) => {
      const start = running.get(e.toolCallId);
      running.delete(e.toolCallId);
      parentTool = e.toolCallId;
      emit({
        id: randomUUID(),
        name: e.toolName,
        tool_call_id: e.toolCallId,
        generation_id: start?.generation,
        started_at: start?.started ?? new Date().toISOString(),
        ended_at: new Date().toISOString(),
        input: start?.input,
        output: e.result,
        error: e.isError,
        incomplete: !start,
        phase: "end",
      });
    });
    pi.on("session_shutdown", () => {
      for (const [id, start] of running)
        emit({
          id: randomUUID(),
          name: start.name,
          tool_call_id: id,
          generation_id: start.generation,
          started_at: start.started,
          ended_at: new Date().toISOString(),
          input: start.input,
          incomplete: true,
          error: true,
        });
      running.clear();
    });
  };
}
