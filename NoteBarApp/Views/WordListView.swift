import SwiftUI
import SwiftData

struct WordListView: View {
    var book: String?
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Query private var entries: [Entry]
    @State private var grouping = Grouping.date

    enum Grouping: String, CaseIterable {
        case date = "按日期", letter = "按首字母", proficiency = "按熟练度"
    }

    private var filtered: [Entry] {
        guard let book else { return entries }
        return entries.filter { $0.book == book }
    }

    private var sections: [(String, [Entry])] {
        switch grouping {
        case .date:
            let groups = Dictionary(grouping: filtered) { $0.addedDate ?? "无日期" }
            return groups.keys.sorted().reversed().map { ($0, groups[$0]!.sorted { $0.word < $1.word }) }
        case .letter:
            let groups = Dictionary(grouping: filtered) { String($0.word.prefix(1)).uppercased() }
            return groups.keys.sorted().map { ($0, groups[$0]!.sorted { $0.word < $1.word }) }
        case .proficiency:
            let bands = ["未开始", "新学", "巩固", "熟悉", "已掌握"]
            return bands.map { band in
                (band, filtered.filter { proficiency($0) == band }.sorted { $0.word < $1.word })
            }
        }
    }

    var body: some View {
        NavigationStack {
            List {
                Picker("分组", selection: $grouping) {
                    ForEach(Grouping.allCases, id: \.self) { Text($0.rawValue) }
                }
                .pickerStyle(.segmented)
                .listRowSeparator(.hidden)

                ForEach(sections, id: \.0) { section in
                    Section(section.0) {
                        ForEach(section.1) { entry in
                            NavigationLink {
                                WordDetailView(entry: entry)
                            } label: {
                                HStack {
                                    Text(entry.word).foregroundStyle(Theme.wordColor(scheme))
                                    Spacer()
                                    Text(proficiency(entry)).font(.caption).foregroundStyle(.secondary)
                                    Image(systemName: "square.and.pencil").font(.caption).foregroundStyle(.blue)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle(book ?? "全部词库")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if book != nil {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            appState.libraryFilter = nil
                        } label: {
                            Label("全部词库", systemImage: "books.vertical")
                        }
                    }
                }
            }
        }
    }

    private func proficiency(_ entry: Entry) -> String {
        if entry.mastered == true || entry.status == "mastered" || entry.lifecycle == "graduated" { return "已掌握" }
        guard let s = entry.s else { return "未开始" }
        if s >= 30 { return "已掌握" }
        if s < 2 { return "新学" }
        if s < 15 { return "巩固" }
        return "熟悉"
    }
}
