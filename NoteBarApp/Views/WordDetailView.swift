import SwiftUI
import SwiftData

struct WordDetailView: View {
    let entry: Entry
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @State private var editing = false
    @State private var editingModule: DefinitionModule?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                HStack {
                    Text(entry.word)
                        .font(.largeTitle.bold())
                        .foregroundStyle(Theme.wordColor(scheme))
                    Button { appState.speak(entry.word) } label: { Image(systemName: "speaker.wave.2.fill") }
                }
                DefinitionModulesView(raw: entry.definition) { module in
                    editingModule = module
                }
                .padding()
                .frame(maxWidth: .infinity, alignment: .leading)
                .glassCard()

                if let s = entry.s {
                    ProgressView(value: min(s / 30, 1))
                    HStack {
                        Text("记忆稳定度 \(String(format: "%.1f", s))")
                        Spacer()
                        Text("下次 \(entry.dueDate ?? "—")")
                    }
                    .font(.caption).foregroundStyle(.secondary)
                }

                HStack {
                    Button("编辑") { editing = true }
                        .buttonStyle(.bordered)
                    Button("删除", role: .destructive) { delete() }
                        .buttonStyle(.bordered)
                }
            }
            .padding()
        }
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $editing) {
            WordEditSheet(entry: entry)
        }
        .sheet(item: $editingModule) { module in
            ModuleEditorSheet(entry: entry, module: module)
        }
    }

    private func delete() {
        context.delete(entry)
        try? context.save()
        dismiss()
    }
}

struct WordEditSheet: View {
    let entry: Entry
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject var appState: AppState
    @State private var word: String
    @State private var definition: String
    @State private var aliases: String

    init(entry: Entry) {
        self.entry = entry
        _word = State(initialValue: entry.word)
        _definition = State(initialValue: entry.definition)
        _aliases = State(initialValue: entry.aliases.joined(separator: ", "))
    }

    var body: some View {
        NavigationStack {
            Form {
                TextField("单词", text: $word)
                TextField("别名（逗号分隔）", text: $aliases)
                TextEditor(text: $definition).frame(minHeight: 140)
            }
            .navigationTitle("编辑单词")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("取消") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") { save() }
                }
            }
        }
    }

    private func save() {
        entry.word = word
        entry.definition = definition
        let newAliases = aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        entry.aliases = newAliases
        try? context.save()

        let book = entry.book
        let nodeId = entry.nodeId
        let newWord = word
        let newDefinition = definition
        let sync = appState.sync
        Task {
            if var canvas = await sync.readCanvas(book) {
                _ = CanvasEditor.updateWord(data: &canvas, nodeId: nodeId, word: newWord, definition: newDefinition, aliases: newAliases)
                sync.writeCanvas(book, data: canvas)
            }
        }
        dismiss()
    }
}
