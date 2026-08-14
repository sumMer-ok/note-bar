import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var appState: AppState
    @State private var showPicker = false

    var body: some View {
        NavigationStack {
            Form {
                Section("iCloud 同步目录") {
                    Button("选择目录") { showPicker = true }
                    Text(appState.syncStatus).font(.caption).foregroundStyle(.secondary)
                    Button("立即同步") {
                        Task { await appState.sync.scan() }
                    }
                }
                Section("外观") {
                    Toggle("暗夜模式", isOn: $appState.settings.forceDarkMode)
                }
                Section("学习") {
                    Toggle("自动朗读单词", isOn: $appState.settings.autoPronounce)
                    Stepper("每日新词上限 \(appState.settings.dailyNewWordLimit)", value: $appState.settings.dailyNewWordLimit, in: 1...200)
                    Stepper("每日复习上限 \(appState.settings.dailyReviewLimit)", value: $appState.settings.dailyReviewLimit, in: 1...500)
                    Stepper("每轮听写 \(appState.settings.dictationPerSession) 词", value: $appState.settings.dictationPerSession, in: 1...100)
                }
                Section("AI 释义") {
                    TextField("API 地址", text: $appState.settings.aiApiUrl)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("API Key", text: $appState.settings.aiApiKey)
                    TextField("模型", text: $appState.settings.aiModel)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextField("额外参数（JSON，可选）", text: $appState.settings.aiExtraParams)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    TextEditor(text: $appState.settings.aiNotesPrompt)
                        .frame(minHeight: 120)
                    Text("「AI 释义」提示词与 Obsidian 插件保持一致；上方为「自定义笔记」提示词，可自行修改，支持 {{word}} 与 {{sentence}} 占位符")
                        .font(.caption2).foregroundStyle(.secondary)
                }
                Section {
                    ForEach(appState.settings.definitionOrder, id: \.self) { module in
                        HStack {
                            Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                            Text(module.rawValue)
                            Spacer()
                        }
                    }
                    .onMove { source, destination in
                        appState.settings.definitionOrder.move(fromOffsets: source, toOffset: destination)
                    }
                    Text("按住右侧把手拖动，调整四个释义模块在卡片上的显示顺序")
                        .font(.caption2).foregroundStyle(.secondary)
                } header: {
                    Text("单词卡片显示顺序")
                }
                .environment(\.editMode, .constant(.active))
                Section("冲突日志") {
                    ForEach(appState.conflicts, id: \.self) { Text($0).font(.caption) }
                }
            }
            .navigationTitle("设置")
            .sheet(isPresented: $showPicker) {
                FolderPicker { url in
                    appState.sync.configure(folder: url)
                    appState.syncStatus = url.lastPathComponent
                    appState.sync.start()
                }
                .ignoresSafeArea()
            }
        }
    }
}
