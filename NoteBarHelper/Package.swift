// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "NoteBarHelper",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "NoteBarHelper",
            path: "Sources/NoteBarHelper",
            resources: [.copy("Resources/form.html")]
        ),
        .testTarget(
            name: "NoteBarHelperTests",
            dependencies: ["NoteBarHelper"],
            path: "Tests/NoteBarHelperTests"
        ),
    ]
)
