import Foundation

/// Server-side errors carry a Chinese `detail`; `unauthorized` means the session is gone.
public struct APIError: LocalizedError, Equatable {
    public let status: Int
    public let message: String
    public let code: String?

    public init(status: Int, message: String, code: String? = nil) {
        self.status = status; self.message = message; self.code = code
    }

    public var unauthorized: Bool { status == 401 }
    /// Servers released before the iOS client reject `"client": "ios"`; the request is retried without it.
    public var clientRejected: Bool { code == clientRejectedCode }
    public var errorDescription: String? { message }
}

public func errorMessage(status: Int, body: Data) -> String {
    let detail = (try? JSONDecoder().decode(JSONValue.self, from: body))?["detail"]?.stringValue
    if let detail, !detail.trimmingCharacters(in: .whitespaces).isEmpty { return detail }
    switch status {
    case 401: return "登录已过期，请重新登录"
    case 503: return "电脑离线，资料库不可用"
    default: return "请求失败（\(status)）"
    }
}

let clientRejectedCode = "client_rejected"

/// Messages per history request, for the newest page and each older one.
public let messagePageSize = 30

private func rejectsClient(_ body: Data) -> Bool {
    guard case .array(let issues)? = (try? JSONDecoder().decode(JSONValue.self, from: body))?["detail"] else { return false }
    return issues.contains { issue in
        guard case .array(let loc)? = issue["loc"] else { return false }
        return loc.last?.stringValue == "client"
    }
}

/// Text for a failure shown in the UI.
public func errorText(_ error: Error) -> String {
    if let e = error as? APIError { return e.message }
    if let e = error as? LocalizedError, let text = e.errorDescription, !text.isEmpty { return text }
    return "出了点问题，请重试"
}

/// Query values are percent-encoded strictly so `+` and `&` inside library paths survive.
func encodeQueryValue(_ value: String) -> String {
    var allowed = CharacterSet.alphanumerics
    allowed.insert(charactersIn: "-._~")
    return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
}

private struct LoginBody: Encodable { let username: String; let password: String }
private struct SendBody: Encodable {
    let text: String
    let requestId: String
    let images: [ChatImage]
    let client: String?
    enum CodingKeys: String, CodingKey { case text, requestId = "request_id", images, client }
}
private struct DecisionBody: Encodable { let decision: String }
private struct PasswordBody: Encodable {
    let oldPassword: String
    let newPassword: String
    enum CodingKeys: String, CodingKey { case oldPassword = "old_password", newPassword = "new_password" }
}
private struct EmptyBody: Encodable {}

public final class PiBotAPI: @unchecked Sendable {
    private let session: URLSession

    public init(session: URLSession = .shared) { self.session = session }

    public func login(_ url: ServerURL, username: String, password: String) async throws -> LoginResponse {
        try await call(url, "POST", "/auth/login", token: nil, body: LoginBody(username: username, password: password))
    }

    public func changePassword(_ url: ServerURL, token: String, old: String, new: String) async throws {
        let _: JSONValue = try await call(url, "POST", "/auth/password", token: token, body: PasswordBody(oldPassword: old, newPassword: new))
    }

    public func me(_ url: ServerURL, token: String) async throws -> Me { try await call(url, "GET", "/me", token: token) }

    public func revokeDevice(_ url: ServerURL, token: String, id: String) async throws -> Device {
        try await call(url, "POST", "/devices/\(id)/revoke", token: token, body: EmptyBody())
    }

    public func models(_ url: ServerURL, token: String) async throws -> [Model] { try await call(url, "GET", "/models", token: token) }

    public func bots(_ url: ServerURL, token: String) async throws -> BotList { try await call(url, "GET", "/bots", token: token) }

    public func bot(_ url: ServerURL, token: String, id: String) async throws -> Bot { try await call(url, "GET", "/bots/\(id)", token: token) }

    public func createBot(_ url: ServerURL, token: String, input: BotInput) async throws -> Bot {
        try await call(url, "POST", "/bots", token: token, body: input)
    }

    public func updateBot(_ url: ServerURL, token: String, id: String, input: BotInput) async throws -> Bot {
        try await call(url, "PATCH", "/bots/\(id)", token: token, body: input)
    }

    public func archiveBot(_ url: ServerURL, token: String, id: String) async throws {
        let _: JSONValue = try await call(url, "DELETE", "/bots/\(id)", token: token)
    }

    public func messages(_ url: ServerURL, token: String, botId: String, before: Int? = nil) async throws -> MessagePage {
        var query = [("limit", String(messagePageSize))]
        if let before { query.append(("before", String(before))) }
        return try await call(url, "GET", "/bots/\(botId)/messages", token: token, query: query)
    }

    public func taskConversation(_ url: ServerURL, token: String, botId: String, taskId: String, after: Int64 = 0) async throws -> TaskConversation {
        try await call(url, "GET", "/bots/\(botId)/tasks/\(taskId)/conversation", token: token, query: [("after", String(after))])
    }

    public func send(_ url: ServerURL, token: String, botId: String, text: String, requestId: String, images: [ChatImage] = []) async throws -> SendResult {
        do {
            return try await call(url, "POST", "/bots/\(botId)/messages", token: token, body: SendBody(text: text, requestId: requestId, images: images, client: "ios"))
        } catch let e as APIError where e.clientRejected {
            return try await call(url, "POST", "/bots/\(botId)/messages", token: token, body: SendBody(text: text, requestId: requestId, images: images, client: nil))
        }
    }

