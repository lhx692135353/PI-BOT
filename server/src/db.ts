import { Pool, types, type PoolClient } from "pg";
types.setTypeParser(20, (value) => Number(value));
export type Row = Record<string, any>;
export class HttpError extends Error {
  constructor(
    public status: number,
    public detail: unknown,
  ) {
    super(typeof detail === "string" ? detail : "请求失败");
  }
}
export const fail = (status: number, detail: unknown): never => {
  throw new HttpError(status, detail);
};
const keys: Record<string, string> = {
  remote_environments: "environment_id",
  remote_artifacts: "artifact_id",
  users: "user_id",
  devices: "device_id",
  models: "model_id",
  bots: "bot_id",
  bot_runs: "run_id",
  bot_messages: "message_id",
  bot_memories: "bot_id",
  approvals: "approval_id",
  agent_tasks: "task_id",
  bot_skills: "skill_id",
  bot_automations: "automation_id",
  bot_goals: "goal_id",
  automation_rounds: "round_id",
  automation_reports: "report_id",
};
export const CHANNEL = "pibot_changes";
export interface Change {
  user_id: string;
  bot_id?: string;
  message_id?: string;
  content?: string;
  presence?: boolean;
}
export class Tx {
  private queue: Promise<unknown> = Promise.resolve();
  constructor(readonly client: PoolClient) {}
  async rows(sql: string, args: unknown[] = []): Promise<Row[]> {
    const result = this.queue.then(
      async () => (await this.client.query(sql, args)).rows as Row[],
    );
    this.queue = result.catch(() => {});
    return result;
  }
  async one(sql: string, args: unknown[] = []): Promise<Row | undefined> {
    return (await this.rows(sql, args))[0];
  }
  async get(table: string, id: string, required = false): Promise<Row> {
    const r = await this.one(`SELECT * FROM ${table} WHERE ${keys[table]}=$1`, [
      id,
    ]);
    if (!r && required) fail(404, "记录不存在");
    return r as Row;
  }
  async insert(table: string, data: Row): Promise<Row> {
    const values = Object.entries(data).filter(([, v]) => v !== undefined);
    return (await this.one(
      `INSERT INTO ${table} (${values.map(([k]) => k).join(",")}) VALUES (${values.map((_, i) => `$${i + 1}`).join(",")}) RETURNING *`,
      values.map(([, v]) => encode(v)),
    ))!;
  }
  async update(table: string, id: string, data: Row): Promise<Row> {
    const entries = Object.entries(data).filter(([, v]) => v !== undefined);
    const row = await this.one(
      `UPDATE ${table} SET ${entries.map(([k], i) => `${k}=$${i + 2}`).join(",")} WHERE ${keys[table]}=$1 RETURNING *`,
      [id, ...entries.map(([, v]) => encode(v))],
    );
    if (!row) fail(404, "记录不存在");
    return row!;
  }
  /** Large deltas are dropped to a plain change; clients refetch the tail. */
  async notify(change: Change) {
    let payload = JSON.stringify(change);
    if (payload.length > 7000)
      payload = JSON.stringify({ ...change, content: undefined });
    await this.rows("SELECT pg_notify($1,$2)", [CHANNEL, payload]);
  }
}
function encode(v: unknown) {
  return v !== null &&
    typeof v === "object" &&
    !(v instanceof Date) &&
    !Buffer.isBuffer(v)
    ? JSON.stringify(v)
    : v;
}
export class Database {
  readonly pool: Pool;
  constructor(url: string) {
    this.pool = new Pool({ connectionString: url });
  }
  async tx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      const result = await fn(new Tx(c));
      await c.query("COMMIT");
      return result;
    } catch (e) {
      await c.query("ROLLBACK").catch(() => {});
      throw e;
    } finally {
      c.release();
    }
  }
  close() {
    return this.pool.end();
  }
}
