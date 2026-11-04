import XCTest
@testable import PiBotKit

/// Serves queued responses and records requests, like OkHttp's MockWebServer in the Android tests.
final class StubProtocol: URLProtocol {
    struct Reply { let status: Int; let body: String }
    nonisolated(unsafe) static var replies: [Reply] = []
    nonisolated(unsafe) static var requests: [(request: URLRequest, body: Data?)] = []
    private static let lock = NSLock()

    static func reset() { lock.lock(); replies = []; requests = []; lock.unlock() }
    static func respond(_ status: Int, _ body: String) { lock.lock(); replies.append(Reply(status: status, body: body)); lock.unlock() }
    static func take() -> (request: URLRequest, body: Data?) { lock.lock(); defer { lock.unlock() }; return requests.removeFirst() }

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        var body = request.httpBody
        if body == nil, let stream = request.httpBodyStream {
            stream.open()
            var data = Data()
            var buffer = [UInt8](repeating: 0, count: 4096)
            while stream.hasBytesAvailable { let n = stream.read(&buffer, maxLength: buffer.count); if n <= 0 { break }; data.append(buffer, count: n) }
            stream.close()
            body = data
        }
        Self.lock.lock()
        Self.requests.append((request, body))
        let reply = Self.replies.isEmpty ? Reply(status: 404, body: "") : Self.replies.removeFirst()
        Self.lock.unlock()
        let response = HTTPURLResponse(url: request.url!, statusCode: reply.status, httpVersion: "HTTP/1.1", headerFields: ["Content-Type": "application/json"])!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: Data(reply.body.utf8))
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

final class MemoryStorage: SessionStorage {
    var session: Session?
    var last: String?
    func load() -> Session? { session }
    func save(_ session: Session) { self.session = session; last = session.serverUrl }
    func clear() { session = nil }
    func lastServerUrl() -> String? { last }
}

private let bot = """
{"id":"b1","name":"研究助理","slug":"research","persona":"","model_id":null,"avatar":{"shape":"blob","color":"orange","scheme":"light"},"last_active_at":"2026-10-11T08:00:00Z","latest_run":null,"last_message":null,"pending_approvals":[]}
"""
private let runJSON = """
{"id":"r1","bot_id":"b1","status":"running","executor":"device","created_at":"2026-10-11T08:00:00Z"}
"""
private func msg(_ id: String, _ seq: Int, _ role: String, _ content: String, _ status: String) -> String {
    """
    {"id":"\(id)","bot_id":"b1","run_id":"r1","seq":\(seq),"role":"\(role)","content":"\(content)","status":"\(status)","tools":[],"created_at":"2026-10-11T08:00:00Z"}
    """
}

@MainActor
final class StoreTests: XCTestCase {
    private var storage: MemoryStorage!
    private var store: AppStore!
    private let base = "http://stub.test/pibot"

    override func setUp() async throws {
        StubProtocol.reset()
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [StubProtocol.self]
        storage = MemoryStorage()
        store = AppStore(api: PiBotAPI(session: URLSession(configuration: config)), storage: storage)
    }

    private func json(_ data: Data?) -> JSONValue { (try? JSONDecoder().decode(JSONValue.self, from: data ?? Data())) ?? .null }

