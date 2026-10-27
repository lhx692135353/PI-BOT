import { toolDescriptor } from "@pi-bot/runtime-contracts";
import type { Mood } from "./spec.js";

export type RunStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "cancelled";
export interface BotActivity {
  /** Latest run status, or null when the bot has never run. */
  status: RunStatus | null;
  /** Name of the tool currently running, if any. */
  tool?: string | null;
  /** When the latest run finished, in ms. Celebrate/error moods fade after a while. */
  finishedAt?: number | null;
  /** Last activity time in ms, used for the sleeping mood. */
  lastActiveAt?: number | null;
  now?: number;
}
export const SLEEP_AFTER_MS = 3 * 86400_000;
const AFTERGLOW_MS = 6000;

/** Single source of truth for how run state maps to the character's mood. */
export function moodFor(a: BotActivity): Mood {
  const now = a.now ?? Date.now();
  switch (a.status) {
    case "queued":
      return "thinking";
    case "running":
      if (a.tool) return toolDescriptor(a.tool)?.activity ?? "working";
      return "thinking";
    case "waiting_approval":
      return "waiting";
    case "completed":
      if (a.finishedAt && now - a.finishedAt < AFTERGLOW_MS) return "celebrate";
      break;
    case "failed":
      if (a.finishedAt && now - a.finishedAt < AFTERGLOW_MS) return "error";
      break;
  }
  if (a.lastActiveAt && now - a.lastActiveAt > SLEEP_AFTER_MS) return "sleeping";
  return "idle";
}
/** "7 days" style label shown under a sleeping bot. */
export function sleepLabel(lastActiveAt: number, now = Date.now()) {
  const days = Math.floor((now - lastActiveAt) / 86400_000);
  return days >= 1 ? `${days} 天` : null;
}
