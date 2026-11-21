import type {Row,Database} from './db.js';
import {messageOut} from './bots.js';
/** Persisted full reset frames use offset 0 (UTF-16 code units). No text in NOTIFY.
 * A full snapshot heals gaps/reconnects; seq is per-message and monotonic in PG. */
export function streamFrame(m:Row) {
 if(m.visibility!=="public" || m.role!=="assistant")return null;
 return {type:"stream" as const,bot_id:m.bot_id,message_id:m.message_id,run_id:m.run_id,
   stream_id:m.message_id,seq:Number(m.stream_seq ?? 0),offset:0,reset:true,
   text:m.content,status:m.status,message:messageOut(m)};
}
export async function publicStreams(db:Database,userId:string,botId?:string,messageId?:string,running=false) {
 return db.tx(async tx => {
  const rows=await tx.rows(`SELECT m.* FROM bot_messages m JOIN bots b ON b.bot_id=m.bot_id
    WHERE b.user_id=$1 AND m.visibility='public' AND m.role='assistant'
    AND ($2::uuid IS NULL OR m.bot_id=$2) AND ($3::uuid IS NULL OR m.message_id=$3)
    AND (NOT $4::boolean OR m.status='running')
    AND ($3::uuid IS NOT NULL OR m.status='running' OR m.seq=(SELECT max(x.seq) FROM bot_messages x WHERE x.bot_id=m.bot_id AND x.visibility='public' AND x.role='assistant')) ORDER BY m.seq`,[userId,botId ?? null,messageId ?? null,running]);
  return rows.map(streamFrame).filter((f):f is NonNullable<typeof f>=>!!f);
 });
}
