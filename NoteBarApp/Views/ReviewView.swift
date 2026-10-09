import SwiftUI
import SwiftData

struct ReviewView: View {
    enum Mode { case review, learn }
    let mode: Mode
    var books: Set<String> = []
    /// 中途退出强化后从草稿恢复时传入；正常进入为 nil
    var resumeDraft: ReinforceDraft? = nil

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
    @State private var usedKeys: Set<String> = []
    @Environment(\.dismiss) private var dismiss

    // MARK: - 本组不熟词强化（步骤二～五）

    /// 强化环节会话；nil = 不在强化环节（正常学习/复习中，或本组已结束）
    @State private var reinforce: ReinforceSession<String>?
    /// 正常学习阶段被标记「不认识」的词，顺序 = 作答顺序；仅内存记录，不写复习进度
    @State private var weakKeys: [String] = []
    /// 强化环节按 studyKey 取词（进入强化时一次性建好，避免每次渲染遍历全库）
    @State private var reinforceEntries: [String: Entry] = [:]
    /// 强化通过后的统计，用于结束页展示
    @State private var reinforceSummary: ReinforceSummary?
    @State private var showStuckAlert = false
    @State private var showLimitAlert = false

    private let swipeThreshold: CGFloat = 120

    enum Direction: String {
        case good = "认识", again = "不认识", hard = "模糊", easy = "太简单"
    }

    private var current: Entry? { queue.indices.contains(index) ? queue[index] : nil }

    /// 是否处于「本组不熟词强化」环节
    private var isReinforcing: Bool { reinforce != nil }

    /// 当前应呈现的卡片：强化环节取会话当前词，其余取正常队列当前项
    private var activeCard: Entry? {
        if let session = reinforce {
            guard let key = session.current else { return nil }
            return reinforceEntries[key]
        }
        return current
    }

    var body: some View {
        VStack(spacing: 12) {
            if let session = reinforce {
                if let entry = activeCard {
                    reinforceHeader(session, entry: entry)
                    card(entry)
                    Text("强化环节的判定只用于本环节循环，不写入复习进度")
                        .font(.caption2).foregroundStyle(.tertiary)
                    HStack(spacing: 8) {
                        reinforceButton("不认识", known: false, color: Theme.againRed)
                        reinforceButton("认识", known: true, color: Theme.goodGreen)
                    }
                } else {
                    endContent
                }
            } else if let current {
                HStack {
                    Text("\(index + 1) / \(queue.count)")
                    Spacer()
                    Button("撤销") { undo() }.disabled(undoStack.isEmpty)
                }
                .font(.caption).foregroundStyle(.secondary)

                card(current)

                if let preview {
                    Text("下次 \(preview)").font(.caption).foregroundStyle(.secondary)
                }

                HStack(spacing: 8) {
                    rateButton("不认识", .again, .red)
                    rateButton("模糊", .hard, .gray)
                    rateButton("认识", .good, .green)
                }
            } else {
                endContent
            }
        }
        .padding()
        .navigationBarTitleDisplayMode(.inline)
        .onAppear(perform: onAppear)
        .task(id: pronunciationID) {
            guard let card = activeCard, appState.settings.autoPronounce else { return }
            try? await Task.sleep(for: .milliseconds(150))
            appState.speak(card.word)
        }
        .sheet(item: $editingModule) { module in
            if let entry = activeCard {
                WordEditSheet(entry: entry, focusModule: module)
            }
        }
        .alert("这个词已连续答错 \(ReinforceSession<String>.stuckThreshold) 次", isPresented: $showStuckAlert) {
            Button("看释义再判一次") { flipped = true }
            Button("标记为认识并移出") { passCurrentWordManually() }
        } message: {
            Text("强化环节的判定不会影响复习进度，可以放心多练几轮。")
        }
        .alert("强化已暂停", isPresented: $showLimitAlert) {
            Button("继续强化") { continueAfterLimit() }
            Button("结束强化", role: .cancel) { exitReinforce() }
        } message: {
            Text("本组已作答 \(reinforce?.totalAnswers ?? 0) 次仍未全部通过。先退出、下次继续也可以。")
        }
        .onDisappear(perform: persistDraftIfNeeded)
    }

