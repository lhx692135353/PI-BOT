import { Type } from "typebox";

export type ImageSource = { message_id: string; image_id: string } | { artifact_id: string };
export const imageSourceParameter = Type.Union([
  Type.Object({ message_id: Type.String({ format: "uuid" }), image_id: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
  Type.Object({ artifact_id: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
]);
export const imageTaskParameters = {
  expected_output: Type.Optional(Type.Literal("image", { description: "用户要求生成、标注、裁剪或修改并交付图片时必须设置；只有实际输出图片附件才算完成。" })),
  image_refs: Type.Optional(Type.Array(imageSourceParameter, { maxItems: 10, description: "本任务选定的原图引用；委托时显式传递，不能用文件名或描述代替。" })),
};
