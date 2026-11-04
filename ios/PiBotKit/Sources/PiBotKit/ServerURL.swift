import Foundation

public struct ServerURLError: LocalizedError, Equatable {
    public let message: String
    public var errorDescription: String? { message }
}

/// Server root, possibly under a path prefix such as `https://host/pibot`.
public struct ServerURL: Hashable, Sendable {
    public let base: String

    public init(_ base: String) { self.base = base }

    public func eventsSocket(token: String) throws -> String {
        "\(try socketBase())/ws/events?token=\(formEncode(token))"
    }

    /// User-token voice socket. `callId` resumes the same call after a short disconnect.
    public func voiceSocket(token: String, botId: String, callId: String? = nil) throws -> String {
        var query = "token=\(formEncode(token))&client=ios&bot=\(formEncode(botId))"
        if let callId, !callId.isEmpty { query += "&call_id=\(formEncode(callId))" }
        return "\(try socketBase())/ws/voice?\(query)"
    }

    private func socketBase() throws -> String {
        if base.hasPrefix("https://") { return "wss://" + base.dropFirst("https://".count) }
        if base.hasPrefix("http://") { return "ws://" + base.dropFirst("http://".count) }
        throw ServerURLError(message: "服务器地址无效")
    }
}

public func parseServerURL(_ raw: String) throws -> ServerURL {
    var trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    while trimmed.hasSuffix("/") { trimmed.removeLast() }
    if trimmed.isEmpty { throw ServerURLError(message: "请填写服务器地址") }
    guard let colon = trimmed.firstIndex(of: ":"), let parts = URLComponents(string: trimmed) else {
        throw ServerURLError(message: "服务器地址无效")
    }
    let scheme = parts.scheme?.lowercased()
    guard scheme == "https" || scheme == "http" else { throw ServerURLError(message: "服务器地址需要以 http 或 https 开头") }
    guard let host = parts.host, !host.isEmpty, parts.user == nil, parts.password == nil else {
        throw ServerURLError(message: "服务器地址无效")
    }
    if parts.percentEncodedQuery != nil || parts.percentEncodedFragment != nil {
        throw ServerURLError(message: "服务器地址不能带查询参数")
    }
    return ServerURL(scheme! + trimmed[colon...])
}

/// `application/x-www-form-urlencoded` like Java's `URLEncoder`: space becomes `+`.
public func formEncode(_ value: String) -> String {
    var out = ""
    for byte in value.utf8 {
        switch byte {
        case UInt8(ascii: "a")...UInt8(ascii: "z"), UInt8(ascii: "A")...UInt8(ascii: "Z"), UInt8(ascii: "0")...UInt8(ascii: "9"),
             UInt8(ascii: "."), UInt8(ascii: "-"), UInt8(ascii: "*"), UInt8(ascii: "_"):
            out.append(Character(UnicodeScalar(byte)))
        case UInt8(ascii: " "):
            out.append("+")
        default:
            out += String(format: "%%%02X", byte)
        }
    }
    return out
}
