import SwiftUI
import SwiftData

struct ReviewView: View {
    enum Mode { case review, learn }
    let mode: Mode

    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Environment(\.modelContext) private var context
    @Query private var all: [Entry]
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var flipped = false
    @State private var drag: CGSize = .zero
    @State private var activeDirection: Direction?
    @State private var preview: String?
    @State private var undoStack: [(Entry, StudyProgress)] = []
    @Environment(\.dismiss) private var dismiss

    enum Direction: String {
        case good = "认识", again = "不认识", hard = "模糊", easy = "太简单"
    }

    private var current: Entry? { queue.indices.contains(index) ? queue[index] : nil }

    var body: some View {
        VStack(spacing: 12) {
            if let current {
                HStack {
                    Text("\(index + 1) / \(queue.count)")
                    Spacer()
                    Button("撤销") { undo() }.disabled(undoStack.isEmpty)
                }
                .font(.caption).foregroundStyle(.secondary)

                ZStack {
                    cardFace(current, back: false)
                        .opacity(flipped ? 0 : 1)
                        .rotation3DEffect(.degrees(flipped ? 180 : 0), axis: (x: 0, y: 1, z: 0))
                    cardFace(current, back: true)
                        .opacity(flipped ? 1 : 0)
                        .rotation3DEffect(.degrees(flipped ? 0 : -180), axis: (x: 0, y: 1, z: 0))
                }
                .frame(maxHeight: 420)
                .overlay(alignment: .center) {
                    if let dir = activeDirection {
                        Text(dir.rawValue)
                            .font(.title3.bold())
                            .foregroundStyle(.white)
                            .padding(.horizontal, 16).padding(.vertical, 8)
                            .background(color(for: dir), in: Capsule())
                            .allowsHitTesting(false)
                    }
                }
                .overlay {
                    RoundedRectangle(cornerRadius: 24)
                        .strokeBorder(color(for: activeDirection).opacity(activeDirection == nil ? 0 : 0.9), lineWidth: 4)
                }
                .gesture(
                    DragGesture(minimumDistance: 20)
                        .onChanged { value in
                            drag = value.translation
                            activeDirection = direction(for: drag)
                        }
                        .onEnded { value in
                            defer { drag = .zero; activeDirection = nil }
                            guard let dir = direction(for: value.translation), absMax(value.translation) > 60 else { return }
                            rate(dir)
                        }
                )
                .onTapGesture { withAnimation(.spring(duration: 0.45)) { flipped.toggle() } }

                if let preview {
                    Text("下次 \(preview)").font(.caption).foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    rateButton("不认识", .again, .red)
                    rateButton("模糊", .hard, .gray)
                    rateButton("认识", .good, .green)
                }
            } else {
                ContentUnavailableView("全部完成", systemImage: "checkmark.circle", description: Text("本轮没有更多卡片"))
                Button("返回") { dismiss() }.buttonStyle(.borderedProminent)
            }
        }
        .padding()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: buildQueue)
    }

    private func cardFace(_ entry: Entry, back: Bool) -> some View {
        VStack(spacing: 12) {
            if back {
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .multilineTextAlignment(.center)
                    .font(.title3)
                    .padding()
            } else {
                Text(entry.word)
                    .font(.system(size: 34, weight: .bold, design: .rounded))
                    .foregroundStyle(Theme.wordColor(scheme))
                Button { appState.speak(entry.word) } label: { Image(systemName: "speaker.wave.2.fill") }
                    .font(.title2)
                Text("点击翻面 · 四向滑动评分").font(.caption2).foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .glassCard()
    }

    private func rateButton(_ title: String, _ dir: Direction, _ color: Color) -> some View {
        Button { rate(dir) } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(color)
        }
    }

    private func rate(_ dir: Direction) {
        guard let entry = current else { return }
        let before = entry.progress
        let grade = grade(for: dir)
        let elapsed = entry.lastReview.flatMap { ISO8601DateFormatter().date(from: $0) }
            .map { max(0, (FSRS.startOfDay(Date()).timeIntervalSince($0) / 86400).rounded()) } ?? 0
        let result = FSRS.schedule(s: entry.s, d: entry.d, lapses: entry.lapses, elapsedDays: elapsed, grade: grade)
        var progress = before
        progress.s = result.s; progress.d = result.d; progress.lapses = result.lapses
        progress.dueDate = result.dueDate
        let now = ISO8601DateFormatter().string(from: Date())
        progress.lastReview = now
        progress.history = Merge.history(a: entry.history, b: [ReviewRecord(date: now, quality: grade.label)]) ?? entry.history
        if result.graduated { progress.lifecycle = "graduated" }
        undoStack.append((entry, before))
        entry.progress = progress
        try? context.save()
        preview = "\(result.interval) 天后"
        appState.sync.persist(book: entry.book, key: entry.studyKey, progress: progress)
        if appState.settings.autoPronounce { appState.speak(entry.word) }
        withAnimation(.spring(duration: 0.35)) { index += 1; flipped = false; preview = nil }
    }

    private func undo() {
        guard let (entry, progress) = undoStack.popLast() else { return }
        entry.progress = progress
        try? context.save()
        index = max(0, index - 1)
    }

    private func buildQueue() {
        let today = FSRS.dayString(Date())
        let limit = mode == .review ? appState.settings.dailyReviewLimit : appState.settings.dailyNewWordLimit
        let active = all.filter { !["graduated", "archived", "retired"].contains($0.lifecycle ?? "") }
        switch mode {
        case .review:
            queue = active.filter { ($0.dueDate ?? "") <= today }.sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
        case .learn:
            queue = active.filter { $0.s == nil }
        }
        queue = Array(queue.prefix(limit))
    }

    private func direction(for size: CGSize) -> Direction? {
        if abs(size.width) < 20 && abs(size.height) < 20 { return nil }
        if abs(size.width) >= abs(size.height) { return size.width < 0 ? .good : .again }
        return size.height < 0 ? .easy : .hard
    }

    private func absMax(_ size: CGSize) -> CGFloat { max(abs(size.width), abs(size.height)) }

    private func color(for dir: Direction?) -> Color {
        switch dir {
        case .good: return Theme.goodGreen
        case .again: return Theme.againRed
        case .hard: return Theme.hardGray
        case .easy: return Theme.easyOrange
        case nil: return .clear
        }
    }

    private func grade(for dir: Direction) -> FSRSGrade {
        switch dir {
        case .again: return .again
        case .hard: return .hard
        case .good: return .good
        case .easy: return .easy
        }
    }
}

extension FSRSGrade {
    var label: String {
        switch self {
        case .again: return "again"
        case .hard: return "hard"
        case .good: return "good"
        case .easy: return "easy"
        }
    }
}