    private func login() async throws {
        StubProtocol.respond(200, #"{"access_token":"tok","expires_in":3600,"user":{"id":"u1","username":"bob"}}"#)
        try await store.login(server: base, username: "bob", password: "secret")
        _ = StubProtocol.take()
    }

    func testLoginStoresTheSessionUnderThePathPrefix() async throws {
        StubProtocol.respond(200, #"{"access_token":"tok","expires_in":3600,"user":{"id":"u1","username":"bob"}}"#)
        try await store.login(server: " \(base)/ ", username: " bob ", password: "secret")
        let request = StubProtocol.take()
        XCTAssertEqual(request.request.url?.path, "/pibot/auth/login")
        XCTAssertEqual(json(request.body), .object(["username": .string("bob"), "password": .string("secret")]))
        XCTAssertEqual(store.session?.token, "tok")
        XCTAssertEqual(store.session?.user.username, "bob")
        XCTAssertEqual(storage.lastServerUrl(), base)
    }

    func testWrongPasswordShowsTheServerMessage() async {
        StubProtocol.respond(401, #"{"detail":"用户名或密码错误"}"#)
        do {
            try await store.login(server: base, username: "bob", password: "nope")
            XCTFail("login should fail")
        } catch {
            XCTAssertEqual(errorText(error), "用户名或密码错误")
        }
        XCTAssertNil(store.session)
    }

    func testBotsMessagesAndSending() async throws {
        try await login()
        StubProtocol.respond(200, #"{"bots":[\#(bot)],"computer":{"online":true,"device":{"id":"d1","label":"Bob 的 Mac","online":true}},"devices":[{"id":"d1","label":"Bob 的 Mac","platform":"darwin","online":true},{"id":"d2","label":"Linux","platform":"linux","online":false}]}"#)
        try await store.refreshBots()
        XCTAssertEqual(StubProtocol.take().request.value(forHTTPHeaderField: "Authorization"), "Bearer tok")
        XCTAssertEqual(store.bots?.single?.name, "研究助理")
        XCTAssertTrue(store.computer.online)
        XCTAssertEqual(store.computer.device?.label, "Bob 的 Mac")
        XCTAssertEqual(store.devices.map(\.id), ["d1", "d2"])
        XCTAssertEqual(store.devices.last?.platformLabel, "Linux")

        StubProtocol.respond(200, #"{"messages":[\#(msg("m0", 1, "user", "早", "completed"))],"has_more":true}"#)
        try await store.loadTail("b1")
        XCTAssertEqual(StubProtocol.take().request.url?.query, "limit=50")
        XCTAssertTrue(store.timeline("b1").hasMore)

        StubProtocol.respond(200, #"{"run":\#(runJSON),"messages":[\#(msg("m1", 2, "user", "写周报", "completed")),\#(msg("m2", 3, "assistant", "", "running"))]}"#)
        try await store.send(botId: "b1", text: "写周报")
        let sent = json(StubProtocol.take().body)
        XCTAssertEqual(sent["text"]?.stringValue, "写周报")
        XCTAssertEqual(sent["client"]?.stringValue, "ios")
        XCTAssertGreaterThanOrEqual(sent["request_id"]?.stringValue?.count ?? 0, 8)
        XCTAssertEqual(store.bots?.single?.latestRun?.status, "running")
        XCTAssertEqual(store.timeline("b1").messages.map(\.id), ["m0", "m1", "m2"])

        store.handleEvent(JSONValue.parse(#"{"type":"delta","bot_id":"b1","message_id":"m2","content":"本周"}"#)!)
        XCTAssertEqual(store.timeline("b1").messages.last?.content, "本周")

        StubProtocol.respond(200, #"{"messages":[\#(msg("m9", 0, "user", "更早", "completed"))],"has_more":false}"#)
        try await store.loadMore("b1")
        XCTAssertEqual(StubProtocol.take().request.url?.query, "limit=50&before=1")
        XCTAssertFalse(store.timeline("b1").hasMore)
        XCTAssertEqual(store.timeline("b1").messages.first?.id, "m9")
    }

    func testServersThatDoNotKnowTheIosClientStillAcceptMessages() async throws {
        try await login()
        StubProtocol.respond(422, #"{"detail":[{"loc":["body","client"],"msg":"Invalid option","type":"invalid_value"}]}"#)
        StubProtocol.respond(200, #"{"run":\#(runJSON),"messages":[\#(msg("m1", 1, "user", "早", "completed"))]}"#)
        try await store.send(botId: "b1", text: "早", requestId: "req-12345")
        let first = json(StubProtocol.take().body)
        let retry = json(StubProtocol.take().body)
        XCTAssertEqual(first["client"]?.stringValue, "ios")
        XCTAssertNil(retry["client"])
        XCTAssertEqual(retry["request_id"]?.stringValue, "req-12345")
        XCTAssertEqual(store.timeline("b1").messages.map(\.id), ["m1"])

        StubProtocol.respond(422, #"{"detail":[{"loc":["body","text"],"msg":"请填写消息或选择图片","type":"custom"}]}"#)
        do {
            try await store.send(botId: "b1", text: "")
            XCTFail("other validation errors are not retried")
        } catch {
            XCTAssertEqual((error as? APIError)?.status, 422)
        }
        _ = StubProtocol.take()
        XCTAssertTrue(StubProtocol.requests.isEmpty)
    }

    func testBotEditsAlwaysSendTheModelSoItCanBeCleared() async throws {
        try await login()
        StubProtocol.respond(200, bot)
        try await store.updateBot("b1", input: BotInput(name: "研究助理", persona: "", modelId: nil, avatar: Avatar(shape: "cloud", color: "mint", scheme: "dark")))
        let request = StubProtocol.take()
        XCTAssertEqual(request.request.httpMethod, "PATCH")
        guard case .object(let body) = json(request.body) else { return XCTFail("body is not an object") }
        XCTAssertEqual(body["model_id"], .null)
        XCTAssertEqual(body["avatar"]?["shape"]?.stringValue, "cloud")
    }

    func testLibraryPathsAreQueryEncodedAndOfflineIsExplained() async throws {
        try await login()
        StubProtocol.respond(200, #"{"path":"报告","entries":[{"name":"周报.md","type":"file","size":12,"modified":"2026-10-11T08:00:00Z"}]}"#)
        let list = try await store.files(botId: "b1", path: "报告/a+b&c")
        let query = StubProtocol.take().request.url?.query ?? ""
        XCTAssertEqual(query, "path=%E6%8A%A5%E5%91%8A%2Fa%2Bb%26c")
        XCTAssertEqual(list.entries.single?.name, "周报.md")
        StubProtocol.respond(503, "")
        do { _ = try await store.files(botId: "b1", path: ""); XCTFail("offline should fail") }
        catch { XCTAssertEqual(errorText(error), "电脑离线，资料库不可用") }
    }

    func testAnExpiredSessionSignsOut() async throws {
        try await login()
        var signedOut = false
        store.onSignedOut = { signedOut = true }
        StubProtocol.respond(401, #"{"detail":"登录已过期"}"#)
        do { try await store.refreshBots(); XCTFail("refresh should fail") } catch {}
        XCTAssertNil(store.session)
        XCTAssertNil(storage.session)
        XCTAssertTrue(signedOut)
    }

    func testSavedAuthorizationsUseExplicitDecisionAndRevoke() async throws {
        try await login()
        let approval = try JSONDecoder().decode(Approval.self, from: Data(#"{"id":"a1","run_id":"r1","bot_id":"b1","path":"/x","access":"read","scope":"办公电脑 · 读取","can_remember":true,"expires_at":"2026-10-11T08:10:00Z"}"#.utf8))
        XCTAssertTrue(approval.canRemember)
        StubProtocol.respond(200, #"{"id":"a1","run_id":"r1","bot_id":"b1","status":"approved","expires_at":"2026-10-11T08:10:00Z"}"#)
        StubProtocol.respond(200, bot)
        try await store.decide(approval, decision: "approve_always")
        let decision = StubProtocol.take()
        XCTAssertEqual(decision.request.url?.path, "/pibot/approvals/a1")
        XCTAssertEqual(json(decision.body)["decision"]?.stringValue, "approve_always")
        _ = StubProtocol.take()
        StubProtocol.respond(200, "{}")
        try await store.revokeAuthorization("rule1")
        let revoke = StubProtocol.take()
        XCTAssertEqual(revoke.request.httpMethod, "DELETE")
        XCTAssertEqual(revoke.request.url?.path, "/pibot/authorizations/rule1")
    }

    func testCallEventsTrackARemoteCallAndLeaveALocalOneAlone() {
        func event(_ text: String) { store.handleEvent(JSONValue.parse(text)!) }
        event(#"{"type":"call","bot_id":"b1","call_id":"c1","phase":"listening"}"#)
        XCTAssertEqual(store.liveCall?.phase, "listening")
        XCTAssertEqual(store.liveCall?.local, false)
        event(#"{"type":"call","bot_id":"b1","call_id":"c1","phase":"ended"}"#)
        XCTAssertNil(store.liveCall)

        store.updateLiveCall(LiveCall(botId: "b1", phase: "connecting", local: true))
        event(#"{"type":"call","bot_id":"b1","call_id":"other","phase":"ended"}"#)
        XCTAssertEqual(store.liveCall?.phase, "connecting")
        event(#"{"type":"call","bot_id":"b1","call_id":"c2","phase":"speaking"}"#)
        XCTAssertEqual(store.liveCall?.callId, "c2")
        XCTAssertEqual(store.liveCall?.local, true)
        event(#"{"type":"call","bot_id":"b1","call_id":"c2","phase":"ended"}"#)
        XCTAssertNil(store.liveCall)
    }

    func testErrorMessagesFallBackToStatus() {
        XCTAssertEqual(errorMessage(status: 500, body: Data("<html>".utf8)), "请求失败（500）")
        XCTAssertEqual(errorMessage(status: 404, body: Data(#"{"detail":"Bot 不存在"}"#.utf8)), "Bot 不存在")
    }
}

extension Array {
    var single: Element? { count == 1 ? first : nil }
}
