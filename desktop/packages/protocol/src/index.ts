import type { ArtifactRef } from "@pi-bot/runtime-contracts";
export type { ArtifactRef } from "@pi-bot/runtime-contracts";
import { z } from 'zod';
import { validImages, IMAGE_TYPES, MAX_IMAGES, MAX_IMAGE_BYTES, IMAGE_LIMIT_HINT, type MessageImage } from '@pi-bot/agent/images';
import type { UiDocument } from '@pi-bot/a2ui';
import { COLORS, SCHEMES, SHAPES, type Avatar, type Mood } from '@pi-bot/bot-face';

export const avatarSchema = z.object({ shape: z.enum(SHAPES), color: z.enum(COLORS), scheme: z.enum(SCHEMES) });
const id = z.string().uuid();
const phoneSession = { deviceId: id, sessionId: id };
const phoneInputEvent = z.discriminatedUnion('type', [
 z.object({type:z.literal('tap'),x:z.number().int().min(0).max(719),y:z.number().int().min(0).max(1279)}).strict(),
 z.object({type:z.literal('swipe'),x1:z.number().int().min(0).max(719),y1:z.number().int().min(0).max(1279),x2:z.number().int().min(0).max(719),y2:z.number().int().min(0).max(1279),duration:z.number().int().min(50).max(2000)}).strict(),
 z.object({type:z.literal('text'),text:z.string().min(1).max(1000).regex(/^[\x20-\x7e]+$/)}).strict(),
 z.object({type:z.literal('key'),code:z.union([z.literal(3),z.literal(4),z.literal(67),z.literal(66),z.literal(187)])}).strict(),
]);
const imagesSchema = z.array(z.object({ name: z.string().trim().min(1).max(255), mime_type: z.enum(IMAGE_TYPES), data: z.string().min(1).max(Math.ceil(MAX_IMAGE_BYTES / 3) * 4) })).max(MAX_IMAGES).refine(validImages, IMAGE_LIMIT_HINT);

/** Local service methods the Electron UI may call. Every cloud call is signed by the service. */
export const schemas = {
  phoneStatus: z.object({deviceId:id}).strict(),
  // Read-only preview: same JPEG result as phoneFrame, but no session and no lease renewal.
  phonePreview: z.object({deviceId:id}).strict(),
  phoneAcquire: z.object({deviceId:id}).strict(),
  phoneFrame: z.object(phoneSession).strict(),
  phoneInput: z.object({...phoneSession,event:phoneInputEvent}).strict(),
  phoneRelease: z.object(phoneSession).strict(),
  remoteArtifact:z.object({id}),
  reportOpen:z.object({id}),
  remoteDesktop:z.object({botId:id}),
  status: z.object({}),
  login: z.object({ serverUrl: z.string().url(), username: z.string().trim().min(1).max(64), password: z.string().min(1).max(200), label: z.string().trim().min(1).max(80) }),
  logout: z.object({}),
  models: z.object({}),
  devices: z.object({}),
  deviceRevoke: z.object({ id }),
  openLibrary: z.object({ id }),
  goals: z.object({ id }),
  librarySources: z.object({ id }),
  library: z.object({ id, target:z.string().optional(), path: z.string().max(2000).default('') }),
  libraryRead: z.object({ id, target:z.string().optional(), path: z.string().min(1).max(2000) }),
  bots: z.object({}),
  botCreate: z.object({ name: z.string().trim().min(1).max(40), persona: z.string().max(8000).default(''), model_id: id.nullable().optional(), execution_device_id: id.nullable().optional(), avatar: avatarSchema }),
  botUpdate: z.object({ id, name: z.string().trim().min(1).max(40).optional(), persona: z.string().max(8000).optional(), model_id: id.nullable().optional(), execution_device_id: id.nullable().optional(), avatar: avatarSchema.optional() }),
  botDelete: z.object({ id }),
  taskConversation: z.object({ botId: id, taskId: id, after: z.number().int().nonnegative().optional() }),
  messages: z.object({ botId: id, before: z.number().int().positive().optional() }),
  send: z.object({ botId: id, text: z.string().trim().max(100000).default(''), images: imagesSchema.default([]), request_id: id.optional() }).refine(body => body.text.length > 0 || body.images.length > 0, '请填写消息或选择图片'),
  image: z.object({ botId: id, messageId: id, imageId: id }),
  voiceTicket: z.object({ botId: id }),
  uiState: z.object({ botId: id, messageId: id, revision: z.number().int().positive(), states: z.unknown() }),
  uiAction: z.object({ botId: id, messageId: id, revision: z.number().int().positive(), states: z.unknown(), action: z.unknown(), request_id: id }),
  cancel: z.object({ runId: id }),
  decide: z.object({ approvalId: id, decision: z.enum(['approve', 'reject']) }),
} as const;
export type Method = keyof typeof schemas;
export function parseInput(method: Method, input: unknown) {
  const schema = schemas[method];
  if (!schema) throw new Error('未知方法');
  const parsed = schema.safeParse(input ?? {});
  if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? '参数无效');
  return parsed.data;
}

