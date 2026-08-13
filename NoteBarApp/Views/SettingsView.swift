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
