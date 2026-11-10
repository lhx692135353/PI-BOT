import Foundation
import Observation

/// One live voice call. `local` means this device holds the microphone.
public struct LiveCall: Hashable, Sendable {
    public var botId: String
    public var callId: String?
    public var phase: String
    public var muted: Bool
    /// Epoch milliseconds; 0 until the call connects.
    public var startedAt: Int64
    public var error: String?
    public var local: Bool

    public init(botId: String, callId: String? = nil, phase: String = "connecting", muted: Bool = false, startedAt: Int64 = 0, error: String? = nil, local: Bool = false) {
        self.botId = botId; self.callId = callId; self.phase = phase; self.muted = muted
        self.startedAt = startedAt; self.error = error; self.local = local
    }
}

/// Single source of truth for the signed-in user's bots. REST for reads and actions;
/// `/ws/events` while the app is in the foreground for live updates.
@MainActor
@Observable
public final class AppStore {
    public private(set) var session: Session?
    /// nil until the first load finishes.
    public private(set) var bots: [Bot]?
    public private(set) var computer = ComputerStatus()
    public private(set) var devices: [Device] = []
    /// The always-available server-side computer shown next to the user's own; nil when disabled.
    public private(set) var cloudComputer: CloudComputer?
    /// Whether the live events socket is connected.
    public private(set) var live = false
    /// The user's current voice call, on this device or another one.
    public private(set) var liveCall: LiveCall?
    /// A call failure to show once, after the call itself has gone.
    public private(set) var voiceNotice: String?
    public private(set) var timelines: [String: Timeline] = [:] {
        didSet { schedulePersist() }
    }
    /// Drafts belong to bots, so resizing, rotating and switching conversations keep them.
    public var drafts: [String: String] = [:]

    /// Called after sign-out so platform services (such as a voice call) can stop.
    @ObservationIgnored public var onSignedOut: () -> Void = {}

    @ObservationIgnored private let api: PiBotAPI
    @ObservationIgnored private let storage: SessionStorage
    @ObservationIgnored private let socketSession: URLSession
    @ObservationIgnored private var socket: URLSessionWebSocketTask?
    @ObservationIgnored private var reconnect: Task<Void, Never>?
    @ObservationIgnored private var activityPoll: Task<Void, Never>?
    @ObservationIgnored private var pinger: Task<Void, Never>?
    @ObservationIgnored private var wantEvents = false
    @ObservationIgnored private var attempts = 0
    @ObservationIgnored private var dirty: Set<String> = []
    @ObservationIgnored private var botRequestClock: Int64 = 0
    @ObservationIgnored private var botListRequest: Int64 = 0
    @ObservationIgnored private var botRefreshVersions: [String: Int64] = [:]
    @ObservationIgnored private var tailVersions: [String: Int64] = [:]
    @ObservationIgnored private let timelineStore: TimelineStore?
    @ObservationIgnored private var savedTimelines: [String: Timeline] = [:]
    @ObservationIgnored private var persistTask: Task<Void, Never>?

    public init(api: PiBotAPI = PiBotAPI(), storage: SessionStorage = KeychainSessionStore(), socketSession: URLSession? = nil, timelineStore: TimelineStore? = nil) {
        self.api = api
        self.storage = storage
        self.timelineStore = timelineStore
        if let socketSession { self.socketSession = socketSession } else {
            let config = URLSessionConfiguration.default
            config.timeoutIntervalForRequest = 3600
            self.socketSession = URLSession(configuration: config)
        }
        session = storage.load()
    }

    public func lastServerUrl() -> String? { storage.lastServerUrl() }

    public func timeline(_ botId: String) -> Timeline { timelines[botId] ?? Timeline() }

    public func bot(_ botId: String) -> Bot? { bots?.first { $0.id == botId } }

    // MARK: Account

