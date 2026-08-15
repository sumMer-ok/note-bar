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
                DefinitionModulesView(raw: entry.definition, order: appState.settings.definitionOrder) { module in
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
            WordEditSheet(entry: entry, focusModule: nil)
        }
        .sheet(item: $editingModule) { module in
            WordEditSheet(entry: entry, focusModule: module)
        }
    }

    private func delete() {
        context.delete(entry)
        try? context.save()
        dismiss()
    }
}

/// 单词编辑：四个释义模块各自一个圆角矩形输入框，支持折叠/展开
struct WordEditSheet: View {
    let entry: Entry
    let focusModule: DefinitionModule?
    @Environment(\.dismiss) private var dismiss
    @Environment(\.modelContext) private var context
    @EnvironmentObject var appState: AppState
    @State private var word: String
    @State private var aliases: String
    @State private var contents: [DefinitionModule: String]
    @State private var expanded: Set<DefinitionModule>
    @State private var generating: DefinitionModule?
    @State private var messageByModule: [DefinitionModule: String] = [:]

    init(entry: Entry, focusModule: DefinitionModule?) {
        self.entry = entry
        self.focusModule = focusModule
        _word = State(initialValue: entry.word)
        _aliases = State(initialValue: entry.aliases.joined(separator: ", "))
        _contents = State(initialValue: Dictionary(uniqueKeysWithValues: DefinitionModule.allCases.map { module in
            (module, DefinitionSections.content(entry.definition, module: module))
        }))
        var initialExpanded: Set<DefinitionModule> = [.dictionary]
        if let focusModule { initialExpanded.insert(focusModule) }
        _expanded = State(initialValue: initialExpanded)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    TextField("单词", text: $word)
                        .textFieldStyle(.roundedBorder)
                    TextField("别名（逗号分隔）", text: $aliases)
                        .textFieldStyle(.roundedBorder)

                    ForEach(appState.settings.definitionOrder, id: \.self) { module in
                        moduleBox(module)
                    }
                }
                .padding()
            }
            .navigationTitle("编辑单词")
            .navigationBarTitleDisplayMode(.inline)
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

    private func moduleBox(_ module: DefinitionModule) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(module.rawValue).font(.headline)
                Spacer()
                if module == .ai || module == .legal || module == .notes {
                    Button {
                        Task { await generate(module) }
                    } label: {
                        if generating == module {
                            ProgressView().controlSize(.small)
                        } else {
                            Label(module == .legal ? "AI 纠正" : "AI 生成", systemImage: "sparkles")
                                .font(.caption)
                        }
                    }
                    .disabled(generating != nil || word.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Image(systemName: expanded.contains(module) ? "chevron.down" : "chevron.right")
                    .foregroundStyle(.secondary)
            }
            .contentShape(Rectangle())
            .onTapGesture {
                if expanded.contains(module) { expanded.remove(module) } else { expanded.insert(module) }
            }

            if expanded.contains(module) {
                TextEditor(text: contentBinding(module))
                    .frame(minHeight: 120)
                    .padding(6)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 14))
                if module == .ai || module == .legal || module == .notes, let message = messageByModule[module] {
                    Text(message)
                        .font(.caption2)
                        .foregroundStyle(message.contains("已生成") || message.contains("已纠正") ? Color.green : Color.red)
                }
            }
        }
        .padding(14)
        .background(.quaternary, in: RoundedRectangle(cornerRadius: 18))
    }

    private func contentBinding(_ module: DefinitionModule) -> Binding<String> {
        Binding(
            get: { contents[module] ?? "" },
            set: { contents[module] = $0 }
        )
    }

    private func generate(_ module: DefinitionModule) async {
        let cleanWord = word.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !cleanWord.isEmpty else {
            messageByModule[module] = "请先输入单词"
            return
        }
        let config: AIDefinitionService.Config
        switch module {
        case .ai:
            config = appState.settings.aiConfig
        case .notes:
            config = appState.settings.notesAIConfig
        case .legal:
            let legalContent = (contents[.legal] ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
            guard !legalContent.isEmpty else {
                messageByModule[module] = "法律释义为空，请先填写再纠正"
                return
            }
            config = AIDefinitionService.Config(
                apiUrl: appState.settings.aiApiUrl,
                apiKey: appState.settings.aiApiKey,
                model: appState.settings.aiModel,
                extraParams: appState.settings.aiExtraParams,
                prompt: AIDefinitionService.legalCorrectionPrompt
            )
        case .dictionary:
            return
        }
        let sentence = module == .legal ? (contents[.legal] ?? "") : ""
        generating = module
        messageByModule[module] = nil
        defer { generating = nil }
        do {
            let result = try await AIDefinitionService.fetchDefinition(
                word: cleanWord,
                sentence: sentence,
                config: config
            )
            contents[module] = result.definition
            if module == .ai,
               aliases.trimmingCharacters(in: .whitespaces).isEmpty,
               !result.aliases.isEmpty {
                aliases = result.aliases.joined(separator: ", ")
            }
            expanded.insert(module)
            messageByModule[module] = module == .legal ? "法律词典释义已纠正" : "\(module.rawValue)已生成"
        } catch {
            messageByModule[module] = error.localizedDescription
        }
    }

    private func save() {
        entry.word = word
        let newAliases = aliases.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        entry.aliases = newAliases

        // 序列化成规范顺序（词典→法律→AI→笔记），与桌面端存储保持一致
        var definition = ""
        for module in DefinitionModule.allCases {
            definition = DefinitionSections.update(definition, module: module, content: contents[module] ?? "")
        }
        entry.definition = definition
        entry.localEditedAt = Date()
        try? context.save()

        let book = entry.book
        let nodeId = entry.nodeId
        let newWord = word
        let newDefinition = definition
        let sync = appState.sync
        Task {
            if var canvas = await sync.readCanvas(book) {
                _ = CanvasEditor.updateWord(data: &canvas, nodeId: nodeId, word: newWord, definition: newDefinition, aliases: newAliases)
                await sync.writeCanvas(book, data: canvas)
            }
        }
        dismiss()
    }
}
