import SwiftUI
import SwiftData

struct DictationView: View {
    @EnvironmentObject var appState: AppState
    @Query private var all: [Entry]
    /// 听写范围：词库为空表示全部词库；日期为空表示全部日期
    var books: Set<String> = []
    var dates: Set<String> = []
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var input = ""
    @State private var message: String?
    @State private var correctCount = 0
    @State private var answered = false
    @State private var lastCorrect = false
    @State private var shakeCount = 0
    @State private var revealAnswer = false
    @State private var firstResults: [String: Bool] = [:]
    @State private var pendingAdvance: DispatchWorkItem?

    var body: some View {
        VStack(spacing: 18) {
            if queue.indices.contains(index) {
                quizView(queue[index])
            } else {
                settlementView
            }
        }
        .padding()
        .navigationTitle("听写")
        .onAppear(perform: buildQueue)
        .onDisappear { pendingAdvance?.cancel() }
    }

    private func quizView(_ entry: Entry) -> some View {
        VStack(spacing: 18) {
            Text("听写 \(index + 1) / \(queue.count)").font(.caption).foregroundStyle(.secondary)
            Text(prompt(for: entry))
                .font(.title2)
                .multilineTextAlignment(.center)
                .padding()
                .frame(maxWidth: .infinity, minHeight: 160)
                .glassCard()

            TextField("拼写英文单词", text: $input)
                .textFieldStyle(.roundedBorder)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .disabled(lastCorrect && answered)
                .modifier(ShakeEffect(shakes: CGFloat(shakeCount) * 2))
                .animation(.linear(duration: 0.35), value: shakeCount)
                .onSubmit { check(entry) }

            Button("🔊 点击音标朗读") { appState.speak(entry.word) }
                .font(.caption)

            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(message.contains("正确") ? Color.green : Color.red)
            }

            if revealAnswer {
                HStack(spacing: 8) {
                    Text(entry.word)
                        .font(.title3.bold())
                    Button {
                        appState.speak(entry.word)
                    } label: {
                        Image(systemName: "speaker.wave.2.fill")
                            .foregroundStyle(.blue)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.vertical, 10)
                .background(.ultraThinMaterial, in: Capsule())
                .transition(.scale(scale: 0.7).combined(with: .opacity))
                .animation(.spring(duration: 0.35, bounce: 0.5), value: revealAnswer)
            }

            HStack(spacing: 12) {
                Button {
                    check(entry)
                } label: {
                    Text("检查")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .disabled((lastCorrect && answered) || input.trimmingCharacters(in: .whitespaces).isEmpty)

                Button {
                    advance()
                } label: {
                    Text("下一个")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    private var settlementView: some View {
        let correct = queue.filter { firstResults[$0.studyKey] == true }
        let wrong = queue.filter { firstResults[$0.studyKey] == false }
        return VStack(spacing: 16) {
            ContentUnavailableView(
                "本轮完成",
                systemImage: "checkmark.seal",
                description: Text("正确 \(correct.count) / \(queue.count)（按第一次输入判定）")
            )

            ScrollView {
                VStack(spacing: 8) {
                    ForEach(queue) { entry in
                        HStack {
                            Image(systemName: firstResults[entry.studyKey] == true ? "checkmark.circle.fill" : "xmark.circle.fill")
                                .foregroundStyle(firstResults[entry.studyKey] == true ? Color.green : Color.red)
                            Text(entry.word).fontWeight(.medium)
                            Spacer()
                            Button { appState.speak(entry.word) } label: {
                                Image(systemName: "speaker.wave.2.fill")
                                    .foregroundStyle(.blue)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal)
                    }
                }
            }
            .frame(maxHeight: 280)

            HStack(spacing: 12) {
                Button {
                    restart(withWrong: wrong)
                } label: {
                    Text("再写一遍")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.borderedProminent)
                .disabled(wrong.isEmpty)

                Button {
                    nextGroup()
                } label: {
                    Text("下一组")
                        .font(.title3.bold())
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                }
                .buttonStyle(.bordered)
            }
        }
    }

    /// 只显示「词典释义」，没有则回退到「AI 释义」
    private func prompt(for entry: Entry) -> String {
        let dictionary = DefinitionSections.content(entry.definition, module: .dictionary)
        if !dictionary.isEmpty { return dictionary }
        let ai = DefinitionSections.content(entry.definition, module: .ai)
        if !ai.isEmpty { return ai }
        return "（无释义）"
    }

    private func buildQueue() {
        buildQueue(excluding: [])
    }

    private func buildQueue(excluding excluded: Set<String>) {
        let active = all.filter { entry in
            !excluded.contains(entry.studyKey)
                && entry.lifecycle != "retired"
                && entry.lifecycle != "archived"
                && StudyQueue.dictationMatch(entry, books: books, dates: dates)
        }
        var pool = active
        if pool.isEmpty {
            pool = all.filter { entry in
                entry.lifecycle != "retired"
                    && entry.lifecycle != "archived"
                    && StudyQueue.dictationMatch(entry, books: books, dates: dates)
            }
        }
        queue = Array(pool.shuffled().prefix(appState.settings.dictationPerSession))
        resetSession()
    }

    private func nextGroup() {
        buildQueue(excluding: Set(queue.map(\.studyKey)))
    }

    private func restart(withWrong wrong: [Entry]) {
        queue = wrong
        resetSession()
    }

    private func resetSession() {
        index = 0
        input = ""
        message = nil
        answered = false
        lastCorrect = false
        revealAnswer = false
        correctCount = 0
        firstResults = [:]
        pendingAdvance?.cancel()
        pendingAdvance = nil
    }

    private func check(_ entry: Entry) {
        let normalized = StudyKey.normalizeText(input)
        let ok = normalized == StudyKey.normalizeText(entry.word)
            || entry.aliases.contains { StudyKey.normalizeText($0) == normalized }

        if firstResults[entry.studyKey] == nil {
            firstResults[entry.studyKey] = ok
        }

        if ok {
            lastCorrect = true
            answered = true
            revealAnswer = false
            correctCount += 1
            message = "正确 ✓"
            if appState.settings.dictationAutoAdvance {
                let work = DispatchWorkItem { advance() }
                pendingAdvance = work
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2, execute: work)
            }
        } else {
            message = "拼写错误，请重试"
            withAnimation { shakeCount += 1 }
            withAnimation(.spring(duration: 0.35, bounce: 0.5)) { revealAnswer = true }
        }
    }

    private func advance() {
        pendingAdvance?.cancel()
        pendingAdvance = nil
        input = ""
        message = nil
        answered = false
        lastCorrect = false
        revealAnswer = false
        index += 1
    }
}

/// 左右摇动动效：拼写错误时触发
struct ShakeEffect: GeometryEffect {
    var shakes: CGFloat
    var travelDistance: CGFloat = 8

    var animatableData: CGFloat {
        get { shakes }
        set { shakes = newValue }
    }

    func effectValue(size: CGSize) -> ProjectionTransform {
        ProjectionTransform(
            CGAffineTransform(
                translationX: travelDistance * sin(shakes * .pi),
                y: 0
            )
        )
    }
}
