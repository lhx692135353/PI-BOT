import Foundation

public struct User: Codable, Hashable, Sendable {
    public var id: String
    public var username: String
    public var displayName: String
    public var role: String

    enum CodingKeys: String, CodingKey { case id, username, displayName = "display_name", role }

    public init(id: String, username: String, displayName: String = "", role: String = "user") {
        self.id = id; self.username = username; self.displayName = displayName; self.role = role
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = try c.decode(String.self, forKey: .username)
        displayName = try c.value(.displayName, "")
        role = try c.value(.role, "user")
    }

    public var shownName: String { displayName.isEmpty ? username : displayName }
}

public struct LoginResponse: Decodable, Sendable {
    public var accessToken: String
    public var expiresIn: Int64
    public var user: User
    enum CodingKeys: String, CodingKey { case accessToken = "access_token", expiresIn = "expires_in", user }
}

public struct Device: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var label: String
    public var platform: String
    public var revokedAt: String?
    public var lastSeenAt: String?
    public var online: Bool

    enum CodingKeys: String, CodingKey { case id, label, platform, revokedAt = "revoked_at", lastSeenAt = "last_seen_at", online }

    public init(id: String, label: String, platform: String = "darwin", revokedAt: String? = nil, lastSeenAt: String? = nil, online: Bool = false) {
        self.id = id; self.label = label; self.platform = platform; self.revokedAt = revokedAt; self.lastSeenAt = lastSeenAt; self.online = online
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        label = try c.decode(String.self, forKey: .label)
        platform = try c.value(.platform, "darwin")
        revokedAt = try c.decodeIfPresent(String.self, forKey: .revokedAt)
        lastSeenAt = try c.decodeIfPresent(String.self, forKey: .lastSeenAt)
        online = try c.value(.online, false)
    }

    public var platformLabel: String {
        switch platform {
        case "linux": return "Linux"
        case "darwin": return "macOS"
        case "win32": return "Windows"
        default: return "未知平台"
        }
    }
}

/// The server-side computer every client uses like one of its own; it holds the cloud library.
public struct CloudComputer: Decodable, Hashable, Sendable {
    public var target: String?
    public var label: String
    public var online: Bool

    enum CodingKeys: String, CodingKey { case target, label, online }
    public init(target: String? = nil, label: String = "云端电脑", online: Bool = true) { self.target = target; self.label = label; self.online = online }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        label = try c.value(.label, "云端电脑")
        online = try c.value(.online, false)
    }
}

public extension Sequence {
    /// One element per id: the newest copy wins, keeping first-seen order.
    func uniqued<ID: Hashable>(by id: (Element) -> ID) -> [Element] {
        var order: [ID] = []
        var latest: [ID: Element] = [:]
        for element in self {
            let key = id(element)
            if latest.updateValue(element, forKey: key) == nil { order.append(key) }
        }
        return order.compactMap { latest[$0] }
    }
}

public extension Sequence where Element: Identifiable {
    func uniqued() -> [Element] { uniqued(by: \.id) }
}

public struct ComputerStatus: Decodable, Hashable, Sendable {
    public var online: Bool
    public var device: Device?

    public init(online: Bool = false, device: Device? = nil) { self.online = online; self.device = device }

    enum CodingKeys: String, CodingKey { case online, device }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        online = try c.value(.online, false)
        device = try c.decodeIfPresent(Device.self, forKey: .device)
    }
}

public struct Me: Decodable, Sendable {
    public var user: User
    public var computer: ComputerStatus
    public var devices: [Device]
    public var cloudComputer: CloudComputer?

    enum CodingKeys: String, CodingKey { case user, computer, devices, cloudComputer = "cloud_computer" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        user = try c.decode(User.self, forKey: .user)
        computer = try c.value(.computer, ComputerStatus())
        devices = try c.value(.devices, [Device]()).uniqued()
        cloudComputer = try c.decodeIfPresent(CloudComputer.self, forKey: .cloudComputer)
    }
}

public struct Model: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var isDefault: Bool

    enum CodingKeys: String, CodingKey { case id, name, isDefault = "is_default" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        isDefault = try c.value(.isDefault, false)
    }
}

public let activeRunStatuses: Set<String> = ["queued", "running", "waiting_approval"]

public struct Run: Decodable, Hashable, Sendable {
    public var id: String
    public var botId: String
    public var status: String
    public var executor: String
    public var error: String?
    public var assistantMessageId: String?
    public var createdAt: String
    public var finishedAt: String?
    public var operationTarget: String?

