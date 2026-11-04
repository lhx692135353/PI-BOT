import Foundation

/// Mirrors `packages/bot-face/spec.json`; the app bundles that file as `bot-face/spec.json`.
public struct BotSpec: Decodable, Sendable {
    public struct Defaults: Decodable, Sendable { public let shape, color, scheme, mood: String }
    public struct Face: Decodable, Sendable { public let y, gap, eye: Double }
    public struct ShapeSpec: Decodable, Sendable { public let label: String; public let points: [[Double]]; public let face: Face }
    public struct ColorSpec: Decodable, Sendable { public let label: String; public let light: [String]; public let dark: [String]; public let ink: String; public let cheek: String }
    public struct MoodSpec: Decodable, Sendable { public let label, eyes, mouth, arms, effect: String }

    public let version: Int
    public let defaults: Defaults
    public let shapes: [String: ShapeSpec]
    public let colors: [String: ColorSpec]
    public let moods: [String: MoodSpec]
    public let confetti: [String]

    public func shape(_ name: String) -> ShapeSpec { shapes[name] ?? shapes[defaults.shape]! }
    public func color(_ name: String) -> ColorSpec { colors[name] ?? colors[defaults.color]! }
    public func mood(_ name: String) -> MoodSpec { moods[name] ?? moods[defaults.mood]! }

    public static func parse(_ data: Data) throws -> BotSpec { try JSONDecoder().decode(BotSpec.self, from: data) }

    /// The copy the build places in the app bundle.
    public static func bundled(_ bundle: Bundle = .main) -> BotSpec? {
        guard let url = bundle.url(forResource: "spec", withExtension: "json", subdirectory: "bot-face"),
              let data = try? Data(contentsOf: url) else { return nil }
        return try? parse(data)
    }
}

/// Order matters: it must match `SHAPES`, `COLORS` and `MOODS` in `packages/bot-face/src/spec.ts`.
public let botShapes = ["blob", "pebble", "bean", "egg", "squircle", "cloud", "drop", "bell"]
public let botColors = ["orange", "coral", "pink", "grape", "sky", "mint", "lime", "lemon", "cocoa", "ink"]
public let botMoods = ["idle", "happy", "thinking", "working", "searching", "waiting", "celebrate", "error", "sleeping"]
public let botSchemes = ["light", "dark"]

public struct Avatar: Codable, Hashable, Sendable {
    public var shape: String
    public var color: String
    public var scheme: String

    public init(shape: String = "blob", color: String = "orange", scheme: String = "light") {
        self.shape = shape; self.color = color; self.scheme = scheme
    }

    enum CodingKeys: String, CodingKey { case shape, color, scheme }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        shape = try c.value(.shape, "blob")
        color = try c.value(.color, "orange")
        scheme = try c.value(.scheme, "light")
    }

    public func normalized() -> Avatar {
        Avatar(shape: botShapes.contains(shape) ? shape : "blob",
               color: botColors.contains(color) ? color : "orange",
               scheme: botSchemes.contains(scheme) ? scheme : "light")
    }

    public static let orange = Avatar(shape: "blob", color: "orange", scheme: "light")
}

/// Deterministic look for a seed (FNV-1a over the first UTF-16 unit of each code point), identical to `avatarFor` in TS.
public func avatarFor(_ seed: String) -> Avatar {
    var h: UInt32 = 0x811C9DC5
    for scalar in seed.unicodeScalars {
        h = (h ^ UInt32(String(scalar).utf16.first!)) &* 16777619
    }
    return Avatar(shape: botShapes[Int(h % UInt32(botShapes.count))], color: botColors[Int((h >> 8) % UInt32(botColors.count))], scheme: "light")
}

/// Stable per-bot animation seed; same value as Java's `String.hashCode` on Android.
public func seedOf(_ id: String) -> Int32 {
    var h: Int32 = 0
    for unit in id.utf16 { h = 31 &* h &+ Int32(unit) }
    return h
}