    public func login(server raw: String, username: String, password: String) async throws {
        let url = try parseServerURL(raw)
        let r = try await api.login(url, username: username.trimmingCharacters(in: .whitespaces), password: password)
        let next = Session(serverUrl: url.base, token: r.accessToken, expiresAt: nowMillis() + r.expiresIn * 1000, user: r.user)
        storage.save(next)
        session = next
    }

    public func logout() {
        stopEvents()
        storage.clear()
        let userId = session?.user.id
        session = nil
        bots = nil
        persistTask?.cancel(); persistTask = nil
        timelines = [:]
        savedTimelines = [:]
        if let userId, let store = timelineStore { Task.detached(priority: .utility) { store.clear(userId: userId) } }
        computer = ComputerStatus()
        devices = []
        cloudComputer = nil
        liveCall = nil
        voiceNotice = nil
        drafts = [:]
        onSignedOut()
    }

    public func changePassword(old: String, new: String) async throws {
        try await authed { try await self.api.changePassword($0, token: $1, old: old, new: new) }
    }

    @discardableResult
    public func refreshMe() async throws -> Me {
        let me = try await authed { try await self.api.me($0, token: $1) }
        computer = me.computer
        devices = me.devices
        cloudComputer = me.cloudComputer
        return me
    }

    public func revokeDevice(_ id: String) async throws {
        _ = try await authed { try await self.api.revokeDevice($0, token: $1, id: id) }
        try await refreshMe()
    }

    // MARK: Voice call state

    public func updateLiveCall(_ call: LiveCall?) { liveCall = call }

    public func clearVoiceNotice() { voiceNotice = nil }

    /// Drops the call indicator. A signed-out session does not keep a notice.
    public func endLiveCall(botId: String, error: String?) {
        if session != nil, let error, !error.trimmingCharacters(in: .whitespaces).isEmpty, error != "hangup", error != "ended" {
            voiceNotice = error
        }
        if liveCall?.botId == botId { liveCall = nil }
    }

    // MARK: Bots

    private func authed<T>(_ block: (ServerURL, String) async throws -> T) async throws -> T {
        guard let s = session else { throw APIError(status: 401, message: "请先登录") }
        do {
            return try await block(s.url, s.token)
        } catch let e as APIError {
            if e.unauthorized && session == s { logout() }
            throw e
        }
    }

