import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { CHANNEL, type Database, type Row } from "./db.js";
import type { Settings } from "./config.js";
import { user, device } from "./security.js";
import type { DeviceConnection, Hub } from "./hub.js";
import { failDeviceRuns, handleRunEvent } from "./runs.js";
import type { AgentDispatcher } from "./agents.js";
import type { VoiceHub } from "./voice.js";

const send = (ws: WebSocket, value: Row) => {
  if (ws.readyState !== 1) return;
  if (ws.bufferedAmount > 4_000_000) ws.close(4400);
  else ws.send(JSON.stringify(value));
};

/**
 * `/ws/device`: the computer harness (signed handshake) receives runs, cancels,
 * approval decisions and file RPCs. `/ws/events`: phones and the desktop UI get
 * change notifications for the signed-in user.
 */
export async function sockets(
  app: FastifyInstance,
  db: Database,
  s: Settings,
  hub: Hub,
  dispatcher?: AgentDispatcher,
  voice?: VoiceHub,
) {
  // Serialize reconnect and disconnect cleanup for each identity. A replacement
  // must not receive work until interrupted runs from its old socket are closed.
  const lifecycles = new Map<string, Promise<void>>();
  const lifecycle = (id: string, action: () => Promise<void>) => {
    const next = (lifecycles.get(id) ?? Promise.resolve()).catch(() => {}).then(action);
    lifecycles.set(id, next);
    void next.finally(() => {
      if (lifecycles.get(id) === next) lifecycles.delete(id);
    }).catch(() => {});
    return next;
  };
  const listener = await db.pool.connect();
  await listener.query(`LISTEN ${CHANNEL}`);
  listener.on("notification", (n) => {
    try {
      const c = JSON.parse(n.payload ?? "{}") as Row;
      if (typeof c.user_id !== "string") return;
      if (c.message_id && typeof c.content === "string")
        hub.publish(c.user_id, { type: "delta", bot_id: c.bot_id, message_id: c.message_id, content: c.content });
      else {
        dispatcher?.kick();
        if (c.bot_id) hub.publish(c.user_id, { type: "bot", bot_id: c.bot_id });
        else hub.publish(c.user_id, { type: "bots" });
      }
    } catch {
      /* malformed payloads are ignored */
    }
  });
  listener.on("error", () => {});
  dispatcher?.start();
  app.addHook("onClose", async () => {
    await dispatcher?.stop();
    await listener.query("UNLISTEN *").catch(() => {});
    listener.release();
    await db.close();
  });

  app.get("/ws/device", { websocket: true }, (ws, req) => {
    let conn: DeviceConnection | undefined;
    let seen = 0;
    let lastMessageAt = Date.now();
    // A sleeping computer can retain a TCP connection without being able to execute.
    const heartbeat = setInterval(() => {
      if (conn && Date.now() - lastMessageAt > 60000) ws.terminate();
    }, 15000);
    let queue = Promise.resolve();
    const ready = db
      .tx((tx) => device(tx, req.headers, "GET", "/ws/device", Buffer.alloc(0), s))
      .then(({ device: d, user: u }) => lifecycle(d.device_id, async () => {
        if (ws.readyState !== 1) return;
        const previous = hub.device(u.user_id, d.device_id);
        if (previous) {
          hub.detach(previous);
          previous.close(4409);
        }
        // Cleanup may still be pending even after the previous socket detached.
        await failDeviceRuns(db, d.device_id);
        await db.tx(async tx => {
          // Hold the device row until attachment finishes: revoke's post-commit
          // kick must see this socket even if the signed handshake began earlier.
          const active = await tx.one('UPDATE devices SET last_seen_at=now() WHERE device_id=$1 AND revoked_at IS NULL RETURNING device_id', [d.device_id]);
          if (!active) { ws.close(4401); return; }
          if (ws.readyState !== 1) return;
          conn = {
            deviceId: d.device_id,
            userId: u.user_id,
            send: (m) => send(ws, m),
            close: (code) => ws.close(code),
          };
          hub.attach(conn);
          send(ws, { type: "hello", user_id: u.user_id, device_id: d.device_id });
        });
      }))
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      queue = queue
        .then(async () => {
          await ready;
          if (!conn || hub.device(conn.userId, conn.deviceId) !== conn) return;
          let m: Row;
          try {
            m = JSON.parse(raw.toString());
          } catch {
            return;
          }
          lastMessageAt = Date.now();
          if (m.type === "capabilities") {
            conn.capabilities = Array.isArray(m.features) ? m.features.filter((x: unknown) => x === "always-on-v1") : [];
            dispatcher?.kick();
          } else if (m.type === "ping") {
            send(ws, { type: "pong" });
            if (Date.now() - seen > 30000) {
              seen = Date.now();
              const revoked = await db.tx(async (tx) => {
                const d = await tx.get("devices", conn!.deviceId);
                if (!d || d.revoked_at) return true;
                await tx.rows("UPDATE devices SET last_seen_at=now() WHERE device_id=$1", [conn!.deviceId]);
                return false;
              });
              if (revoked) ws.close(4401);
            }
          } else if (m.type === "run_event") await handleRunEvent(db, s, hub, conn, m);
          else if (m.type === "rpc_result") hub.resolveRpc(conn.deviceId, m);
        })
        .catch(() => {});
    });
    ws.on("close", () => {
      clearInterval(heartbeat);
      void ready.then(() => {
        if (!conn) return;
        const disconnected = conn;
        return lifecycle(disconnected.deviceId, async () => {
          const current = hub.detach(disconnected);
          if (current || !hub.device(disconnected.userId, disconnected.deviceId))
            await failDeviceRuns(db, disconnected.deviceId);
        });
      }).catch(() => {});
    });
  });

  app.get("/ws/voice", { websocket: true }, (ws, req) => {
    if (!voice) return ws.close(1011);
    void voice.attach(ws, req).catch((error) => {
      send(ws, { type: "error", detail: error instanceof Error ? error.message : "语音通话没有接通" });
      try { ws.close(1011); } catch { /* already closed */ }
    });
  });

  app.get("/ws/events", { websocket: true }, (ws, req) => {
    let unsubscribe: (() => void) | undefined;
    const token = new URL(req.url, "http://x").searchParams.get("token");
    const headers = token ? { authorization: `Bearer ${token}` } : req.headers;
    db.tx((tx) => user(tx, headers, s))
      .then((u) => {
        if (ws.readyState !== 1) return;
        unsubscribe = hub.subscribe(u.user_id, (event) => send(ws, { type: "event", event }));
        send(ws, { type: "hello", user_id: u.user_id, device_online: hub.online(u.user_id) });
      })
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      if (raw.toString().includes('"ping"')) send(ws, { type: "pong" });
    });
    ws.on("close", () => unsubscribe?.());
  });
}
