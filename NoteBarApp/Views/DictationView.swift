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

    var body: some View {
        VStack(spacing: 18) {
            if queue.indices.contains(index) {
                let entry = queue[index]
                Text("听写 \(index + 1) / \(queue.count)").font(.caption).foregroundStyle(.secondary)
                Text(entry.definition.isEmpty ? "（无释义）" : entry.definition)
                    .font(.title2)
                    .multilineTextAlignment(.center)
                    .padding()
                    .frame(maxWidth: .infinity, minHeight: 160)
                    .glassCard()
                TextField("拼写英文单词", text: $input)
                    .textFieldStyle(.roundedBorder)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                Button("🔊 点击音标朗读") { appState.speak(entry.word) }
                    .font(.caption)
                if let message {
                    Text(message).foregroundStyle(message.contains("正确") ? Color.green : Color.red)
                }
                Button("检查") { check(entry) }
                    .buttonStyle(.borderedProminent)
            } else {
                ContentUnavailableView("本轮完成", systemImage: "checkmark.seal", description: Text("正确 \(correctCount) / \(queue.count)"))
            }
        }
        .padding()
        .navigationTitle("听写")
        .onAppear(perform: buildQueue)
    }

    private func buildQueue() {
        let active = all.filter { $0.lifecycle != "retired" && $0.lifecycle != "archived" }
        queue = Array(active.shuffled().prefix(appState.settings.dictationPerSession))
    }

    private func check(_ entry: Entry) {
        let normalized = StudyKey.normalizeText(input)
        let ok = normalized == StudyKey.normalizeText(entry.word)
            || entry.aliases.contains { StudyKey.normalizeText($0) == normalized }
        if ok { correctCount += 1 }
        message = ok ? "正确 ✓" : "正确答案：\(entry.word)"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) {
            input = ""
            message = nil
            index += 1
        }
    }
}