    enum CodingKeys: String, CodingKey {
        case id, botId = "bot_id", status, executor, error, assistantMessageId = "assistant_message_id"
        case createdAt = "created_at", finishedAt = "finished_at", operationTarget = "operation_target"
    }

    public init(id: String, botId: String, status: String, executor: String, createdAt: String, finishedAt: String? = nil) {
        self.id = id; self.botId = botId; self.status = status; self.executor = executor; self.createdAt = createdAt; self.finishedAt = finishedAt
    }

    public var active: Bool { activeRunStatuses.contains(status) }
}

public struct LastMessage: Decodable, Hashable, Sendable {
    public var role: String
    public var preview: String
    public var status: String
    public var createdAt: String

    enum CodingKeys: String, CodingKey { case role, preview, status, createdAt = "created_at" }
    public init(role: String, preview: String, status: String, createdAt: String) {
        self.role = role; self.preview = preview; self.status = status; self.createdAt = createdAt
    }
}

public struct Approval: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var runId: String
    public var botId: String
    public var kind: String
    public var path: String
    public var reason: String
    public var access: String
    public var scope: String
    public var canRemember: Bool
    public var status: String
    public var expiresAt: String

    enum CodingKeys: String, CodingKey {
        case id, runId = "run_id", botId = "bot_id", kind, path, reason, access, scope
        case canRemember = "can_remember", status, expiresAt = "expires_at"
    }

    public init(id: String, runId: String, botId: String, path: String = "", reason: String = "", expiresAt: String) {
        self.id = id; self.runId = runId; self.botId = botId; kind = "outside_access"; self.path = path; self.reason = reason
        access = "legacy"; scope = Approval.legacyScope; canRemember = false; status = "pending"; self.expiresAt = expiresAt
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        runId = try c.decode(String.self, forKey: .runId)
        botId = try c.decode(String.self, forKey: .botId)
        kind = try c.value(.kind, "outside_access")
        path = try c.value(.path, "")
        reason = try c.value(.reason, "")
        access = try c.value(.access, "legacy")
        scope = try c.value(.scope, Approval.legacyScope)
        canRemember = try c.value(.canRemember, false)
        status = try c.value(.status, "pending")
        expiresAt = try c.decode(String.self, forKey: .expiresAt)
    }

    static let legacyScope = "仅本次任务访问此路径。旧版执行端无法保存授权，请更新执行电脑客户端。"
}

public struct SavedAuthorization: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var target: String
    public var targetLabel: String
    public var resource: String
    public var resourceType: String
    public var operation: String
    public var createdAt: String
    public var lastUsedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, target, targetLabel = "target_label", resource, resourceType = "resource_type", operation
        case createdAt = "created_at", lastUsedAt = "last_used_at"
    }
}

public struct AuthorizationLog: Decodable, Hashable, Identifiable, Sendable {
    public var id: Int64
    public var action: String
    public var target: String
    public var operation: String
    public var resource: String
    public var createdAt: String

    enum CodingKeys: String, CodingKey { case id, action, target, operation, resource, createdAt = "created_at" }
}

public struct BotActivity: Decodable, Hashable, Sendable {
    public var status: String?
    public var tool: String?
    public var summary: String?
    public var runningCount: Int
    public var queuedCount: Int

    enum CodingKeys: String, CodingKey { case status, tool, summary, runningCount = "running_count", queuedCount = "queued_count" }

    public init(status: String? = nil, tool: String? = nil, summary: String? = nil, runningCount: Int = 0, queuedCount: Int = 0) {
        self.status = status; self.tool = tool; self.summary = summary; self.runningCount = runningCount; self.queuedCount = queuedCount
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        status = try c.decodeIfPresent(String.self, forKey: .status)
        tool = try c.decodeIfPresent(String.self, forKey: .tool)
        summary = try c.decodeIfPresent(String.self, forKey: .summary)
        runningCount = try c.value(.runningCount, 0)
        queuedCount = try c.value(.queuedCount, 0)
    }
}

