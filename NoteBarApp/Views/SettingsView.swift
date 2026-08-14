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
                Section("单词卡片显示顺序") {
                    ForEach(appState.settings.definitionOrder, id: \.self) { module in
                        HStack {
                            Image(systemName: "line.3.horizontal").foregroundStyle(.secondary)
                            Text(module.rawValue)
                            Spacer()
                        }
                        .contentShape(Rectangle())
                        .draggable(module.rawValue)
                        .dropDestination(for: String.self) { items, _ in
                            guard let dragged = items.first,
                                  dragged != module.rawValue,
                                  let from = appState.settings.definitionOrder.firstIndex(where: { $0.rawValue == dragged }),
                                  let to = appState.settings.definitionOrder.firstIndex(of: module)
                            else { return false }
                            withAnimation {
                                appState.settings.definitionOrder.move(
                                    fromOffsets: IndexSet(integer: from),
                                    toOffset: to > from ? to + 1 : to
                                )
                            }
                            return true
                        }
                    }
                    Text("拖动可调整四个释义模块在卡片上的显示顺序")
                        .font(.caption2).foregroundStyle(.secondary)
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
