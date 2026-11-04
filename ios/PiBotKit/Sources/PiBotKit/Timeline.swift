import Foundation

/// One bot's loaded timeline: messages in `seq` order, plus whether older pages exist.
public struct Timeline: Hashable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool
    public var loaded: Bool

    public init(messages: [Message] = [], hasMore: Bool = false, loaded: Bool = false) {
        self.messages = messages; self.hasMore = hasMore; self.loaded = loaded
    }

    /// Union by id (newer copies win), ordered by seq.
    public func merge(_ incoming: [Message], hasMore: Bool? = nil) -> Timeline {
        var order: [String] = []
        var byId: [String: Message] = [:]
        for m in messages + incoming {
            if byId[m.id] == nil { order.append(m.id) }
            byId[m.id] = m
        }
        let merged = order.compactMap { byId[$0] }.enumerated().sorted { a, b in
            a.element.seq != b.element.seq ? a.element.seq < b.element.seq : a.offset < b.offset
        }.map(\.element)
        return Timeline(messages: merged, hasMore: hasMore ?? self.hasMore, loaded: true)
    }

    /// Streaming text for a running reply; ignored once the message has finished.
    public func applyDelta(messageId: String, content: String) -> Timeline {
        guard let i = messages.firstIndex(where: { $0.id == messageId }), messages[i].status == "running" else { return self }
        var copy = self
        copy.messages[i].content = content
        return copy
    }

    public var oldestSeq: Int? { messages.first?.seq }

    /// Tool the bot is running right now, for the character's mood.
    public var runningTool: String? {
        messages.last { $0.status == "running" }?.tools.last { $0.state == "running" }?.name
    }
}

private let isoFractional: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()
private let isoPlain: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

public func parseDate(_ iso: String?) -> Date? {
    guard let iso, !iso.isEmpty else { return nil }
    return isoFractional.date(from: iso) ?? isoPlain.date(from: iso)
}

public func epochMillis(_ iso: String?) -> Int64? {
    parseDate(iso).map { Int64(($0.timeIntervalSince1970 * 1000).rounded()) }
}

extension Bot {
    public func mood(now: Int64 = nowMillis(), tool: String? = nil) -> String {
        moodFor(
            status: activity?.status ?? latestRun?.status,
            tool: activity?.tool ?? tool,
            finishedAt: epochMillis(latestRun?.finishedAt),
            lastActiveAt: epochMillis(lastActiveAt),
            now: now
        )
    }

    /// One-line status under a bot's name in lists.
    public func statusLine(now: Int64 = nowMillis()) -> String {
        if let summary = activity?.summary { return summary }
        if !pendingApprovals.isEmpty { return "等你批准…" }
        switch latestRun?.status {
        case "queued": return "排队中…"
        case "running": return latestRun?.executor == "cloud" ? "在云端思考…" : "工作中…"
        case "waiting_approval": return "等你批准…"
        case "failed": if lastMessage?.status == "failed" { return "出错了" }
        default: break
        }
        if mood(now: now) == "sleeping" {
            return "睡着了 · " + (epochMillis(lastActiveAt).flatMap { sleepLabel($0, now: now) } ?? "")
        }
        let preview = lastMessage.map { plainPreview($0.preview) } ?? ""
        return preview.isEmpty ? "还没有对话，打个招呼吧" : preview
    }

    public var hasActiveWork: Bool {
        latestRun?.active == true || !activeTasks.isEmpty || (activity?.runningCount ?? 0) > 0 || (activity?.queuedCount ?? 0) > 0
    }
}

private let previewPrefix = try! NSRegularExpression(pattern: "^(#{1,6}|[-*+>]|\\d+[.)])\\s+")

/// First meaningful line of a reply without Markdown marks.
public func plainPreview(_ text: String) -> String {
    for raw in text.components(separatedBy: "\n") {
        var line = raw.trimmingCharacters(in: .whitespaces)
        line = previewPrefix.stringByReplacingMatches(in: line, range: NSRange(line.startIndex..., in: line), withTemplate: "")
        line = line.replacingOccurrences(of: "`", with: "").replacingOccurrences(of: "**", with: "").trimmingCharacters(in: .whitespaces)
        if !line.isEmpty && !line.hasPrefix("|") { return line }
    }
    return ""
}

public let toolLabels: [String: String] = [
    "list_files": "查看目录",
    "read_file": "读取文件",
    "search_files": "搜索文件",
    "write_file": "写入文件",
    "edit_file": "修改文件",
    "run_command": "执行命令",
    "request_outside_access": "申请访问",
    "web_search": "联网搜索",
    "ask_agent": "委托智能体",
    "get_ui_catalog": "查看界面组件",
    "show_ui": "展示交互界面",
]

public func toolLabel(_ name: String) -> String { toolLabels[name] ?? (name.isEmpty ? "工具" : name) }

/// Header above a message another bot wrote into this timeline.
public func relayLabel(_ from: FromBot) -> String { from.kind == "report" ? "\(from.name) 的回报" : "来自 \(from.name) 的委托" }

private let delegationStates = ["queued": "排队中", "running": "进行中", "completed": "已完成", "failed": "未完成", "cancelled": "已取消"]

/// Chip under a reply for each bot it handed work to.
public func delegationLabel(_ task: AgentTaskRef) -> String {
    let state = task.mode == "report" && task.status == "running" ? "完成后回报" : (delegationStates[task.status] ?? task.status)
    return "交给了 \(task.botName) · \(state)"
}

public func taskStateLabel(_ status: String) -> String {
    switch status {
    case "queued": return "排队中"
    case "running": return "进行中"
    case "waiting_approval": return "等你批准"
    case "completed": return "已完成"
    case "cancelled": return "已取消"
    default: return "未完成"
    }
}

public func humanSize(_ bytes: Int64) -> String {
    if bytes < 1024 { return "\(bytes) B" }
    if bytes < 1024 * 1024 { return String(format: "%.1f KB", Double(bytes) / 1024) }
    return String(format: "%.1f MB", Double(bytes) / 1024 / 1024)
}
