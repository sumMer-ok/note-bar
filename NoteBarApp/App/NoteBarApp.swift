import SwiftUI
import SwiftData

@main
struct NoteBarApp: App {
    let container: ModelContainer
    @StateObject private var appState: AppState

    init() {
        let schema = Schema([Entry.self])
        let resolvedContainer: ModelContainer
        do {
            resolvedContainer = try ModelContainer(for: schema)
        } catch {
            fatalError("Failed to create ModelContainer: \(error)")
        }
        container = resolvedContainer
        _appState = StateObject(wrappedValue: AppState(context: resolvedContainer.mainContext))
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(\.modelContext, container.mainContext)
                .environmentObject(appState)
                .preferredColorScheme(appState.settings.forceDarkMode ? .dark : nil)
                .onAppear { appState.sync.start() }
        }
    }
}

struct RootView: View {
    var body: some View {
        TabView {
            HomeView().tabItem { Label("学习", systemImage: "book.fill") }
            WordListView().tabItem { Label("词库", systemImage: "books.vertical") }
            StatsView().tabItem { Label("统计", systemImage: "chart.bar.fill") }
            SettingsView().tabItem { Label("设置", systemImage: "gearshape.fill") }
        }
    }
}