public struct AgentTaskRef: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var botId: String
    public var botName: String
    public var status: String
    public var mode: String
    public var kind: String
    public var title: String
    public var updatedAt: String?
    public var messageCount: Int
    public var operationTarget: String?

    enum CodingKeys: String, CodingKey {
        case id, botId = "bot_id", botName = "bot_name", status, mode, kind, title
        case updatedAt = "updated_at", messageCount = "message_count", operationTarget = "operation_target"
    }

    public init(id: String, botId: String, botName: String = "", status: String, mode: String = "wait", kind: String = "delegation") {
        self.id = id; self.botId = botId; self.botName = botName; self.status = status; self.mode = mode; self.kind = kind
        title = ""; messageCount = 0
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = try c.decode(String.self, forKey: .botId)
        botName = try c.value(.botName, "")
        status = try c.decode(String.self, forKey: .status)
        mode = try c.value(.mode, "wait")
        kind = try c.value(.kind, "delegation")
        title = try c.value(.title, "")
        updatedAt = try c.decodeIfPresent(String.self, forKey: .updatedAt)
        messageCount = try c.value(.messageCount, 0)
        operationTarget = try c.decodeIfPresent(String.self, forKey: .operationTarget)
    }
}

public struct Bot: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var slug: String
    public var persona: String
    public var modelId: String?
    public var avatar: Avatar
    public var isMain: Bool
    public var lastActiveAt: String
    public var latestRun: Run?
    public var lastMessage: LastMessage?
    public var activeTasks: [AgentTaskRef]
    public var activity: BotActivity?
    public var pendingApprovals: [Approval]
    public var executionDeviceId: String?

    enum CodingKeys: String, CodingKey {
        case id, name, slug, persona, modelId = "model_id", avatar, isMain = "is_main", lastActiveAt = "last_active_at"
        case latestRun = "latest_run", lastMessage = "last_message", activeTasks = "active_tasks", activity
        case pendingApprovals = "pending_approvals", executionDeviceId = "execution_device_id"
    }

    public init(id: String, name: String, slug: String, lastActiveAt: String, persona: String = "", avatar: Avatar = Avatar(),
                isMain: Bool = false, latestRun: Run? = nil, lastMessage: LastMessage? = nil, activity: BotActivity? = nil,
                pendingApprovals: [Approval] = []) {
        self.id = id; self.name = name; self.slug = slug; self.persona = persona; self.avatar = avatar; self.isMain = isMain
        self.lastActiveAt = lastActiveAt; self.latestRun = latestRun; self.lastMessage = lastMessage; activeTasks = []
        self.activity = activity; self.pendingApprovals = pendingApprovals
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        slug = try c.decode(String.self, forKey: .slug)
        persona = try c.value(.persona, "")
        modelId = try c.decodeIfPresent(String.self, forKey: .modelId)
        avatar = try c.value(.avatar, Avatar())
        isMain = try c.value(.isMain, false)
        lastActiveAt = try c.decode(String.self, forKey: .lastActiveAt)
        latestRun = try c.decodeIfPresent(Run.self, forKey: .latestRun)
        lastMessage = try c.decodeIfPresent(LastMessage.self, forKey: .lastMessage)
        activeTasks = try c.value(.activeTasks, [])
        activity = try c.decodeIfPresent(BotActivity.self, forKey: .activity)
        pendingApprovals = try c.value(.pendingApprovals, [])
        executionDeviceId = try c.decodeIfPresent(String.self, forKey: .executionDeviceId)
    }
}

public struct BotList: Decodable, Sendable {
    public var bots: [Bot]
    public var computer: ComputerStatus
    public var devices: [Device]
    public var cloudComputer: CloudComputer?

    enum CodingKeys: String, CodingKey { case bots, computer, devices, cloudComputer = "cloud_computer" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        bots = try c.decode([Bot].self, forKey: .bots).uniqued()
        computer = try c.value(.computer, ComputerStatus())
        devices = try c.value(.devices, [Device]()).uniqued()
        cloudComputer = try c.decodeIfPresent(CloudComputer.self, forKey: .cloudComputer)
    }
}

public struct ToolEntry: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var state: String
    public var summary: String?

    public init(id: String, name: String, state: String, summary: String? = nil) {
        self.id = id; self.name = name; self.state = state; self.summary = summary
    }
}

public struct ChatImage: Codable, Hashable, Sendable {
    public var name: String
    public var mimeType: String
    /// Base64 without line breaks.
    public var data: String

    enum CodingKeys: String, CodingKey { case name, mimeType = "mime_type", data }
    public init(name: String, mimeType: String, data: String) { self.name = name; self.mimeType = mimeType; self.data = data }
}

public struct MessageImage: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var mimeType: String
    enum CodingKeys: String, CodingKey { case id, name, mimeType = "mime_type" }
}

