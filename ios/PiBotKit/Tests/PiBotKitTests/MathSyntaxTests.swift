import XCTest
@testable import PiBotKit

final class MathSyntaxTests: XCTestCase {
    func testSharedRoutingFixtures() throws {
        var root = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 { root.deleteLastPathComponent() }
        struct Fixture: Decodable { let source: String; let math: Bool }
        let data = try Data(contentsOf: root.appendingPathComponent("packages/markdown/fixtures/routing.json"))
        for fixture in try JSONDecoder().decode([Fixture].self, from: data) {
            XCTAssertEqual(containsMath(fixture.source), fixture.math, fixture.source)
        }
    }
}
