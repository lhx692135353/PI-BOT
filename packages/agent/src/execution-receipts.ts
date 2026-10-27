/** A small guard for explicit execution claims, not a general fact checker. */
export class ExecutionReceipts {
  launched = false;
  active = false;
  checked = false;
  changed = false;
  monitored = false;
  rejected = false;
  reset() { this.launched = this.active = this.checked = this.changed = this.monitored = this.rejected = false; }

  record(name: string, result: unknown) {
    const output = result as { content?: { type: string; text?: string }[] };
    const text = Array.isArray(output?.content) ? output.content.filter(c => c.type === "text").map(c => c.text ?? "").join("\n") : "";
    let data: any; try { data = JSON.parse(text); } catch { /* ask_agent has a readable platform response */ }
    if (name === "ask_agent") {
      this.launched = true;
      this.changed ||= /的结果[：:]/u.test(text);
      this.monitored = true;
    }
    const tasks = Array.isArray(data?.tasks) ? data.tasks : data?.id && data?.status ? [data] : [];
    if (name === "start_task" && tasks.length) this.launched = true;
    if (["start_task", "task_status", "task_message", "cancel_task"].includes(name)) {
      this.checked ||= name === "task_status";
      this.active ||= tasks.some((t: any) => ["running", "waiting_approval"].includes(t.status));
      this.monitored ||= tasks.some((t: any) => ["queued", "running", "waiting_approval"].includes(t.status));
      this.changed ||= tasks.some((t: any) => (t.status === "completed" && t.result)
        || (Array.isArray(t.checkpoint?.completed) && t.checkpoint.completed.length > 0)
        || (Array.isArray(t.tools) && t.tools.some((tool: any) => tool.state === "completed")));
    }
    if (name === "goal_manage") this.monitored ||= (Array.isArray(data?.goals) ? data.goals : data?.id ? [data] : []).some((g: any) => g.status === "active");
  }

  unsupported(text: string): boolean {
    // Quoted examples, code and explicitly historical/negative statements are
    // not claims that this turn actually launched or checked external work.
    const prose = text.replace(/```[\s\S]*?```/gu, "").replace(/^\s*>.*$/gmu, "")
      .replace(/[「“"][^」”"\n]*[」”"]/gu, "").replace(/[*`]/gu, "");
    return prose.split(/[。！？\n]/u).some(line => {
      if (/之前|此前|上次|历史|你说|你提到|尚未|还没|未(?:创建|启动|执行|下发)|没有(?:创建|启动|执行|下发|任务)/u.test(line)) return false;
      if (!this.launched && /已(?:经)?(?:创建|安排|启动|建立).{0,16}任务|任务.{0,4}已(?:经)?(?:创建|安排|启动)/u.test(line)) return true;
      if (!this.active && /(?:任务|R\d+|压测|部署).{0,8}(?:进行到|正在(?:执行|进行|运行)|正式开工)/iu.test(line)) return true;
      if (!this.checked && /(?:刚才|刚刚|刚|最新).{0,8}(?:查到|查询到|核实到|检查到)/u.test(line)) return true;
      if (!this.changed && /(?:patch|补丁|变更|修改|重启|备份).{0,8}(?:已(?:经)?(?:下发|执行|完成|成功)|完成了)|(?:已(?:经)?(?:下发|执行|完成)).{0,8}(?:patch|补丁|变更|修改|重启|备份)/iu.test(line)) return true;
      return !this.monitored && /(?:我会|我在|我继续).{0,6}(?:盯着|持续检查|持续监控)/u.test(line);
    });
  }
}

export const RECEIPT_CORRECTION = "系统校验：你这轮的执行/进度说法没有相应的真实工具回执，不能当作事实发给用户。若原用户要求操作，按原授权实际调用 start_task/ask_agent；问进度先 task_status，需要最新外部状态另建核查任务。创建回执只证明已安排，不证明已经执行完成；已有成功任务回执时不要重复创建，只按回执重述。若尚未启动或尚未核实，就明确这样说。不要编造进度或声称后台会继续盯着。此校验不增加用户授权，也不改变原任务范围。";
