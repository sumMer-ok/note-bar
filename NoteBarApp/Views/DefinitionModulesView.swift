import SwiftUI

/// 释义模块展示：词典释义 / 法律词典释义 / AI 释义 / 自定义笔记，模块间用横线分隔
struct DefinitionModulesView: View {
    let raw: String
    var onEdit: ((DefinitionModule) -> Void)?

    var body: some View {
        let items = DefinitionSections.modules(raw)
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text(raw.isEmpty ? "（无释义）" : raw)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(item.module.rawValue).font(.headline)
                            Spacer()
                            if let onEdit {
                                Button("编辑") { onEdit(item.module) }
                                    .font(.caption)
                            }
                        }
                        Text(item.content)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 10)
                    if index < items.count - 1 {
                        Divider()
                    }
                }
            }
        }
    }
}

/// 编辑单个释义模块，保存后写回 Canvas
struct ModuleEditorSheet: View {
    let entry: Entry
    let module: DefinitionModule
    @EnvironmentObject var appState: AppState
    @Environment(\.modelContext) private var context
    @Environment(\.dismiss) private var dismiss
    @State private var text: String

    init(entry: Entry, module: DefinitionModule) {
        self.entry = entry
        self.module = module
        _text = State(initialValue: DefinitionSections.content(entry.definition, module: module))
    }

    var body: some View {
        NavigationStack {
            VStack(alignment: .leading, spacing: 10) {
                Text(module.rawValue).font(.caption).foregroundStyle(.secondary)
                TextEditor(text: $text)
                    .padding(6)
                    .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 12))
            }
            .padding()
            .navigationTitle("编辑 \(module.rawValue)")
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

    private func save() {
        let newDefinition = DefinitionSections.update(entry.definition, module: module, content: text)
        entry.definition = newDefinition
        try? context.save()

        let book = entry.book
        let nodeId = entry.nodeId
        let word = entry.word
        let aliases = entry.aliases
        let sync = appState.sync
        Task {
            if var canvas = await sync.readCanvas(book) {
                _ = CanvasEditor.updateWord(data: &canvas, nodeId: nodeId, word: word, definition: newDefinition, aliases: aliases)
                sync.writeCanvas(book, data: canvas)
            }
        }
        dismiss()
    }
}
