import SwiftUI
import SwiftData

struct DictationView: View {
    @EnvironmentObject var appState: AppState
    @Query private var all: [Entry]
    @State private var queue: [Entry] = []
    @State private var index = 0
    @State private var input = ""
    @State private var message: String?
    @State private var correctCount = 0
    @State private var answered = false
    @State private var lastCorrect = false
    @State private var shakeCount = 0
    @State private var revealAnswer = false
    @State private var pendingAdvance: DispatchWorkItem?

    var body: some View {
        VStack(spacing: 18) {
            if queue.indices.contains(index) {
                let entry = queue[index]
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
                    Button("检查") { check(entry) }
                        .buttonStyle(.borderedProminent)
                        .disabled((lastCorrect && answered) || input.trimmingCharacters(in: .whitespaces).isEmpty)
                    Button("下一个") { advance() }
                        .buttonStyle(.bordered)
                }
            } else {
                ContentUnavailableView("本轮完成", systemImage: "checkmark.seal", description: Text("正确 \(correctCount) / \(queue.count)"))
            }
        }
        .padding()
        .navigationTitle("听写")
        .onAppear(perform: buildQueue)
        .onDisappear { pendingAdvance?.cancel() }
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
        let active = all.filter { $0.lifecycle != "retired" && $0.lifecycle != "archived" }
        queue = Array(active.shuffled().prefix(appState.settings.dictationPerSession))
    }

    private func check(_ entry: Entry) {
        let normalized = StudyKey.normalizeText(input)
        let ok = normalized == StudyKey.normalizeText(entry.word)
            || entry.aliases.contains { StudyKey.normalizeText($0) == normalized }

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
