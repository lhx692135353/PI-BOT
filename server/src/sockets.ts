import {publicStreams} from "./streams.js";
import { CAPABILITIES } from "./targets.js";
import type { FastifyInstance } from "fastify";
import type { WebSocket } from "ws";
import { CHANNEL, type Database, type Row } from "./db.js";
import type { Settings } from "./config.js";
import { user, device } from "./security.js";
import type { DeviceConnection, Hub } from "./hub.js";
import { DEVICE_CONNECTION_REPLACED, failDeviceRuns, handleRunEvent } from "./runs.js";
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
  const pending=new Map<string,{event:Row,dirty:boolean}>();
  const publishStream=(c:Row)=>{
    if(!hub.hasSubscribers(c.user_id))return;
    const key=`${c.user_id}:${c.bot_id}:${c.message_id ?? "latest"}`;
    const existing=pending.get(key);if(existing){existing.dirty=true;return;}
    const job={event:c,dirty:false};pending.set(key,job);
    void (async()=>{do {
      job.dirty=false;
      const frames=await publicStreams(db,c.user_id,c.bot_id,c.message_id,false);
      for(const frame of frames){hub.publish(c.user_id,frame);hub.publish(c.user_id,{type:"delta",bot_id:frame.bot_id,message_id:frame.message_id,content:frame.text});}
      if(!job.dirty){pending.delete(key);return;}
    }while(true);})().catch(error=>{pending.delete(key);app.log.error({err:error},"stream snapshot publication failed");});
  };
  listener.on("notification", (n) => {
    try {
      const c = JSON.parse(n.payload ?? "{}") as Row;
      if (typeof c.user_id !== "string") return;
      if(c.stream || c.message_id || c.bot_id) publishStream(c);
      if (!c.stream) {
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
    let validation: Promise<void> | undefined;
    const currentConnection = () => conn && ws.readyState === 1 &&
      !lifecycles.has(conn.deviceId) && hub.device(conn.userId, conn.deviceId) === conn ? conn : undefined;
    // Heartbeat validation has its own bounded lane, not the slow run-event queue.
    const validateHeartbeat = () => {
      const current = currentConnection();
      if (!current || validation || Date.now() - seen <= 30000) return;
      seen = Date.now();
      validation = db.tx(tx => tx.one(
        'UPDATE devices SET last_seen_at=now() WHERE device_id=$1 AND key_version=$2 AND revoked_at IS NULL RETURNING device_id',
        [current.deviceId, current.keyVersion],
      )).then(active => {
        if (!active && currentConnection() === current) hub.kick(current.deviceId);
      }).catch(() => {
        if (currentConnection() === current) ws.close(4401);
      }).finally(() => { validation = undefined; });
    };
    // A sleeping computer can retain a TCP connection without being able to execute.
    const heartbeat = setInterval(() => {
      if (!currentConnection()) return;
      if (Date.now() - lastMessageAt > 60000) ws.terminate();
      else validateHeartbeat();
    }, 15000);
    let connectionKeyVersion = -1;
    let queue = Promise.resolve();
    const ready = db
      .tx((tx) => device(tx, req.headers, "GET", "/ws/device", Buffer.alloc(0), s))
      .then(({ device: d, user: u }) => lifecycle(d.device_id, async () => {
        if (ws.readyState !== 1) return;
        await db.tx(async tx => {
          // Hold the device row until attachment finishes: revoke's post-commit
          // kick must see this socket even if the signed handshake began earlier.
          const active = await tx.one('UPDATE devices SET last_seen_at=now() WHERE device_id=$1 AND revoked_at IS NULL AND key_version=$2 RETURNING device_id', [d.device_id,d.key_version]);
          if (!active) { ws.close(4401); return; }
          if (ws.readyState !== 1) return;
          const previous = hub.device(u.user_id, d.device_id);
          if (previous) {
            hub.detach(previous);
            previous.close(4409);
          }
          // Cleanup may still be pending even after the previous socket detached.
          await failDeviceRuns(db, d.device_id, DEVICE_CONNECTION_REPLACED);
          if (ws.readyState !== 1) return;
          connectionKeyVersion = d.key_version;
          conn = {
            deviceId: d.device_id,
            keyVersion:d.key_version,
            userId: u.user_id,
            send: (m) => send(ws, m),
            close: (code) => ws.close(code),
          };
          lastMessageAt = Date.now();
          hub.attach(conn);
          send(ws, { type: "hello", user_id: u.user_id, device_id: d.device_id });
        });
      }))
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      let m: Row;
      try {
        m = JSON.parse(raw.toString());
        if (!m || typeof m !== "object" || Array.isArray(m)) return;
      } catch {
        return;
      }
      if (m.type === "ping") {
        // Never acknowledge an unauthenticated, detached or replacing socket.
        // ready includes signed authentication AND serialized attachment cleanup.
        void ready.then(() => {
          if (!currentConnection()) return;
          lastMessageAt = Date.now();
          send(ws, { type: "pong" });
          validateHeartbeat();
        }).catch(() => {});
        return;
      }
      queue = queue
        .then(async () => {
          await ready;
          const current = currentConnection();
          if (!current) return;
          const active = await db.tx(tx => tx.one('SELECT 1 FROM devices WHERE device_id=$1 AND key_version=$2 AND revoked_at IS NULL',[current.deviceId, connectionKeyVersion]));
          if (currentConnection() !== current) return;
          if (!active) { hub.kick(current.deviceId); return; }
          lastMessageAt = Date.now();
          if (m.type === "capabilities") {
            current.capabilities = Array.isArray(m.features) ? m.features.filter((x: unknown) => typeof x === "string" && CAPABILITIES.includes(x as typeof CAPABILITIES[number])) : [];
            await db.tx(tx => tx.rows("UPDATE bot_automations SET next_wake_at=now() WHERE user_id=$1 AND status='waiting_device'",[current.userId]));
            dispatcher?.kick();
          } else if (m.type === "run_event") await handleRunEvent(db, s, hub, current, m);
          else if (m.type === "rpc_result") await db.tx(async tx => {
            const active = await tx.one('SELECT 1 FROM devices WHERE device_id=$1 AND key_version=$2 AND revoked_at IS NULL FOR SHARE',[current.deviceId,connectionKeyVersion]);
            if (active && currentConnection() === current) hub.resolveRpc(current.deviceId,m);
          });
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
        void publicStreams(db,u.user_id,undefined,undefined,true).then(frames=>{
          for(const event of frames){send(ws,{type:"event",event});send(ws,{type:"event",event:{type:"delta",bot_id:event.bot_id,message_id:event.message_id,content:event.text}});}
        }).catch(()=>{});
      })
      .catch(() => ws.close(4401));
    ws.on("message", (raw) => {
      if (raw.toString().includes('"ping"')) send(ws, { type: "pong" });
    });
    ws.on("close", () => unsubscribe?.());
  });
}
