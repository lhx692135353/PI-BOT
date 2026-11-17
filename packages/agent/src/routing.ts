import { Type } from "typebox";
export const routingParameters = {
  resource_key:Type.Optional(Type.String({minLength:1,maxLength:2000,description:"经验账本中已观察到的精确资源路径；冲突或多端命中需先询问。"})),
  decision_reason:Type.Optional(Type.String({minLength:1,maxLength:500,description:"本轮选择此执行端的理由，向用户用一句话说明。"})),
  execution: Type.Optional(Type.Union(["auto","device","cloud","remote"].map(x => Type.Literal(x)))),
  device_id: Type.Optional(Type.String({format:"uuid"})),
  requirements: Type.Optional(Type.Array(Type.Union(["files","shell","browser","desktop","phone"].map(x => Type.Literal(x))),{maxItems:10})),
  resources: Type.Optional(Type.Array(Type.Object({target:Type.String({pattern:"^(device|remote):[0-9a-f-]{36}$"}),path:Type.Optional(Type.String({minLength:1,maxLength:2000}))}),{maxItems:20})),
};
export const routingDescription = "由 AI 按本轮明确意图 > 经验账本唯一资源 > 纯文字/搜索 cloud > 询问选择目标，并用一句话向用户说明设备及理由，可由用户覆盖。明确用户电脑用 execution=device 和 device_id；云端机器用 remote。auto 无资源、无机器能力需求仅用 cloud，需机器而无目标会报澄清错误。使用 resource_key 查询账本中真实观察到的精确路径，不臆造路径或把工具存在当成权限。手机是云端入口，不指任何历史电脑。离线立即报告并提供由用户选择的替代方案，不排队、不静默换机。requirements 声明所需能力；已有文件或设备用 resources 携带真实来源 target；path 只填本智能体资料库内已存在的路径。资料库外项目保留 target、不要填 path，启动任务后用 request_outside_access 申请具体路径权限，获批后再读取。不要将资源检查失败说成电脑离线，不把同名路径当成同一资源。不要继承智能体或上次任务的机器。";
