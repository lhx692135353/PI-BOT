import { randomUUID } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { z } from "zod";
import { MAX_REPORT_BYTES } from "@pi-bot/runtime-contracts";
import { callerRun } from "./agents.js";
import { fail, type Row, type Tx } from "./db.js";
import type { Route } from "./routes.js";

export const artifactOut = (r: Row) => ({
  id: r.artifact_id,
  title: r.title,
  name: r.name,
  mime: r.mime,
  size: r.size,
  created_at: new Date(r.created_at).toISOString(),
  status: "ready" as const,
});
export async function messageAttachments(tx: Tx, ids: string[]) {
  if (!ids.length) return new Map<string, ReturnType<typeof artifactOut>[]>();
  const rows = await tx.rows(
    "SELECT ma.message_id,a.artifact_id,a.title,a.name,a.mime,a.size,a.created_at FROM message_artifacts ma JOIN report_artifacts a USING(artifact_id) WHERE ma.message_id=ANY($1) ORDER BY a.created_at",
    [ids],
  );
  const map = new Map<string, ReturnType<typeof artifactOut>[]>();
  for (const r of rows)
    map.set(r.message_id, [...(map.get(r.message_id) ?? []), artifactOut(r)]);
  return map;
}
export const reportRoutes: Route[] = [
  {
    method: "POST",
    path: "/agent/reports",
    auth: "llm",
    tag: "reports",
    internal: true,
    summary: "保存报告文件，仅返回引用",
    body: z
      .object({
        run_id: z.string().uuid(),
        request_id: z.string().min(1).max(200),
        title: z.string().trim().min(1).max(160),
        summary: z.string().trim().min(1).max(1500),
        content: z.string().min(1).max(MAX_REPORT_BYTES),
      })
      .strict(),
    handler: async ({ tx, user, llm, body }) => {
      const run = await callerRun(tx, user.user_id, llm!, body.run_id);
      if (
        run.lane !== "task" ||
        run.automation_readonly ||
        run.origin === "automation"
      )
        fail(403, "报告只能在已授权的后台任务中生成");
      const previous = await tx.one(
        "SELECT artifact_id,title,name,mime,size,summary,created_at FROM report_artifacts WHERE run_id=$1 AND call_id=$2",
        [run.run_id, body.request_id],
      );
      if (previous)
        return { artifact: artifactOut(previous), summary: previous.summary };
      const bytes = Buffer.from(body.content, "utf8");
      if (bytes.length > MAX_REPORT_BYTES) fail(413, "报告超过 10 MiB，未保存");
      const id = randomUUID();
      const row =
        (await tx.one(
          `INSERT INTO report_artifacts(artifact_id,user_id,bot_id,run_id,call_id,title,name,size,body,summary) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT(run_id,call_id) DO NOTHING RETURNING artifact_id,title,name,mime,size,summary,created_at`,
          [
            id,
            user.user_id,
            run.bot_id,
            run.run_id,
            body.request_id,
            body.title,
            `${id}.md`,
            bytes.length,
            bytes,
            body.summary,
          ],
        )) ??
        (await tx.one(
          "SELECT artifact_id,title,name,mime,size,summary,created_at FROM report_artifacts WHERE run_id=$1 AND call_id=$2",
          [run.run_id, body.request_id],
        ))!;
      await tx.rows(
        "INSERT INTO message_artifacts(message_id,artifact_id) VALUES($1,$2) ON CONFLICT DO NOTHING",
        [run.assistant_message_id, row.artifact_id],
      );
      await tx.rows(
        `INSERT INTO message_artifacts(message_id,artifact_id) SELECT p.assistant_message_id,$2 FROM agent_tasks t JOIN bot_runs p ON p.run_id=t.parent_run_id WHERE t.child_run_id=$1 AND t.mode='wait' ON CONFLICT DO NOTHING`,
        [run.run_id, row.artifact_id],
      );
      await tx.notify({ user_id: user.user_id, bot_id: run.bot_id });
      return { artifact: artifactOut(row), summary: row.summary };
    },
  },
  {
    method: "POST",
    path: "/reports/:id/open",
    auth: "actor",
    tag: "reports",
    summary: "打开报告预览",
    handler: async ({ tx, user, s, params }) => {
      if (
        !(await tx.one(
          "SELECT artifact_id FROM report_artifacts WHERE artifact_id=$1 AND user_id=$2",
          [params.id, user.user_id],
        ))
      )
        fail(404, "报告不存在");
      const token = await new SignJWT({
        typ: "report-read",
        artifact: params.id,
      })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.user_id)
        .setExpirationTime("5m")
        .sign(new TextEncoder().encode(s.jwtSecret));
      return { url: `/reports/view/${params.id}#token=${token}` };
    },
  },
  {
    method: "GET",
    path: "/reports/:id/content",
    auth: "none",
    tag: "reports",
    summary: "读取短期授权报告文件",
    query: z.object({
      ticket: z.string().max(4096),
      download: z.string().optional(),
    }),
    handler: async ({ tx, s, params, query, reply }) => {
      let sub: string | undefined;
      try {
        const { payload } = await jwtVerify(
          query.ticket,
          new TextEncoder().encode(s.jwtSecret),
          { algorithms: ["HS256"] },
        );
        if (payload.typ === "report-read" && payload.artifact === params.id)
          sub = payload.sub;
      } catch {}
      if (!sub) fail(401, "报告访问已过期，请重新打开");
      const r = await tx.one(
        "SELECT title,name,body FROM report_artifacts WHERE artifact_id=$1 AND user_id=$2",
        [params.id, sub],
      );
      if (!r) return fail(404, "报告不存在");
      reply
        .header("cache-control", "no-store")
        .header("referrer-policy", "no-referrer")
        .header("x-report-title", encodeURIComponent(r.title))
        .header("x-report-name", r.name);
      if (query.download)
        reply.header("content-disposition", `attachment; filename="${r.name}"`);
      return reply.type("text/plain; charset=utf-8").send(r.body);
    },
  },
  {
    method: "POST",
    path: "/agent/reports/:id/read",
    auth: "llm",
    tag: "reports",
    internal: true,
    summary: "按需读取报告片段",
    body: z.object({
      run_id: z.string().uuid(),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(4000).default(2000),
    }),
    handler: async ({ tx, user, llm, body, params }) => {
      const run = await callerRun(tx, user.user_id, llm!, body.run_id);
      const r = await tx.one(
        `SELECT a.title,a.body FROM report_artifacts a WHERE a.artifact_id=$1 AND a.user_id=$2 AND (a.bot_id=$3 OR EXISTS(SELECT 1 FROM message_artifacts ma JOIN bot_messages m USING(message_id) WHERE ma.artifact_id=a.artifact_id AND m.bot_id=$3))`,
        [params.id, user.user_id, run.bot_id],
      );
      if (!r) return fail(404, "报告不存在或未共享给本智能体");
      const content = Buffer.from(r.body).toString("utf8");
      return {
        id: params.id,
        title: r.title,
        offset: body.offset,
        text: content.slice(body.offset, body.offset + body.limit),
        has_more: body.offset + body.limit < content.length,
      };
    },
  },
];

/** No model request is made when a person opens a file. Markdown renderer is bundled locally. */
export const reportViewer = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>报告</title><style>body{font:16px/1.7 system-ui;margin:0;background:#faf9f7;color:#292929}header{position:sticky;top:0;background:#faf9f7;padding:16px 24px;border-bottom:1px solid #ddd;display:flex;justify-content:space-between}main{max-width:860px;margin:32px auto;padding:0 24px 80px;overflow-wrap:anywhere}pre{overflow:auto;background:#efeeeb;padding:16px;border-radius:8px}table{border-collapse:collapse;display:block;overflow:auto}td,th{padding:8px 12px;border:1px solid #ddd}a{color:#146c87}</style><header><strong>报告</strong><a id="download">下载 Markdown</a></header><main id="content">正在打开…</main><script type="module" src="./viewer.js"></script></html>`;