public struct ReportAttachment: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var title: String
    public var name: String
    public var mime: String
    public var size: Int64
    public var createdAt: String
    public var status: String

    enum CodingKeys: String, CodingKey { case id, title, name, mime, size, createdAt = "created_at", status }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        title = try c.decode(String.self, forKey: .title)
        name = try c.decode(String.self, forKey: .name)
        mime = try c.decode(String.self, forKey: .mime)
        size = try c.decode(Int64.self, forKey: .size)
        createdAt = try c.decode(String.self, forKey: .createdAt)
        status = try c.value(.status, "ready")
    }
}

/// Another bot wrote this `user` message: a delegated task (`task`) or the report of a hand-off (`report`).
public struct FromBot: Codable, Hashable, Sendable {
    public var id: String
    public var name: String
    public var avatar: Avatar?
    public var kind: String

    public init(id: String, name: String, avatar: Avatar? = nil, kind: String = "task") {
        self.id = id; self.name = name; self.avatar = avatar; self.kind = kind
    }

    enum CodingKeys: String, CodingKey { case id, name, avatar, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        avatar = try c.decodeIfPresent(Avatar.self, forKey: .avatar)
        kind = try c.value(.kind, "task")
    }
}

public struct ReplySegment: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var text: String
    public var phase: String
    public var createdAt: String
    enum CodingKeys: String, CodingKey { case id, text, phase, createdAt = "created_at" }
}

public struct Message: Codable, Hashable, Identifiable, Sendable {
    public var id: String
    public var botId: String
    public var runId: String?
    public var taskId: String?
    public var seq: Int
    public var role: String
    public var content: String
    public var images: [MessageImage]
    public var attachments: [ReportAttachment]
    public var status: String
    public var executor: String?
    public var tools: [ToolEntry]
    public var progress: [String]
    public var replySegments: [ReplySegment]
    public var ui: JSONValue?
    public var fromBot: FromBot?
    public var agentTasks: [AgentTaskRef]
    public var createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, botId = "bot_id", runId = "run_id", taskId = "task_id", seq, role, content, images, attachments, status
        case executor, tools, progress, replySegments = "reply_segments", ui, fromBot = "from_bot"
        case agentTasks = "agent_tasks", createdAt = "created_at"
    }

    public init(id: String, botId: String, runId: String? = nil, seq: Int, role: String, content: String, status: String,
                tools: [ToolEntry] = [], createdAt: String) {
        self.id = id; self.botId = botId; self.runId = runId; self.seq = seq; self.role = role; self.content = content
        self.status = status; self.tools = tools; self.createdAt = createdAt
        images = []; attachments = []; progress = []; replySegments = []; agentTasks = []
    }

    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        botId = try c.decode(String.self, forKey: .botId)
        runId = try c.decodeIfPresent(String.self, forKey: .runId)
        taskId = try c.decodeIfPresent(String.self, forKey: .taskId)
        seq = try c.decode(Int.self, forKey: .seq)
        role = try c.decode(String.self, forKey: .role)
        content = try c.decode(String.self, forKey: .content)
        images = try c.value(.images, [])
        attachments = try c.value(.attachments, [])
        status = try c.decode(String.self, forKey: .status)
        executor = try c.decodeIfPresent(String.self, forKey: .executor)
        tools = try c.value(.tools, [])
        progress = try c.value(.progress, [])
        replySegments = try c.value(.replySegments, [ReplySegment]()).uniqued()
        let rawUi = try c.decodeIfPresent(JSONValue.self, forKey: .ui)
        ui = rawUi == .null ? nil : rawUi
        fromBot = try c.decodeIfPresent(FromBot.self, forKey: .fromBot)
        agentTasks = try c.value(.agentTasks, [])
        createdAt = try c.decode(String.self, forKey: .createdAt)
    }
}

public struct ConversationBot: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var avatar: Avatar

    enum CodingKeys: String, CodingKey { case id, name, avatar }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        name = try c.decode(String.self, forKey: .name)
        avatar = try c.value(.avatar, Avatar())
    }
}

public struct ConversationMessage: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var seq: Int64
    public var fromBotId: String
    public var toBotId: String
    public var kind: String
    public var content: String
    public var createdAt: String?

    enum CodingKeys: String, CodingKey { case id, seq, fromBotId = "from_bot_id", toBotId = "to_bot_id", kind, content, createdAt = "created_at" }
}

