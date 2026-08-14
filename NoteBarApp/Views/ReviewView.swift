import SwiftUI
import SwiftData

struct ReviewView: View {
    enum Mode { case review, learn }
    let mode: Mode
    var books: Set<String> = []

    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Environment(\.modelContext) private var context
    @Query private var all: [Entry]
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var flipped = false
    @State private var dragOffset: CGSize = .zero
    @State private var isFlying = false
    @State private var activeDirection: Direction?
    @State private var preview: String?
    @State private var undoStack: [(Entry, StudyProgress)] = []
    @State private var editingModule: DefinitionModule?
    @Environment(\.dismiss) private var dismiss

    private let swipeThreshold: CGFloat = 120

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

                FlipView(
                    progress: flipped ? 1 : 0,
                    front: cardFace(current, back: false),
                    back: cardFace(current, back: true)
                )
                .animation(.easeInOut(duration: 0.45), value: flipped)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .offset(x: dragOffset.width, y: dragOffset.height)
                .rotationEffect(.degrees(Double(dragOffset.width / 24)))
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
                    DragGesture(minimumDistance: 8)
                        .onChanged { value in
                            guard !isFlying else { return }
                            dragOffset = value.translation
                            activeDirection = direction(for: value.translation)
                        }
                        .onEnded { value in
                            guard !isFlying else { return }
                            let dir = direction(for: value.translation)
                            guard let dir, absMax(value.translation) > swipeThreshold else {
                                withAnimation(.spring(duration: 0.35)) {
                                    dragOffset = .zero
                                    activeDirection = nil
                                }
                                return
                            }
                            // 先完全飞出屏幕，动画结束后才触发评分
                            isFlying = true
                            activeDirection = dir
                            withAnimation(.easeOut(duration: 0.28)) {
                                dragOffset = flyOffset(for: dir, from: value.translation)
                            }
                            DispatchQueue.main.asyncAfter(deadline: .now() + 0.28) {
                                rate(dir)
                                dragOffset = .zero
                                activeDirection = nil
                                isFlying = false
                            }
                        }
                )
                .onTapGesture {
                    guard !isFlying else { return }
                    withAnimation(.spring(duration: 0.45)) { flipped.toggle() }
                }

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
        .sheet(item: $editingModule) { module in
            if let entry = current {
                WordEditSheet(entry: entry, focusModule: module)
            }
        }
    }

    private func cardFace(_ entry: Entry, back: Bool) -> some View {
        VStack(spacing: 12) {
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
        Button {
            guard !isFlying else { return }
            rate(dir)
        } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(color)
        }
    }

    private func rate(_ dir: Direction) {
        guard let entry = current else { return }
        let before = entry.progress
        let isNewWord = entry.s == nil
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
        if isNewWord, entry.firstLearnedDate == nil {
            entry.firstLearnedDate = FSRS.dayString(Date())
        }
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
        let scope = books.isEmpty ? all : all.filter { books.contains($0.book) }
        let active = scope.filter { !["graduated", "archived", "retired"].contains($0.lifecycle ?? "") }
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
        if abs(size.width) >= abs(size.height) { return size.width < 0 ? .again : .good }
        return size.height < 0 ? .easy : .hard
    }

    private func absMax(_ size: CGSize) -> CGFloat { max(abs(size.width), abs(size.height)) }

    private func flyOffset(for dir: Direction, from translation: CGSize) -> CGSize {
        let screenW = UIScreen.main.bounds.width
        let screenH = UIScreen.main.bounds.height
        switch dir {
        case .again: return CGSize(width: -screenW * 1.3, height: translation.height)
        case .good: return CGSize(width: screenW * 1.3, height: translation.height)
        case .easy: return CGSize(width: translation.width, height: -screenH * 1.3)
        case .hard: return CGSize(width: translation.width, height: screenH * 1.3)
        }
    }

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

/// 双面卡片翻转：旋转进度过半（90°）时精确切换正反面，避免两层同时可见产生残影
struct FlipView<Front: View, Back: View>: View, Animatable {
    var progress: Double // 0 = 正面，1 = 背面
    let front: Front
    let back: Back

    var animatableData: Double {
        get { progress }
        set { progress = newValue }
    }

    var body: some View {
        ZStack {
            back
                .rotation3DEffect(.degrees(-180 + progress * 180), axis: (x: 0, y: 1, z: 0))
                .opacity(progress > 0.5 ? 1 : 0)
            front
                .rotation3DEffect(.degrees(progress * 180), axis: (x: 0, y: 1, z: 0))
                .opacity(progress < 0.5 ? 1 : 0)
        }
    }
}
