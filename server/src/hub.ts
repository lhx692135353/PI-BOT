import { errorInfo } from "@pi-bot/runtime-contracts";
import { randomUUID } from "node:crypto";
import { HttpError, type Row } from "./db.js";

export interface DeviceConnection {
  deviceId: string;
  userId: string;
  capabilities?: string[];
  send(message: Row): void;
  close(code: number): void;
}
export type CallPhase = "connecting" | "listening" | "speaking" | "thinking" | "ended";
export type UserEvent =
  | { type: "bot"; bot_id: string }
  | { type: "delta"; bot_id: string; message_id: string; content: string }
  | { type: "presence"; online: boolean; device_id: string; device_online: boolean }
  | { type: "bots" }
  | { type: "call"; bot_id: string; call_id: string; phase: CallPhase; reason?: string };
type Pending = {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
  deviceId: string;
};

/**
 * Live computer connections and user event fan-out for this API process.
 * The API runs as a single replica because device sockets terminate here.
 */
export class Hub {
  prepareRemote?: (userId: string) => Promise<void>;
  remotePreflight?: (env: Row, slug: string, paths: string[]) => Promise<boolean>;
  private devices = new Map<string, DeviceConnection>();
  private listeners = new Map<string, Set<(event: UserEvent) => void>>();
  private pending = new Map<string, Pending>();
  attach(conn: DeviceConnection) {
    const previous = this.devices.get(conn.deviceId);
    if (previous && previous !== conn) {
      this.detach(previous);
      previous.close(4409);
    }
    this.devices.set(conn.deviceId, conn);
    this.publish(conn.userId, { type: "presence", online: true, device_id: conn.deviceId, device_online: true });
  }
  detach(conn: DeviceConnection) {
    if (this.devices.get(conn.deviceId) !== conn) return false;
    this.devices.delete(conn.deviceId);
    for (const [id, p] of this.pending)
      if (p.deviceId === conn.deviceId) {
        clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(new HttpError(503, "电脑已离线，资料库不可用"));
      }
    this.publish(conn.userId, { type: "presence", online: this.online(conn.userId), device_id: conn.deviceId, device_online: false });
    return true;
  }
  device(userId: string, deviceId?: string | null) {
    const conn = deviceId ? this.devices.get(deviceId) : undefined;
    return conn?.userId === userId ? conn : undefined;
  }
  online(userId: string) {
    return [...this.devices.values()].some(conn => conn.userId === userId);
  }
  capableUsers(feature: string) {
    return [...this.devices.values()].filter(conn => conn.capabilities?.includes(feature)).map(conn => conn.userId);
  }
  capableDevices(feature: string) {
    return [...this.devices.values()].filter(conn => conn.capabilities?.includes(feature)).map(conn => conn.deviceId);
  }
  count() { return this.devices.size; }
  kick(deviceId: string) {
    const conn = this.devices.get(deviceId);
    if (conn) { this.detach(conn); conn.close(4401); }
  }
  rpc(userId: string, method: string, params: Row, timeoutMs: number, deviceId?: string | null) {
    const conn = this.device(userId, deviceId);
    if (!conn)
      return Promise.reject(new HttpError(503, "电脑离线，资料库不可用"));
    const id = randomUUID();
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new HttpError(504, "电脑响应超时，请稍后重试"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, deviceId: conn.deviceId });
      conn.send({ type: "rpc", id, method, params });
    });
  }
  resolveRpc(deviceId: string, message: Row) {
    const p = this.pending.get(message.id);
    if (!p || p.deviceId !== deviceId) return;
    clearTimeout(p.timer);
    this.pending.delete(message.id);
    if (message.ok) p.resolve(message.result);
    else
      p.reject(
        Object.assign(new HttpError(
          400,
          typeof message.error === "string"
            ? message.error.slice(0, 300)
            : "电脑无法完成请求",
        ), {info:errorInfo(message) ?? new HttpError(400,"电脑无法完成请求").info}),
      );
  }
  subscribe(userId: string, listener: (event: UserEvent) => void) {
    let set = this.listeners.get(userId);
    if (!set) this.listeners.set(userId, (set = new Set()));
    set.add(listener);
    return () => {
      set!.delete(listener);
      if (!set!.size) this.listeners.delete(userId);
    };
  }
  publish(userId: string, event: UserEvent) {
    for (const listener of this.listeners.get(userId) ?? []) {
      try {
        listener(event);
      } catch {
        /* one broken socket must not stop fan-out */
      }
    }
    for (const conn of this.devices.values()) if (conn.userId === userId) conn.send({ type: "event", event });
  }
}
