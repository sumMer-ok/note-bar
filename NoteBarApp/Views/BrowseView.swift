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
    @State private var editingModule: DefinitionModule?

    var body: some View {
        VStack(spacing: 16) {
            if let current {
                Text("来自 · \(current.book)")
                    .font(.caption)
                    .foregroundStyle(.secondary)

                FlipView(
                    progress: flipped ? 1 : 0,
                    front: face(current, back: false),
                    back: face(current, back: true)
                )
                .animation(.easeInOut(duration: 0.45), value: flipped)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
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
        .sheet(item: $editingModule) { module in
            if let current {
                WordEditSheet(entry: current, focusModule: module)
            }
        }
    }

    private func face(_ entry: Entry, back: Bool) -> some View {
        VStack(spacing: 14) {
            if back {
                ScrollView {
                    VStack(spacing: 12) {
                        Text(entry.word)
                            .font(.title.bold())
                            .foregroundStyle(Theme.wordColor(scheme))
                        if let phonetic = PhoneticExtractor.phonetic(from: entry.definition) {
                            Button { appState.speak(entry.word) } label: {
                                HStack(spacing: 5) {
                                    Text(phonetic).foregroundStyle(.secondary)
                                    Image(systemName: "speaker.wave.2.fill")
                                }
                                .font(.subheadline)
                            }
                            .buttonStyle(.plain)
                        }
                        DefinitionModulesView(raw: entry.definition, order: appState.settings.definitionOrder) { module in
                            editingModule = module
                        }
                    }
                    .padding()
                }
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
