import Foundation
import Security

/// Signed-in session: server URL, bearer token and user. Passwords are never stored.
public struct Session: Codable, Hashable, Sendable {
    public var serverUrl: String
    public var token: String
    /// Epoch milliseconds.
    public var expiresAt: Int64
    public var user: User

    public init(serverUrl: String, token: String, expiresAt: Int64, user: User) {
        self.serverUrl = serverUrl; self.token = token; self.expiresAt = expiresAt; self.user = user
    }

    public var url: ServerURL { ServerURL(serverUrl) }
}

public protocol SessionStorage: AnyObject {
    func load() -> Session?
    func save(_ session: Session)
    func clear()
    func lastServerUrl() -> String?
}

/// Token and user in the Keychain (this device only); the last server address in user defaults.
public final class KeychainSessionStore: SessionStorage {
    private let service: String
    private let account = "session"
    private let defaults: UserDefaults
    private let urlKey = "pibot.server_url"

    public init(service: String = "dev.pibot.ios.session", defaults: UserDefaults = .standard) {
        self.service = service
        self.defaults = defaults
    }

    public func load() -> Session? {
        var query = baseQuery()
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess, let data = item as? Data,
              let session = try? JSONDecoder().decode(Session.self, from: data) else { return nil }
        if session.expiresAt <= nowMillis() + 60_000 { return nil }
        return session
    }

    public func save(_ session: Session) {
        defaults.set(session.serverUrl, forKey: urlKey)
        guard let data = try? JSONEncoder().encode(session) else { return }
        SecItemDelete(baseQuery() as CFDictionary)
        var item = baseQuery()
        item[kSecValueData as String] = data
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        SecItemAdd(item as CFDictionary, nil)
    }

    public func clear() { SecItemDelete(baseQuery() as CFDictionary) }

    public func lastServerUrl() -> String? { defaults.string(forKey: urlKey) }

    private func baseQuery() -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: account]
    }
}