export type RunStatus = 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled';
export interface Run { operation_target?:string; device_id?: string | null; lane?: 'conversation' | 'task'; task_id?: string | null; id: string; bot_id: string; status: RunStatus; executor: 'device' | 'cloud'; error: string | null; created_at: string; finished_at: string | null; assistant_message_id: string }
export interface ToolEntry { id: string; name: string; state: 'running' | 'completed' | 'failed'; summary?: string }
/** Another bot that wrote a `user` message: a delegated task, or the report of one this bot handed off. */
export interface FromBot { id: string; name: string; avatar: Avatar | null; kind: 'task' | 'report' }
export interface ReplySegment { id: string; text: string; phase: 'opening' | 'update' | 'answer'; created_at: string; generated_at: string }
export interface TaskConversation { execution_label?:string; operation_target?:string; task_id: string; status: RunStatus; bots: { id: string; name: string; avatar: Avatar }[]; messages: { id: string; seq: number; from_bot_id: string; to_bot_id: string; kind: string; content: string; created_at: string | null }[]; total: number; has_more: boolean; next_after: number }
export interface AgentTaskRef { message_count?: number; operation_target?:string; id: string; bot_id: string; bot_name: string; status: 'queued' | 'running' | 'waiting_approval' | 'completed' | 'failed' | 'cancelled'; mode: 'wait' | 'report'; kind?: 'background' | 'delegation'; title?: string; updated_at?: string; activity?: string | null }
export interface Message { attachments?: ArtifactRef[]; reply_segments?: ReplySegment[]; task_id?: string | null; id: string; bot_id: string; run_id: string | null; seq: number; role: 'user' | 'assistant'; content: string; images?: MessageImage[]; status: 'completed' | 'running' | 'failed' | 'cancelled'; executor: 'device' | 'cloud' | null; tools: ToolEntry[]; progress?: string[]; ui?: UiDocument | null; from_bot?: FromBot | null; agent_tasks?: AgentTaskRef[]; created_at: string; updated_at: string }
export interface Approval { id: string; run_id: string; bot_id: string; kind: 'outside_access'; path: string; reason: string; status: string; expires_at: string }
export interface Bot { execution_device_id?: string | null; active_tasks?: AgentTaskRef[]; activity?: { status: RunStatus | null; tool: string | null; summary: string | null; running_count: number; queued_count: number }; id: string; name: string; slug: string; persona: string; model_id: string | null; avatar: Avatar; is_main?: boolean; created_at: string; last_active_at: string; latest_run: Run | null; last_message: { role: string; preview: string; status: string; created_at: string } | null; pending_approvals: Approval[] }
export interface ModelOption { id: string; name: string; is_default: boolean }
export interface Device { id: string; label: string; platform: 'linux' | 'darwin' | 'win32'; online: boolean; revoked_at: string | null; last_seen_at: string | null }
export interface MessagePage { messages: Message[]; has_more: boolean }

export type Connection = 'signed_out' | 'connecting' | 'online' | 'offline' | 'revoked';
export interface AccountState {
  connection: Connection;
  serverUrl: string | null;
  user: { id: string; username: string; display_name: string } | null;
  deviceLabel: string | null;
  deviceId?: string | null;
  libraryRoot: string;
}
/** What this computer is doing for a bot right now, for the character's mood. */
export interface LocalActivity { botId: string; runId: string; tool: string | null; mood: Mood }

export type AppEvent =
  | { type: 'service.status'; connected: boolean }
  | { type: 'account'; state: AccountState }
  | { type: 'bots' }
  | { type: 'bot'; bot_id: string }
  | { type: 'delta'; bot_id: string; message_id: string; content: string }
  | { type: 'activity'; activity: LocalActivity | null; botId: string }
  | { type: 'bot.mood'; bot_id: string; name: string; mood: Mood };

export interface DesktopBridge {
  updates?: {
    state(): Promise<ClientUpdateState>;
    check(channel: UpdateChannel): Promise<ClientUpdateState>;
    download(): Promise<ClientUpdateState>;
    install(): Promise<boolean>;
  };
  call(method: Method, input?: unknown): Promise<unknown>;
  subscribe(listener: (event: AppEvent) => void): () => void;
  computerName(): Promise<string>;
  defaultServerUrl(): Promise<string>;
  openLibrary(botId: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

export type UpdateChannel = 'stable' | 'test';
export interface ClientUpdateState {
  supported?: boolean;
  channel: UpdateChannel;
  phase: 'idle' | 'checking' | 'available' | 'downloading' | 'ready' | 'launching' | 'error';
  version: string;
  buildNumber: number;
  message: string;
  candidate?: { version: string; buildNumber: number; commit: string; size: number };
}
