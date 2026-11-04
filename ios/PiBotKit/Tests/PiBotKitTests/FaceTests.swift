import XCTest
@testable import PiBotKit

let specURL = URL(fileURLWithPath: #filePath)
    .deletingLastPathComponent().appendingPathComponent("../../../../packages/bot-face/spec.json").standardized

/// Reference values come from the TypeScript implementation in `packages/bot-face`.
final class FaceTests: XCTestCase {
    private var spec: BotSpec!
    private let eps = 1e-9

    override func setUpWithError() throws {
        spec = try BotSpec.parse(Data(contentsOf: specURL))
    }

    func testSpecMatchesTheSharedLists() throws {
        XCTAssertEqual(spec.version, 1)
        let text = try String(contentsOf: specURL, encoding: .utf8)
        func ordered(_ names: [String]) -> Bool {
            let positions = names.map { text.range(of: "\"\($0)\": {")?.lowerBound }
            return positions.allSatisfy { $0 != nil } && zip(positions, positions.dropFirst()).allSatisfy { $0! < $1! }
        }
        XCTAssertEqual(Set(spec.shapes.keys), Set(botShapes))
        XCTAssertEqual(Set(spec.colors.keys), Set(botColors))
        XCTAssertEqual(Set(spec.moods.keys), Set(botMoods))
        XCTAssertTrue(ordered(botShapes) && ordered(botColors) && ordered(botMoods))
        for shape in spec.shapes.values { XCTAssertTrue(shape.points.count >= 8 && shape.points.allSatisfy { $0.count == 2 }) }
        for color in spec.colors.values { XCTAssertTrue(color.light.count == 2 && color.dark.count == 2) }
        XCTAssertFalse(spec.confetti.isEmpty)
    }

    func testMulberry32MatchesTypeScript() {
        var r = Mulberry32(seed: 42)
        for value in [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423] {
            XCTAssertEqual(r.next(), value)
        }
        var negative = Mulberry32(seed: -7)
        XCTAssertEqual(negative.next(), 0.43306733411736786)
        XCTAssertEqual(negative.next(), 0.32539576734416187)
    }

    func testAvatarForMatchesTypeScript() {
        XCTAssertEqual(avatarFor("00000000-0000-0000-0000-000000000000"), Avatar(shape: "pebble", color: "cocoa"))
        XCTAssertEqual(avatarFor("3f2b6c1e-9a4d-4e8b-b1a2-7c9d0e1f2a3b"), Avatar(shape: "egg", color: "sky"))
        XCTAssertEqual(avatarFor("研究助理"), Avatar(shape: "squircle", color: "sky"))
        XCTAssertEqual(Avatar(shape: "triangle", color: "neon", scheme: "sepia").normalized(), Avatar.orange)
    }

    func testSeedMatchesJavaHashCode() {
        XCTAssertEqual(seedOf(""), 0)
        XCTAssertEqual(seedOf("welcome"), 1233099618)
        XCTAssertEqual(seedOf("00000000-0000-0000-0000-000000000000"), 1428967488)
    }

    func testOutlineMatchesTypeScript() {
        let o = smoothOutline(spec.shape("blob").points)
        XCTAssertEqual(o.segments.count, 12)
        let first = o.segments[0]
        XCTAssertEqual(first.c1.x, 0.15, accuracy: eps); XCTAssertEqual(first.c1.y, -0.85, accuracy: eps)
        XCTAssertEqual(first.c2.x, 0.33, accuracy: eps); XCTAssertEqual(first.c2.y, -0.8283333333333334, accuracy: eps)
        XCTAssertEqual(first.end.x, 0.45, accuracy: eps); XCTAssertEqual(first.end.y, -0.75, accuracy: eps)
        let last = o.segments[11]
        XCTAssertEqual(last.c1.x, -0.33, accuracy: eps); XCTAssertEqual(last.end.x, 0, accuracy: eps); XCTAssertEqual(last.end.y, -0.85, accuracy: eps)
    }

    func testEngineFramesMatchTypeScript() {
        let e = BotEngine(spec: spec, mood: "idle", seed: 7)
        for _ in 0..<30 { e.step(1.0 / 60) }
        e.setMood("celebrate")
        for _ in 0..<90 { e.step(1.0 / 60) }
        let f = e.frame()
        XCTAssertEqual(f.t, 1.9999999999999978, accuracy: eps)
        XCTAssertEqual(f.blink, 0, accuracy: eps)
        XCTAssertEqual(f.gazeX, 0.11200371216902492, accuracy: eps)
        XCTAssertEqual(f.gazeY, 0.03245360515907288, accuracy: eps)
        XCTAssertEqual(f.scaleX, 0.9826797127457848, accuracy: eps)
        XCTAssertEqual(f.scaleY, 1.0173201400398995, accuracy: eps)
        XCTAssertEqual(f.offsetY, -0.06999943162719986, accuracy: eps)
        XCTAssertEqual(f.particles.count, 32)
        let p = f.particles[0]
        XCTAssertEqual(p.x, 0.49412557905386495, accuracy: eps)
        XCTAssertEqual(p.y, -1.9354102182212343, accuracy: eps)
        XCTAssertEqual(p.rotation, 5.076956534321522, accuracy: eps)
        XCTAssertEqual(p.maxLife, 1.5093786732293664, accuracy: eps)
        XCTAssertEqual(p.color, 1)

        let look = BotEngine(spec: spec, mood: "idle", seed: 3)
        look.look(2.0, -0.5)
        for _ in 0..<120 { look.step(1.0 / 60) }
        XCTAssertEqual(look.frame().gazeX, 1.0, accuracy: eps)
        XCTAssertEqual(look.frame().gazeY, -0.5000007718850202, accuracy: eps)
    }

    func testReduceMotionKeepsTheBotStill() {
        let e = BotEngine(spec: spec, mood: "idle", seed: 1, reduceMotion: true)
        e.setMood("celebrate")
        for _ in 0..<60 { e.step(1.0 / 60) }
        let f = e.frame()
        XCTAssertTrue(f.particles.isEmpty)
        XCTAssertEqual(f.scaleX, 1, accuracy: eps)
        XCTAssertEqual(f.offsetY, 0, accuracy: eps)
    }

    func testMoodMappingMatchesTypeScript() {
        let now: Int64 = 10_000_000_000
        XCTAssertEqual(moodFor(status: "queued", now: now), "thinking")
        XCTAssertEqual(moodFor(status: "running", now: now), "thinking")
        XCTAssertEqual(moodFor(status: "running", tool: "web_search", now: now), "searching")
        XCTAssertEqual(moodFor(status: "running", tool: "run_command", now: now), "working")
        XCTAssertEqual(moodFor(status: "waiting_approval", now: now), "waiting")
        XCTAssertEqual(moodFor(status: "completed", finishedAt: now - 1_000, now: now), "celebrate")
        XCTAssertEqual(moodFor(status: "completed", finishedAt: now - 60_000, lastActiveAt: now - 60_000, now: now), "idle")
        XCTAssertEqual(moodFor(status: "failed", finishedAt: now - 1_000, now: now), "error")
        XCTAssertEqual(moodFor(status: "completed", finishedAt: now - 8 * 86_400_000, lastActiveAt: now - 7 * 86_400_000 - 1, now: now), "sleeping")
        XCTAssertEqual(sleepLabel(now - 7 * 86_400_000 - 5, now: now), "7 天")
        XCTAssertNil(sleepLabel(now - 3_600_000, now: now))
    }
}