    public func refreshBots() async throws {
        botRequestClock += 1
        let version = botRequestClock
        botListRequest += 1
        let request = botListRequest
        let original = session
        let list = try await authed { try await self.api.bots($0, token: $1) }
        guard session == original, botListRequest == request else { return }
        let previous = bots ?? []
        let current = Dictionary(previous.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        let incoming = list.bots.map { bot -> Bot in
            let counter = botRefreshVersions[bot.id] ?? 0
            if counter > version { return current[bot.id] ?? bot }
            botRefreshVersions[bot.id] = max(counter, version)
            return bot
        }
        let ids = Set(incoming.map(\.id))
        bots = incoming + previous.filter { !ids.contains($0.id) && (botRefreshVersions[$0.id] ?? 0) > version }
        computer = list.computer
        devices = list.devices
        cloudComputer = list.cloudComputer
    }

    public func refreshBot(_ id: String) async throws {
        botRequestClock += 1
        let version = botRequestClock
        botRefreshVersions[id] = max(botRefreshVersions[id] ?? 0, version)
        let original = session
        do {
            let bot = try await authed { try await self.api.bot($0, token: $1, id: id) }
            if botRefreshVersions[id] == version && session == original { upsert(bot) }
        } catch let e as APIError where e.status == 404 {
            if botRefreshVersions[id] == version && session == original { remove(id) }
        }
    }

    private func upsert(_ bot: Bot) {
        var list = bots ?? []
        if let i = list.firstIndex(where: { $0.id == bot.id }) { list[i] = bot } else { list.insert(bot, at: 0) }
        bots = list.sorted { $0.lastActiveAt > $1.lastActiveAt }
    }

    private func remove(_ id: String) {
        bots = bots?.filter { $0.id != id }
        timelines[id] = nil
    }

    public func models() async throws -> [Model] { try await authed { try await self.api.models($0, token: $1) } }

    @discardableResult
    public func createBot(_ input: BotInput) async throws -> Bot {
        let bot = try await authed { try await self.api.createBot($0, token: $1, input: input) }
        upsert(bot)
        return bot
    }

    @discardableResult
    public func updateBot(_ id: String, input: BotInput) async throws -> Bot {
        let bot = try await authed { try await self.api.updateBot($0, token: $1, id: id, input: input) }
        upsert(bot)
        return bot
    }

    public func archiveBot(_ id: String) async throws {
        try await authed { try await self.api.archiveBot($0, token: $1, id: id) }
        remove(id)
    }

    // MARK: Timeline

    public func loadTail(_ botId: String) async throws {
        let version = (tailVersions[botId] ?? 0) + 1
        tailVersions[botId] = version
        let original = session
        let page = try await authed { try await self.api.messages($0, token: $1, botId: botId) }
        guard tailVersions[botId] == version, session == original else { return }
        timelines[botId] = timeline(botId).mergeTail(page.messages, hasMore: page.hasMore)
    }

    /// Shows the cached history of a bot that has not been loaded in this session yet.
    public func hydrate(_ botId: String) {
        guard timelines[botId] == nil, let store = timelineStore, let userId = session?.user.id,
              let cached = store.read(userId: userId, botId: botId) else { return }
        savedTimelines[botId] = cached
        timelines[botId] = cached
    }

    public func loadMore(_ botId: String) async throws {
        guard let oldest = timelines[botId]?.messages.first else { return try await loadTail(botId) }
        let original = session
        let page = try await authed { try await self.api.messages($0, token: $1, botId: botId, before: oldest.seq) }
        guard session == original, let current = timelines[botId] else { return }
        timelines[botId] = current.mergeOlder(before: oldest.id, page.messages, hasMore: page.hasMore)
    }

    private func schedulePersist() {
        guard timelineStore != nil else { return }
        persistTask?.cancel()
        persistTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled else { return }
            self?.persistTimelines()
        }
    }

    private func persistTimelines() {
        guard let store = timelineStore, let userId = session?.user.id else { return }
        let changed = timelines.filter { savedTimelines[$0.key] != $0.value && !$0.value.messages.isEmpty }
        guard !changed.isEmpty else { return }
        for (botId, timeline) in changed { savedTimelines[botId] = timeline }
        Task.detached(priority: .utility) {
            for (botId, timeline) in changed { store.write(userId: userId, botId: botId, timeline: timeline) }
        }
    }

    public func taskConversation(botId: String, taskId: String, after: Int64 = 0) async throws -> TaskConversation {
        try await authed { try await self.api.taskConversation($0, token: $1, botId: botId, taskId: taskId, after: after) }
    }

    @discardableResult
    public func send(botId: String, text: String, requestId: String = UUID().uuidString.lowercased(), images: [ChatImage] = []) async throws -> Run {
        let result = try await authed { try await self.api.send($0, token: $1, botId: botId, text: text, requestId: requestId, images: images) }
        timelines[botId] = timeline(botId).merge(result.messages)
        setLatestRun(botId, result.run)
        return result.run
    }

    private func setLatestRun(_ botId: String, _ run: Run) {
        guard var list = bots, let i = list.firstIndex(where: { $0.id == botId }) else { return }
        list[i].latestRun = run
        bots = list
    }

    public func image(botId: String, messageId: String, imageId: String) async throws -> ChatImage {
        try await authed { try await self.api.image($0, token: $1, botId: botId, messageId: messageId, imageId: imageId) }
    }

