import { Type } from "typebox";
export const routingParameters = {
  execution: Type.Optional(Type.Union(["auto","device","cloud","remote"].map(x => Type.Literal(x)))),
  device_id: Type.Optional(Type.String({format:"uuid"})),
  requirements: Type.Optional(Type.Array(Type.Union(["files","shell","browser","desktop","phone"].map(x => Type.Literal(x))),{maxItems:10})),
  resources: Type.Optional(Type.Array(Type.Object({target:Type.String({pattern:"^(device|remote):[0-9a-f-]{36}$"}),path:Type.Optional(Type.String({minLength:1,maxLength:2000}))}),{maxItems:20})),
};
export const routingDescription = "每个新任务默认 execution=auto，由云端按来源电脑、其他可用电脑、云端选择；纯文字和搜索用 cloud。只有用户明确指定电脑时才填 device_id，明确指定云端机器时用 remote。requirements 声明所需能力；已有文件或设备用 resources 携带真实来源 target；path 只填本智能体资料库内已存在的路径。资料库外项目保留 target、不要填 path，启动任务后用 request_outside_access 申请具体路径权限，获批后再读取。不要将资源检查失败说成电脑离线，不把同名路径当成同一资源。不要继承智能体或上次任务的机器。";
