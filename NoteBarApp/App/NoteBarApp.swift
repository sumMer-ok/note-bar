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
                .preferredColorScheme(appState.settings.appearance.colorScheme)
                .onAppear { appState.sync.start() }
        }
    }
}

/// 让 Tab 内容首次被选中时才真正构建，避免切换 Tab 时一次性构造所有页面
struct LazyView<Content: View>: View {
    private let build: () -> Content

    init(@ViewBuilder _ build: @escaping () -> Content) {
        self.build = build
    }

    var body: some View {
        build()
    }
}

struct RootView: View {
    @EnvironmentObject var appState: AppState
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView(selection: $appState.selectedTab) {
            LazyView { HomeView() }
                .tabItem { Label("学习", systemImage: "book.fill") }
                .tag(AppTab.learn)
            LazyView { WordListView(book: appState.libraryFilter) }
                .tabItem { Label("词库", systemImage: "books.vertical") }
                .tag(AppTab.library)
            LazyView { StatsView() }
                .tabItem { Label("统计", systemImage: "chart.bar.fill") }
                .tag(AppTab.stats)
            LazyView { SettingsView() }
                .tabItem { Label("设置", systemImage: "gearshape.fill") }
                .tag(AppTab.settings)
        }
        .onChange(of: appState.selectedTab) { appState.handleTabChange($0) }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active { appState.sync.start() }
        }
    }
}
