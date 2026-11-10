import Foundation

/// Recent history per account and bot, so a conversation opens before the network answers.
public protocol TimelineStore: Sendable {
    func read(userId: String, botId: String) -> Timeline?
    func write(userId: String, botId: String, timeline: Timeline)
    func clear(userId: String)
}

private struct CachedTimeline: Codable {
    var messages: [Message]
    var hasMore: Bool
}

/// Only the newest messages are kept; older pages come from the server on scroll.
public final class FileTimelineCache: TimelineStore {
    private let root: URL
    private let limit: Int

    public init(root: URL = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0].appendingPathComponent("timelines", isDirectory: true), limit: Int = 60) {
        self.root = root; self.limit = limit
    }

    private func directory(_ userId: String) -> URL { root.appendingPathComponent(safe(userId), isDirectory: true) }
    private func file(_ userId: String, _ botId: String) -> URL { directory(userId).appendingPathComponent("\(safe(botId)).json") }

    public func read(userId: String, botId: String) -> Timeline? {
        guard let data = try? Data(contentsOf: file(userId, botId)),
              let cached = try? JSONDecoder().decode(CachedTimeline.self, from: data), !cached.messages.isEmpty else { return nil }
        return Timeline(messages: cached.messages.sorted { $0.seq < $1.seq }, hasMore: cached.hasMore)
    }

    public func write(userId: String, botId: String, timeline: Timeline) {
        let messages = Array(timeline.messages.suffix(limit))
        guard !messages.isEmpty else { return }
        let cached = CachedTimeline(messages: messages, hasMore: timeline.hasMore || messages.count < timeline.messages.count)
        guard let data = try? JSONEncoder().encode(cached) else { return }
        try? FileManager.default.createDirectory(at: directory(userId), withIntermediateDirectories: true)
        try? data.write(to: file(userId, botId), options: .atomic)
    }

    public func clear(userId: String) {
        try? FileManager.default.removeItem(at: directory(userId))
    }

    private func safe(_ id: String) -> String {
        String(id.map { $0.isLetter || $0.isNumber || $0 == "-" || $0 == "_" ? $0 : "_" })
    }
}
