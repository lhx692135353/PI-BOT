// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "PiBotKit",
    defaultLocalization: "zh-Hans",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "PiBotKit", targets: ["PiBotKit"]),
    ],
    targets: [
        .target(name: "PiBotKit"),
        .testTarget(name: "PiBotKitTests", dependencies: ["PiBotKit"]),
    ]
)
