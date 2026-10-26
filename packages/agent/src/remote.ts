import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
/** The API checks this token against the run and its fixed machine; no SSH secrets reach the agent. */
export function remoteTools(
  base: string,
  token: () => string,
  runId: string,
): ToolDefinition[] {
  const str = () => Type.String({ maxLength: 2000 }),
    opt = (t: any) => Type.Optional(t);
  const definitions: [string, string, any][] = [
    ["list_files", "列出云端资料库目录", Type.Object({ path: opt(str()) })],
    [
      "read_file",
      "读取云端 UTF-8 文件",
      Type.Object({
        path: str(),
        offset: opt(Type.Integer({ minimum: 1 })),
        limit: opt(Type.Integer({ minimum: 1, maximum: 5000 })),
      }),
    ],
    [
      "write_file",
      "创建或覆盖云端文件，生成结果请存放在 outputs 目录",
      Type.Object({
        path: str(),
        content: Type.String({ maxLength: 2000000 }),
      }),
    ],
    [
      "edit_file",
      "精确替换云端文件中的唯一原文",
      Type.Object({
        path: str(),
        old_text: Type.String({ minLength: 1 }),
        new_text: Type.String(),
        replace_all: opt(Type.Boolean()),
      }),
    ],
    [
      "run_command",
      "在本任务固定的云端 Linux 虚机执行 bash 命令，无法操作用户电脑；取消或断线后的未知结果必须先核实",
      Type.Object({
        command: Type.String({ minLength: 1, maxLength: 20000 }),
        cwd: opt(str()),
        timeout_seconds: opt(Type.Integer({ minimum: 1, maximum: 600 })),
      }),
    ],
    [
      "browser",
      "操作云端浏览器；用 read 获取页面内容和可访问性快照，用 role+name 或 CSS selector 定位，支持打开、点击、填写、按键、截图及文件传输。接管结束后先 read 或 screenshot 再操作",
      Type.Object({
        op: Type.Union(
          [
            "open",
            "read",
            "tabs",
            "click",
            "fill",
            "key",
            "upload",
            "download",
            "screenshot",
            "close",
          ].map((x) => Type.Literal(x)),
        ),
        url: opt(str()),
        selector: opt(str()),
        role: opt(str()),
        name: opt(str()),
        text: opt(Type.String({ maxLength: 20000 })),
        key: opt(str()),
        path: opt(str()),
        tab: opt(Type.Integer({ minimum: 0, maximum: 30 })),
      }),
    ],
    [
      "desktop_screenshot",
      "查看云端桌面截图；返回的图片对应当前虚机，不是用户电脑",
      Type.Object({}),
    ],
    [
      "desktop_input",
      "操作云端桌面的鼠标或键盘，先截图确认位置；人工接管期间不可操作",
      Type.Object({
        type: Type.Union(
          ["click", "move", "drag", "key", "text", "scroll"].map((x) =>
            Type.Literal(x),
          ),
        ),
        x: opt(Type.Integer({ minimum: 0 })),
        y: opt(Type.Integer({ minimum: 0 })),
        x2: opt(Type.Integer({ minimum: 0 })),
        y2: opt(Type.Integer({ minimum: 0 })),
        button: opt(Type.Integer({ minimum: 1, maximum: 3 })),
        key: opt(str()),
        text: opt(Type.String({ maxLength: 20000 })),
        direction: opt(Type.Union([Type.Literal("up"), Type.Literal("down")])),
        steps: opt(Type.Integer({ minimum: 1, maximum: 30 })),
      }),
    ],
    [
      "artifact",
      "登记已生成的云端文件并取得用户可查看的结果链接，不会把文件复制到其他机器",
      Type.Object({ path: str() }),
    ],
    [
      "request_outside_access",
      "申请本次任务访问资料库之外的具体绝对路径；等待用户批准后才可访问",
      Type.Object({
        path: str(),
        reason: Type.String({ minLength: 1, maxLength: 1000 }),
      }),
    ],
  ];
  return definitions.map(
    ([name, description, parameters]) =>
      ({
        name,
        label: description.split("；")[0].slice(0, 30),
        description,
        parameters,
        execute: async (id: string, args: any, signal?: AbortSignal) => {
          const r = await fetch(
            base.replace(/\/+$/, "") + "/agent/remote/action",
            {
              method: "POST",
              headers: {
                Authorization: "Bearer " + token(),
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                run_id: runId,
                call_id: id,
                action: name,
                args,
              }),
              signal: signal
                ? AbortSignal.any([signal, AbortSignal.timeout(1000000)])
                : AbortSignal.timeout(1000000),
              redirect: "error",
            },
          );
          const data = await r.json();
          if (!r.ok)
            throw new Error(
              typeof data.detail === "string" ? data.detail : "云端操作失败",
            );
          const { image, ...summary } = data;
          const content: any[] = [
            { type: "text", text: JSON.stringify(summary) },
          ];
          if (image)
            content.push({
              type: "image",
              mimeType: image.mime,
              data: image.data,
            });
          return { content, details: {} };
        },
      }) as ToolDefinition,
  );
}
