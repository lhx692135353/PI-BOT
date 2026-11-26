import Foundation

/// The initial history request is separate from sending and older-page errors.
public struct HistoryLoadState: Equatable, Sendable {
    public private(set) var requestID: UUID?
    public private(set) var showsSkeleton = false
    public private(set) var isSlow = false
    public private(set) var error: String?
    public var isLoading: Bool { requestID != nil }

    public init() {}

    @discardableResult public mutating func begin() -> UUID {
        let id = UUID()
        requestID = id
        showsSkeleton = false
        isSlow = false
        error = nil
        return id
    }

    public mutating func reveal(_ id: UUID) {
        guard requestID == id else { return }
        showsSkeleton = true
    }

    public mutating func markSlow(_ id: UUID) {
        guard requestID == id else { return }
        isSlow = true
    }

    public mutating func finish(_ id: UUID, error: String? = nil) {
        guard requestID == id else { return }
        requestID = nil
        showsSkeleton = false
        isSlow = false
        self.error = error
    }
}