    public func saveUiState(botId: String, messageId: String, payload: JSONValue) async throws -> JSONValue {
        let message = try await authed { try await self.api.uiState($0, token: $1, botId: botId, messageId: messageId, payload: payload) }
        timelines[botId] = timeline(botId).merge([message])
        guard let ui = message.ui else { throw APIError(status: 422, message: "交互界面无效") }
        return ui
    }

    public func submitUiAction(botId: String, messageId: String, payload: JSONValue) async throws {
        let result = try await authed { try await self.api.uiAction($0, token: $1, botId: botId, messageId: messageId, payload: payload) }
        timelines[botId] = timeline(botId).merge(result.messages)
        setLatestRun(botId, result.run)
    }

    public func cancel(botId: String, runId: String) async throws {
        _ = try await authed { try await self.api.cancel($0, token: $1, runId: runId) }
        try await refreshBot(botId)
        try await loadTail(botId)
    }

    public func decide(_ approval: Approval, decision: String) async throws {
        _ = try await authed { try await self.api.decide($0, token: $1, approvalId: approval.id, decision: decision) }
        try await refreshBot(approval.botId)
    }

    public func authorizations() async throws -> [SavedAuthorization] { try await authed { try await self.api.authorizations($0, token: $1) } }

    public func authorizationLogs() async throws -> [AuthorizationLog] { try await authed { try await self.api.authorizationLogs($0, token: $1) } }

    public func revokeAuthorization(_ id: String) async throws { try await authed { try await self.api.revokeAuthorization($0, token: $1, id: id) } }

    public func fileSources(botId: String) async throws -> FileSources { try await authed { try await self.api.fileSources($0, token: $1, botId: botId) } }

    public func files(botId: String, path: String, target: String? = nil) async throws -> FileList {
        try await authed { try await self.api.files($0, token: $1, botId: botId, path: path, target: target) }
    }

    public func file(botId: String, path: String, target: String? = nil) async throws -> FileContent {
        try await authed { try await self.api.file($0, token: $1, botId: botId, path: path, target: target) }
    }

    /// Short-lived viewer links are relative to the server root.
    public func reportOpen(_ id: String) async throws -> URL {
        try absolute(try await authed { try await self.api.reportOpen($0, token: $1, id: id) }, missing: "结果不可用")
    }

    public func remoteArtifact(_ id: String) async throws -> URL {
        try absolute(try await authed { try await self.api.remoteArtifact($0, token: $1, id: id) }, missing: "结果不可用")
    }

    public func remoteDesktop(botId: String) async throws -> URL {
        try absolute(try await authed { try await self.api.remoteDesktop($0, token: $1, botId: botId) }, missing: "云端桌面入口不可用")
    }

    private func absolute(_ result: JSONValue, missing: String) throws -> URL {
        guard let account = session else { throw APIError(status: 401, message: "请先登录") }
        guard let path = result["url"]?.stringValue else { throw APIError(status: 0, message: missing) }
        var base = account.serverUrl
        while base.hasSuffix("/") { base.removeLast() }
        guard let url = URL(string: base + path) else { throw APIError(status: 0, message: missing) }
        return url
    }

    // MARK: Live events

    /// Coalesces bursts of `bot` events into one refresh per bot.
    private func requestBotRefresh(_ id: String) {
        if dirty.contains(id) { return }
        dirty.insert(id)
        Task {
            try? await Task.sleep(nanoseconds: 200_000_000)
            dirty.remove(id)
            try? await refreshBot(id)
            if timelines[id]?.loaded == true { try? await loadTail(id) }
        }
    }

    public func handleEvent(_ event: JSONValue) {
        switch event["type"]?.stringValue {
        case "delta":
            guard let botId = event["bot_id"]?.stringValue, let messageId = event["message_id"]?.stringValue,
                  let content = event["content"]?.stringValue, let current = timelines[botId] else { return }
            timelines[botId] = current.applyDelta(messageId: messageId, content: content)
        case "bot":
            if let id = event["bot_id"]?.stringValue { requestBotRefresh(id) }
        case "presence":
            if let online = event["online"]?.boolValue { computer.online = online }
            Task { try? await refreshMe() }
        case "bots":
            Task { try? await refreshBots() }
        case "call":
            applyCall(event)
        default:
            break
        }
    }