public struct TaskConversation: Decodable, Sendable {
    public var executionLabel: String?
    public var taskId: String
    public var status: String
    public var bots: [ConversationBot]
    public var messages: [ConversationMessage]
    public var total: Int
    public var hasMore: Bool
    public var nextAfter: Int64

    enum CodingKeys: String, CodingKey {
        case executionLabel = "execution_label", taskId = "task_id", status, bots, messages, total, hasMore = "has_more", nextAfter = "next_after"
    }
}

public struct MessagePage: Decodable, Sendable {
    public var messages: [Message]
    public var hasMore: Bool

    enum CodingKeys: String, CodingKey { case messages, hasMore = "has_more" }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        messages = try c.decode([Message].self, forKey: .messages).uniqued()
        hasMore = try c.value(.hasMore, false)
    }
}

public struct SendResult: Decodable, Sendable {
    public var run: Run
    public var messages: [Message]
}

public struct FileEntry: Decodable, Hashable, Identifiable, Sendable {
    public var id: String
    public var name: String
    public var type: String
    public var size: Int64
    public var modified: String?

    enum CodingKeys: String, CodingKey { case id, name, type, size, modified }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        name = try c.decode(String.self, forKey: .name)
        // Older servers send no id; a file name is unique within one folder.
        id = try c.decodeIfPresent(String.self, forKey: .id) ?? name
        type = try c.decode(String.self, forKey: .type)
        size = try c.value(.size, 0)
        modified = try c.decodeIfPresent(String.self, forKey: .modified)
    }
}

public struct FileSource: Decodable, Hashable, Identifiable, Sendable {
    public var target: String
    public var label: String
    public var online: Bool
    public var kind: String
    public var id: String { target }

    enum CodingKeys: String, CodingKey { case target, label, online, kind }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decode(String.self, forKey: .target)
        label = try c.decode(String.self, forKey: .label)
        online = try c.value(.online, false)
        kind = try c.value(.kind, target.hasPrefix("remote:") ? "cloud" : "device")
    }
}

public struct FileSources: Decodable, Sendable {
    public var sources: [FileSource]
    enum CodingKeys: String, CodingKey { case sources }
    public init(from decoder: Decoder) throws {
        sources = try decoder.container(keyedBy: CodingKeys.self).value(.sources, [FileSource]()).uniqued()
    }
}

public struct FileList: Decodable, Sendable {
    public var target: String?
    public var path: String
    public var entries: [FileEntry]

    enum CodingKeys: String, CodingKey { case target, path, entries }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        target = try c.decodeIfPresent(String.self, forKey: .target)
        path = try c.value(.path, "")
        entries = try c.value(.entries, [FileEntry]()).uniqued()
    }
}

public struct FileContent: Decodable, Sendable {
    public var path: String
    public var name: String
    public var size: Int64
    public var kind: String
    public var content: String?
    public var base64: String?
    public var mime: String?
    public var truncated: Bool

    enum CodingKeys: String, CodingKey { case path, name, size, kind, content, base64, mime, truncated }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        path = try c.decode(String.self, forKey: .path)
        name = try c.value(.name, "")
        size = try c.value(.size, 0)
        kind = try c.decode(String.self, forKey: .kind)
        content = try c.decodeIfPresent(String.self, forKey: .content)
        base64 = try c.decodeIfPresent(String.self, forKey: .base64)
        mime = try c.decodeIfPresent(String.self, forKey: .mime)
        truncated = try c.value(.truncated, false)
    }
}

/// `modelId == nil` means "follow the admin's default model" and is always sent so edits can clear it.
public struct BotInput: Encodable, Sendable {
    public var name: String
    public var persona: String
    public var modelId: String?
    public var avatar: Avatar
    public var executionDeviceId: String?

    public init(name: String, persona: String, modelId: String?, avatar: Avatar, executionDeviceId: String? = nil) {
        self.name = name; self.persona = persona; self.modelId = modelId; self.avatar = avatar; self.executionDeviceId = executionDeviceId
    }

    enum CodingKeys: String, CodingKey { case name, persona, modelId = "model_id", avatar, executionDeviceId = "execution_device_id" }
    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(name, forKey: .name)
        try c.encode(persona, forKey: .persona)
        try c.encode(modelId, forKey: .modelId)
        try c.encode(avatar, forKey: .avatar)
        try c.encode(executionDeviceId, forKey: .executionDeviceId)
    }
}
