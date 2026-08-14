import SwiftUI
import SwiftData

/// 慢游：随机浏览任意词库的单词，不评分、不改进度
struct BrowseView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Query private var all: [Entry]
    @State private var current: Entry?
    @State private var flipped = false
    @State private var history: [Entry] = []

    var body: some View {
        VStack(spacing: 16) {
            if let current {
                Text("来自 · \(current.book)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                ZStack {
                    face(current, back: false)
                        .opacity(flipped ? 0 : 1)
                        .rotation3DEffect(.degrees(flipped ? 180 : 0), axis: (x: 0, y: 1, z: 0))
                    face(current, back: true)
                        .opacity(flipped ? 1 : 0)
                        .rotation3DEffect(.degrees(flipped ? 0 : -180), axis: (x: 0, y: 1, z: 0))
                }
                .frame(maxHeight: 460)
                .onTapGesture { withAnimation(.spring(duration: 0.45)) { flipped.toggle() } }

                HStack {
                    Button {
                        previous()
                    } label: {
                        Label("上一个", systemImage: "chevron.left")
                    }
                    .disabled(history.isEmpty)
                    Spacer()
                    Button {
                        next()
                    } label: {
                        Label("下一个", systemImage: "shuffle")
                    }
                }
                .buttonStyle(.bordered)
            } else {
                ContentUnavailableView("词库为空", systemImage: "tray", description: Text("先去添加一些单词吧"))
            }
        }
        .padding()
        .navigationTitle("慢游")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if current == nil { next() }
        }
    }

    private func face(_ entry: Entry, back: Bool) -> some View {
        VStack(spacing: 14) {
            if back {
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .multilineTextAlignment(.center)
                    .font(.title3)
                    .padding()
            } else {
                Text(entry.word)
                    .font(.system(size: 38, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.wordColor(scheme))
                Button { appState.speak(entry.word) } label: {
                    Image(systemName: "speaker.wave.2.fill").font(.title2)
                }
                Text("点击翻面").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .glassCard()
    }

    private func next() {
        let pool = all.filter { $0.studyKey != current?.studyKey }
        guard let picked = pool.randomElement() ?? all.randomElement() else { return }
        if let current { history.append(current) }
        current = picked
        flipped = false
    }

    private func previous() {
        guard let last = history.popLast() else { return }
        current = last
        flipped = false
    }
}