    private func applyCall(_ event: JSONValue) {
        guard let botId = event["bot_id"]?.stringValue, let phase = event["phase"]?.stringValue else { return }
        let callId = event["call_id"]?.stringValue
        let current = liveCall
        if phase == "ended" {
            if let current, current.botId == botId {
                let foreign = current.local
                    ? (current.callId == nil || current.callId != callId)
                    : (current.callId != nil && current.callId != callId)
                if !foreign { liveCall = nil }
            }
            requestBotRefresh(botId)
            return
        }
        if let current, current.local {
            if current.botId == botId {
                var next = current
                next.callId = callId ?? current.callId
                next.phase = phase
                liveCall = next
            }
        } else {
            let startedAt = current?.botId == botId && (current?.startedAt ?? 0) > 0 ? current!.startedAt : nowMillis()
            liveCall = LiveCall(botId: botId, callId: callId, phase: phase, startedAt: startedAt)
        }
    }

    public func startEvents() {
        wantEvents = true
        if activityPoll == nil {
            activityPoll = Task { [weak self] in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 5_000_000_000)
                    guard let self, self.wantEvents else { return }
                    // Idle caches can miss the event that starts a task on another computer.
                    await self.refreshAll()
                }
            }
        }
        if socket == nil { connect() }
    }

    public func stopEvents() {
        wantEvents = false
        activityPoll?.cancel(); activityPoll = nil
        reconnect?.cancel(); reconnect = nil
        pinger?.cancel(); pinger = nil
        socket?.cancel(with: .normalClosure, reason: nil)
        socket = nil
        live = false
    }

    private func refreshAll() async {
        try? await refreshBots()
        for (id, timeline) in timelines where timeline.loaded { try? await loadTail(id) }
    }

    private func connect() {
        guard let s = session, let address = try? s.url.eventsSocket(token: s.token), let url = URL(string: address) else { return }
        let task = socketSession.webSocketTask(with: url)
        socket = task
        task.resume()
        Task { [weak self] in await self?.receive(task) }
        pinger?.cancel()
        pinger = Task { [weak task] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 25_000_000_000)
                task?.sendPing { _ in }
            }
        }
    }

    private func receive(_ task: URLSessionWebSocketTask) async {
        while true {
            let message: URLSessionWebSocketTask.Message
            do { message = try await task.receive() } catch { closed(task); return }
            guard socket === task else { return }
            let text: String
            switch message {
            case .string(let s): text = s
            case .data(let d): text = String(decoding: d, as: UTF8.self)
            @unknown default: continue
            }
            guard let packet = JSONValue.parse(text) else { continue }
            switch packet["type"]?.stringValue {
            case "hello":
                attempts = 0
                live = true
                if let online = packet["device_online"]?.boolValue ?? packet["mac_online"]?.boolValue { computer.online = online }
                Task { await refreshAll() }
            case "event":
                if let event = packet["event"] { handleEvent(event) }
            default:
                break
            }
        }
    }

    private func closed(_ task: URLSessionWebSocketTask) {
        guard socket === task else { return }
        socket = nil
        live = false
        pinger?.cancel(); pinger = nil
        let status = (task.response as? HTTPURLResponse)?.statusCode
        if task.closeCode.rawValue == 4401 || status == 401 { logout(); return }
        guard wantEvents else { return }
        let wait = min(30.0, Double(1 << min(attempts, 5)))
        attempts += 1
        reconnect = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            guard let self, !Task.isCancelled, self.wantEvents, self.socket == nil else { return }
            self.connect()
        }
    }
}
