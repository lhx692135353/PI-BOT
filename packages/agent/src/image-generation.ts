import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { imageSourceParameter } from "./image-source.js";

/** Provider credentials and image bytes stay on the API, for both cloud and desktop. */
export function imageGenerationTools(base: string, token: () => string, runId: string, writable: boolean): ToolDefinition[] {
  const call = async (path: string, body: object, signal?: AbortSignal) => {
    const response = await fetch(`${base.replace(/\/+$/, "")}${path}`, {
      method: "POST", redirect: "error",
      headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, run_id: runId }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(195000)]) : AbortSignal.timeout(195000),
    });
    const value = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(typeof value.detail === "string" ? value.detail : "生图服务不可用，请稍后重试");
    const { image, ...metadata } = value;
    const content: ({type: "text"; text: string} | {type: "image"; mimeType: string; data: string})[] = [{ type: "text", text: JSON.stringify(metadata) }];
    if (image) content.push({ type: "image", mimeType: image.mime_type, data: image.data });
    return { content, details: metadata };
  };
  const tools: ToolDefinition[] = [{
    name: "image_models", label: "查询生图模型",
    description: "查询管理员启用的生图模型和默认模型；未配置时返回空列表，不臆造可用模型。",
    parameters: Type.Object({}), execute: (_id, _args, signal) => call("/agent/image-models", {}, signal),
  }, {
    name: "image_read", label: "查看原图",
    description: "读取指定消息图片或图片附件的预览及校正方向后的原图尺寸。先查看再定位；坐标使用左上为原点的 0 到 1 比例坐标。预览经过压缩，标注和裁剪始终操作原图。",
    parameters: Type.Object({ source: imageSourceParameter }), execute: (_id, args: any, signal) => call("/agent/images/read", args, signal),
  }];
  if (writable) tools.push({
    name: "image_generate", label: "生成图片",
    description: "根据用户提示词生成一张图片并保存为本次任务的附件。可先用 image_models 查询，再按用户指定选择模型；省略 model 使用默认模型。可选横纵比 1:1、3:2、2:3。生成后的附件会在聊天中自动显示预览并支持下载；需要定制布局时用 show_ui 的 AuiImage.artifact_id 引用返回的 artifact.id。返回元数据不含图片字节。超时、中断或结果未确认时不要自动再次生图，避免重复计费；说明情况，等待用户明确要求重试。",
    parameters: Type.Object({ prompt: Type.String({ minLength: 1, maxLength: 8000 }),
      model: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
      aspect_ratio: Type.Optional(Type.Union(["1:1", "3:2", "2:3"].map(value => Type.Literal(value)))),
    }),
    execute: (id, args: any, signal) => call("/agent/images/generate", { ...args, request_id: id }, signal),
  });
  if (writable) {
    const fraction = Type.Number({ minimum: 0, maximum: 1 });
    const length = Type.Number({ exclusiveMinimum: 0, maximum: 1 });
    const color = Type.Optional(Type.String({ pattern: "^#[0-9a-fA-F]{6}$" }));
    const stroke = Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.1 }));
    const annotations = Type.Array(Type.Union([
      Type.Object({ type: Type.Literal("point"), x: fraction, y: fraction, radius: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.2 })), color }),
      Type.Object({ type: Type.Literal("text"), x: fraction, y: fraction, text: Type.String({ minLength: 1, maxLength: 200 }), size: Type.Optional(Type.Number({ exclusiveMinimum: 0, maximum: 0.3 })), color }),
      ...["line", "arrow"].map(type => Type.Object({ type: Type.Literal(type), x1: fraction, y1: fraction, x2: fraction, y2: fraction, width: stroke, color })),
      Type.Object({ type: Type.Literal("rectangle"), x: fraction, y: fraction, width: length, height: length, stroke, color }),
      Type.Object({ type: Type.Literal("circle"), x: fraction, y: fraction, radius: Type.Number({ exclusiveMinimum: 0, maximum: 0.5 }), stroke, color }),
    ]), { minItems: 1, maxItems: 100 });
    const definitions = [
      { name: "image_annotate", label: "标注原图", description: "在原图上精确叠加点、文字、箭头、线、矩形或圆，保留底图；教学图表标点优先用本工具。先 image_read 确认位置。坐标为原图比例 0..1，线宽、半径、字号相对短边。文本的 y 为基线。不要臆造坐标。返回新的图片附件，不覆盖原图。", parameters: Type.Object({ source: imageSourceParameter, annotations }) },
      { name: "image_crop", label: "裁剪原图", description: "独立裁剪原图，crop 的 x/y/width/height 是原图比例 0..1，范围必须在原图内。保存新的图片附件，后续可以继续标注或编辑。", parameters: Type.Object({ source: imageSourceParameter, crop: Type.Object({ x: fraction, y: fraction, width: length, height: length }) }) },
      { name: "image_edit", label: "修改图片", description: "用实际原图执行换背景、风格转换等 AI 编辑。先 image_models 核对能力，image_read 查看来源。精确图表标注用 image_annotate。蒙版仅 GPT Image 支持，透明区域表示编辑区域，尺寸须与原图一致。省略 model 使用后台默认模型。失败或结果未确认不得自动重试、换模型或改用文生图。成功返回聊天图片附件。", parameters: Type.Object({ source: imageSourceParameter, prompt: Type.String({ minLength: 1, maxLength: 8000 }), model: Type.Optional(Type.String({ maxLength: 100 })), mask: Type.Optional(imageSourceParameter), aspect_ratio: Type.Optional(Type.Union(["1:1", "3:2", "2:3"].map(value => Type.Literal(value)))) }) },
    ];
    for (const definition of definitions) tools.push({ ...definition,
      execute: (id, args: any, signal) => call(`/agent/images/${definition.name.slice(6)}`, { ...args, request_id: id }, signal),
    });
  }
  return tools;
}