    /// 触发发音用的标识：强化环节同一词会在多轮重复出现，需带上作答次数才能每轮都发音
    private var pronunciationID: String {
        guard let session = reinforce else { return current?.studyKey ?? "" }
        return "\(session.current ?? "")#\(session.totalAnswers)"
    }

    /// 卡片本体（正常学习与强化环节共用）
    private func card(_ entry: Entry) -> some View {
        FlipView(
            progress: flipped ? 1 : 0,
            front: cardFace(entry, back: false),
            back: cardFace(entry, back: true)
        )
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
                    // 先完全飞出屏幕，等飞出动画结束后再评分并显示下一张
                    isFlying = true
                    activeDirection = dir
                    withAnimation(.easeOut(duration: 0.38)) {
                        dragOffset = flyOffset(for: dir, from: value.translation)
                    }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.38) {
                        submit(dir)
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
    }

    /// 强化环节的进度条：轮次、本轮剩余、本词第几次出现
    private func reinforceHeader(_ session: ReinforceSession<String>, entry: Entry) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text("不熟词强化 · 第 \(session.round) 轮 · 本轮剩 \(session.roundRemainingCount) 词")
                Text("本词第 \(session.seenCount(of: entry.studyKey)) 次出现 · 共 \(session.seed.count) 个不熟词")
            }
            Spacer()
            Button("退出强化") { exitReinforce() }
        }
        .font(.caption).foregroundStyle(.secondary)
    }

    /// 强化环节只有「认识 / 不认识」两个选项
    private func reinforceButton(_ title: String, known: Bool, color: Color) -> some View {
        Button {
            guard !isFlying else { return }
            isFlying = true
            answerReinforce(known: known)
            isFlying = false
        } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(color)
        }
    }

    /// 本组结束页（强化通过后回到这里，符合「回到学习结果页或原流程」）
    private var endContent: some View {
        VStack(spacing: 20) {
            ContentUnavailableView("本组完成", systemImage: "checkmark.circle", description: Text("本轮卡片已全部完成"))
            if let summary = reinforceSummary {
                VStack(spacing: 4) {
                    Text("不熟词强化已通过：\(summary.wordCount) 词 · \(summary.totalAnswers) 次作答 · \(summary.rounds) 轮")
                    if !summary.hardestWords.isEmpty {
                        Text("反复最多次：\(summary.hardestWords.joined(separator: "、"))")
                    }
                }
                .font(.caption).foregroundStyle(.secondary)
            }
            HStack(spacing: 12) {
                Button {
                    dismiss()
                } label: {
                    Text("完成本组")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.borderedProminent)
                Button {
                    startAnotherGroup()
                } label: {
                    Text("再学一组")
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 10)
                }
                .buttonStyle(.bordered)
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
                                HStack(spacing: 8) {
                                    Text(phonetic)
                                        .font(.title3)
                                        .foregroundStyle(.secondary)
                                    Image(systemName: "speaker.wave.2.fill")
                                        .font(.system(size: 22, weight: .medium))
                                        .foregroundStyle(.blue)
                                        .frame(width: 44, height: 44)
                                        .background(Circle().fill(.blue.opacity(0.12)))
                                }
                                .contentShape(Rectangle())
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
            isFlying = true
            submit(dir)
            isFlying = false
        } label: {
            Text(title).frame(maxWidth: .infinity).padding(.vertical, 12)
                .background(color.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                .foregroundStyle(color)
        }
    }

    /// 作答统一入口：
    /// - 正常学习/复习阶段：走 FSRS 评分并写入复习进度（既有行为，不改）；
    /// - 强化环节：只推进内存循环队列，绝不写复习进度（步骤五）。
    private func submit(_ dir: Direction) {
        if isReinforcing {
            answerReinforce(known: dir == .good || dir == .easy)
            return
        }
        rate(dir)
        advance()
    }

    private func rate(_ dir: Direction) {
        guard let entry = current else { return }

        // 步骤一：学习阶段记录被标记「不认识」的词（顺序 = 作答顺序）。
        // 这里只记在内存里，作为强化环节的输入；学习阶段本身的评分仍按既有逻辑写入进度。
        if mode == .learn, dir == .again, !weakKeys.contains(entry.studyKey) {
            weakKeys.append(entry.studyKey)
        }

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
        if result.graduated {
            // 与桌面插件一致：稳定度达到阈值后同时写 lifecycle 和 status，
            // 否则电脑端永远不会把该词显示为「已掌握」。
            progress.lifecycle = "graduated"
            progress.status = "mastered"
            if progress.masteredAt == nil { progress.masteredAt = now }
        }
        if entry.firstLearnedDate == nil {
            entry.firstLearnedDate = FSRS.dayString(Date())
        }
        undoStack.append((entry, before))
        entry.progress = progress
        try? context.save()
        preview = "\(result.interval) 天后"
        appState.sync.persist(book: entry.book, key: entry.studyKey, progress: progress)
    }

    private func advance() {
        index += 1
        flipped = false
        preview = nil
        // 本组正常阶段已走完（步骤一结束）→ 若不熟词集合非空则自动进入强化环节（步骤二）
        maybeStartReinforce()
    }

    private func undo() {
        guard let (entry, progress) = undoStack.popLast() else { return }
        entry.progress = progress
        try? context.save()
        index = max(0, index - 1)
        flipped = false
        preview = nil
    }

    /// 进入页面：带草稿进来则直接恢复强化环节（中途退出后继续），否则照常建组
    private func onAppear() {
        if let draft = resumeDraft {
            restoreReinforce(from: draft)
        } else {
            buildQueue()
        }
    }

    private func buildQueue(excluding excluded: Set<String> = []) {
        // 新建一组时清空上一组强化环节的残留状态
        reinforce = nil
        reinforceEntries = [:]
        weakKeys = []
        reinforceSummary = nil
        flipped = false
        preview = nil

        let today = FSRS.dayString(Date())
        let limit = mode == .review ? appState.settings.dailyReviewLimit : appState.settings.dailyNewWordLimit
        let scope = books.isEmpty ? all : all.filter { books.contains($0.book) }
        var candidates = scope.filter { entry in
            !excluded.contains(entry.studyKey)
                && !StudyQueue.isMastered(entry)
        }
        switch mode {
        case .review:
            candidates = candidates
                .filter { StudyQueue.isReviewable($0, today: today) }
                .sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
        case .learn:
            candidates = candidates.filter { StudyQueue.isLearnable($0) }
        }
        if candidates.isEmpty && !excluded.isEmpty {
            // 没有剩余新词时，退化为允许重复当前组
            candidates = scope.filter { entry in
                !StudyQueue.isMastered(entry)
            }
            switch mode {
            case .review:
                candidates = candidates
                    .filter { StudyQueue.isReviewable($0, today: today) }
                    .sorted { ($0.dueDate ?? "") < ($1.dueDate ?? "") }
            case .learn:
                candidates = candidates.filter { StudyQueue.isLearnable($0) }
            }
        }
        queue = Array(candidates.prefix(limit))
        usedKeys = Set(queue.map(\.studyKey))
        index = 0
        flipped = false
        preview = nil
    }

    private func startAnotherGroup() {
        buildQueue(excluding: usedKeys)
    }

    // MARK: - 本组不熟词强化

    /// studyKey → Entry 索引，进入强化时建一次
    private func makeEntryIndex() -> [String: Entry] {
        Dictionary(all.map { ($0.studyKey, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// 步骤二：正常阶段学完本组后，不熟词集合非空则自动进入强化环节。
    /// 集合为空（例如 20 个全认识）→ 什么都不做，直接停在结束页。
    /// 仅学习模式触发；复习模式判定「不认识」由 FSRS 调度负责，不叠加强化环节。
    private func maybeStartReinforce() {
        guard mode == .learn, reinforce == nil, index >= queue.count else { return }

        // 过滤掉词库里已被删除 / 取不到的词，避免强化环节卡在一张取不到的卡片上
        let entryIndex = makeEntryIndex()
        let usable = weakKeys.filter { entryIndex[$0] != nil }
        guard !usable.isEmpty else { return }

        reinforceEntries = entryIndex
        weakKeys = usable
        reinforce = ReinforceSession<String>(weakWords: usable, books: Array(books))
        flipped = false
        preview = nil
        persistDraft()
    }

    /// 中途退出后从草稿恢复强化环节
    private func restoreReinforce(from draft: ReinforceDraft) {
        guard let session = ReinforceSession<String>(resuming: draft) else {
            // 草稿已无待办（队列为空）→ 清掉它，回到正常流程
            appState.clearReinforceDraft()
            buildQueue()
            return
        }
        reinforceEntries = makeEntryIndex()
        weakKeys = draft.weakKeys
        reinforce = session
        flipped = false
        preview = nil
    }

    /// 强化环节作答。
    ///
    /// 红线（步骤五）：本方法只修改内存中的强化会话，不调用 `rate()`、不写 SwiftData、
    /// 不调用 `sync.persist`，因此 `s / d / lapses / dueDate / lastReview / history /
    /// lifecycle / status / masteredAt` 等复习进度字段完全不受强化判定影响。
    private func answerReinforce(known: Bool) {
        guard var session = reinforce else { return }
        let feedback = session.answer(known ? .known : .unknown)
        reinforce = session

        switch feedback.kind {
        case .finished:
            finishReinforce(session)
        case .limitReached:
            showLimitAlert = true
        case .stuck:
            // 连续答错先给释义，帮助回忆；队列不变
            flipped = true
            showStuckAlert = true
        case .advanced:
            flipped = false
        }

        if reinforce != nil { persistDraft() }
    }

    /// 步骤四：全部标记为「认识」→ 记录统计、清空草稿，回到本组结束页
    private func finishReinforce(_ session: ReinforceSession<String>) {
        reinforceSummary = session.summary
        reinforce = nil
        reinforceEntries = [:]
        weakKeys = []
        flipped = false
        appState.clearReinforceDraft()
    }

    /// 中途退出强化：保留草稿以便下次继续；已经写入的复习进度保持原样
    private func exitReinforce() {
        persistDraft()
        dismiss()
    }

    /// 用户在「卡住了」提示里选择手动放行：把当前词移出本环节队列（不写进度）
    private func passCurrentWordManually() {
        guard var session = reinforce, let key = session.current else { return }
        session.passManually(key)
        reinforce = session
        flipped = false
        if session.isFinished {
            finishReinforce(session)
        } else {
            persistDraft()
        }
    }

    /// 触及安全上限后选择「继续强化」：追加一批作答额度并解除暂停
    private func continueAfterLimit() {
        guard var session = reinforce else { return }
        session.extendAnswerLimit()
        reinforce = session
        persistDraft()
    }

    /// 保存强化草稿：只包含本环节的循环判定状态，与复习进度字段无交集
    private func persistDraft() {
        guard let session = reinforce else { return }
        appState.saveReinforceDraft(session.draftSnapshot())
    }

    /// 退出页面时保存草稿，覆盖两种中途退出：
    /// - 强化环节未走完 → 原样保留，下次「继续强化」；
    /// - 正常阶段提前退出且已有不熟词 → 记下已判定的部分，避免这组不熟词丢失。
    private func persistDraftIfNeeded() {
        if reinforce != nil {
            persistDraft()
            return
        }
        guard mode == .learn, !weakKeys.isEmpty, !queue.isEmpty, index < queue.count else { return }
        let partial = ReinforceSession<String>(weakWords: weakKeys, books: Array(books))
        appState.saveReinforceDraft(partial.draftSnapshot())
    }

    private func direction(for size: CGSize) -> Direction? {
        if abs(size.width) < 20 && abs(size.height) < 20 { return nil }
        if isReinforcing {
            // 强化环节只有「认识 / 不认识」两个判定：仅响应左右滑动
            guard abs(size.width) >= 20 else { return nil }
            return size.width < 0 ? .again : .good
        }
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