    public func image(_ url: ServerURL, token: String, botId: String, messageId: String, imageId: String) async throws -> ChatImage {
        try await call(url, "GET", "/bots/\(botId)/messages/\(messageId)/images/\(imageId)", token: token)
    }

    public func uiState(_ url: ServerURL, token: String, botId: String, messageId: String, payload: JSONValue) async throws -> Message {
        try await call(url, "POST", "/bots/\(botId)/messages/\(messageId)/ui-state", token: token, body: payload)
    }

    public func uiAction(_ url: ServerURL, token: String, botId: String, messageId: String, payload: JSONValue) async throws -> SendResult {
        var body = payload
        if case .object(var fields) = payload { fields["client"] = .string("ios"); body = .object(fields) }
        do {
            return try await call(url, "POST", "/bots/\(botId)/messages/\(messageId)/ui-actions", token: token, body: body)
        } catch let e as APIError where e.clientRejected {
            return try await call(url, "POST", "/bots/\(botId)/messages/\(messageId)/ui-actions", token: token, body: payload)
        }
    }

    public func reportOpen(_ url: ServerURL, token: String, id: String) async throws -> JSONValue {
        try await call(url, "POST", "/reports/\(id)/open", token: token, body: EmptyBody())
    }

    public func remoteArtifact(_ url: ServerURL, token: String, id: String) async throws -> JSONValue {
        try await call(url, "POST", "/remote/artifacts/\(id)/open", token: token, body: EmptyBody())
    }

    public func remoteDesktop(_ url: ServerURL, token: String, botId: String) async throws -> JSONValue {
        try await call(url, "POST", "/remote/desktop/open", token: token, body: JSONValue.object(["bot_id": .string(botId)]))
    }

    public func cancel(_ url: ServerURL, token: String, runId: String) async throws -> Run {
        try await call(url, "POST", "/runs/\(runId)/cancel", token: token, body: EmptyBody())
    }

    public func decide(_ url: ServerURL, token: String, approvalId: String, decision: String) async throws -> Approval {
        try await call(url, "POST", "/approvals/\(approvalId)", token: token, body: DecisionBody(decision: decision))
    }

    public func authorizations(_ url: ServerURL, token: String) async throws -> [SavedAuthorization] {
        try await call(url, "GET", "/authorizations", token: token)
    }

    public func authorizationLogs(_ url: ServerURL, token: String) async throws -> [AuthorizationLog] {
        try await call(url, "GET", "/authorizations/logs", token: token)
    }

    public func revokeAuthorization(_ url: ServerURL, token: String, id: String) async throws {
        let _: JSONValue = try await call(url, "DELETE", "/authorizations/\(id)", token: token)
    }

    public func fileSources(_ url: ServerURL, token: String, botId: String) async throws -> FileSources {
        try await call(url, "GET", "/bots/\(botId)/files/sources", token: token)
    }

    public func files(_ url: ServerURL, token: String, botId: String, path: String, target: String? = nil) async throws -> FileList {
        try await call(url, "GET", "/bots/\(botId)/files", token: token, query: [("path", path)] + (target.map { [("target", $0)] } ?? []))
    }

    public func file(_ url: ServerURL, token: String, botId: String, path: String, target: String? = nil) async throws -> FileContent {
        try await call(url, "GET", "/bots/\(botId)/files/content", token: token, query: [("path", path)] + (target.map { [("target", $0)] } ?? []))
    }

    private func call<T: Decodable>(_ url: ServerURL, _ method: String, _ path: String, token: String?, query: [(String, String)] = []) async throws -> T {
        try await execute(request(url, method, path, token: token, query: query, body: nil))
    }

    private func call<T: Decodable, B: Encodable>(_ url: ServerURL, _ method: String, _ path: String, token: String?, body: B) async throws -> T {
        try await execute(request(url, method, path, token: token, query: [], body: try JSONEncoder().encode(body)))
    }

    private func request(_ url: ServerURL, _ method: String, _ path: String, token: String?, query: [(String, String)], body: Data?) throws -> URLRequest {
        var target = url.base + path
        if !query.isEmpty { target += "?" + query.map { "\(encodeQueryValue($0.0))=\(encodeQueryValue($0.1))" }.joined(separator: "&") }
        guard let address = URL(string: target) else { throw APIError(status: 0, message: "服务器地址无效") }
        var request = URLRequest(url: address)
        request.httpMethod = method
        request.timeoutInterval = 30
        if let body {
            request.httpBody = body
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        return request
    }

    private func execute<T: Decodable>(_ request: URLRequest) async throws -> T {
        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            if (error as? URLError)?.code == .cancelled || error is CancellationError { throw CancellationError() }
            throw APIError(status: 0, message: "连不上服务器，请检查网络")
        }
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            var code = (try? JSONDecoder().decode(JSONValue.self, from: data))?["error_info"]?["code"]?.stringValue
            if status == 422 && rejectsClient(data) { code = clientRejectedCode }
            throw APIError(status: status, message: errorMessage(status: status, body: data), code: code)
        }
        do {
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            throw APIError(status: status, message: "服务器返回的数据无法识别")
        }
    }
}
