import SwiftUI
import SwiftData

struct WordListView: View {
    var book: String?
    @EnvironmentObject var appState: AppState
    @Environment(\.colorScheme) var scheme
    @Query private var entries: [Entry]
    @State private var grouping = Grouping.date
    @State private var searchText = ""
    @State private var currentSectionID: String?

    enum Grouping: String, CaseIterable {
        case date = "按日期", letter = "按首字母", proficiency = "按熟练度"
    }

    private var filtered: [Entry] {
        let byBook: [Entry]
        if let book {
            byBook = entries.filter { $0.book == book }
        } else {
            byBook = entries
        }
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        guard !query.isEmpty else { return byBook }
        return byBook.filter { entry in
            entry.word.lowercased().contains(query)
                || entry.aliases.contains { $0.lowercased().contains(query) }
                || entry.definition.lowercased().contains(query)
        }
    }

    private var sections: [(key: String, title: String, entries: [Entry])] {
        switch grouping {
        case .date:
            let groups = Dictionary(grouping: filtered) { $0.addedDate ?? "无日期" }
            return groups.keys.sorted().reversed().map { key in
                ("D-\(key)", key, groups[key]!.sorted { $0.word < $1.word })
            }
        case .letter:
            let groups = Dictionary(grouping: filtered) { String($0.word.prefix(1)).uppercased() }
            return groups.keys.sorted().map { key in
                ("L-\(key)", key, groups[key]!.sorted { $0.word < $1.word })
            }
        case .proficiency:
            let bands = ["未开始", "新学", "巩固", "熟悉", "已掌握"]
            return bands.map { band in
                ("P-\(band)", band, filtered.filter { proficiency($0) == band }.sorted { $0.word < $1.word })
            }
        }
    }

    private var indexItems: [IndexItem] {
        switch grouping {
        case .letter:
            return sections.map { IndexItem(id: $0.key, label: $0.title) }
        case .date:
            var items: [IndexItem] = []
            for section in sections {
                let month = String(section.title.prefix(7))
                let label = "\(Int(String(month.suffix(2))) ?? 0)月"
                if items.last?.label != label {
                    items.append(IndexItem(id: section.key, label: label))
                }
            }
            return items
        case .proficiency:
            let short = ["未开始": "未", "新学": "新", "巩固": "巩", "熟悉": "熟", "已掌握": "掌"]
            return sections.map { IndexItem(id: $0.key, label: short[$0.title] ?? $0.title) }
        }
    }

    var body: some View {
        NavigationStack {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 0, pinnedViews: [.sectionHeaders]) {
                        Picker("分组", selection: $grouping) {
                            ForEach(Grouping.allCases, id: \.self) { Text($0.rawValue) }
                        }
                        .pickerStyle(.segmented)
                        .padding(.horizontal)
                        .padding(.vertical, 8)

                        ForEach(sections, id: \.key) { section in
                            Section {
                                ForEach(section.entries) { entry in
                                    NavigationLink {
                                        WordDetailView(entry: entry)
                                    } label: {
                                        HStack {
                                            Text(entry.word).foregroundStyle(Theme.wordColor(scheme))
                                            Spacer()
                                            Text(proficiency(entry)).font(.caption).foregroundStyle(.secondary)
                                            Image(systemName: "square.and.pencil").font(.caption).foregroundStyle(.blue)
                                        }
                                        .padding(.horizontal)
                                        .padding(.vertical, 8)
                                        .contentShape(Rectangle())
                                    }
                                    .buttonStyle(.plain)
                                    Divider().padding(.leading)
                                }
                            } header: {
                                Text(section.title)
                                    .font(.subheadline.bold())
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.horizontal)
                                    .padding(.vertical, 6)
                                    .background(.thinMaterial)
                            }
                            .id(section.key)
                        }
                    }
                    .scrollTargetLayout()
                }
                .scrollPosition(id: $currentSectionID)
                .overlay(alignment: .trailing) {
                    if !indexItems.isEmpty {
                        IndexRail(items: indexItems, currentID: currentSectionID) { id in
                            withAnimation(.easeInOut(duration: 0.25)) {
                                proxy.scrollTo(id, anchor: .top)
                            }
                        }
                    }
                }
                .navigationTitle(book ?? "全部词库")
                .navigationBarTitleDisplayMode(.inline)
                .searchable(
                    text: $searchText,
                    placement: .navigationBarDrawer(displayMode: .always),
                    prompt: "搜索单词、别名或释义"
                )
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

struct IndexItem: Identifiable, Equatable {
    let id: String
    let label: String
}

/// 右侧索引进度条：高亮当前分组，点击跳转
struct IndexRail: View {
    let items: [IndexItem]
    let currentID: String?
    let onSelect: (String) -> Void

    var body: some View {
        VStack(spacing: 1) {
            ForEach(items) { item in
                Button {
                    onSelect(item.id)
                } label: {
                    Text(item.label)
                        .font(.system(size: 10, weight: item.id == currentID ? .bold : .regular))
                        .foregroundStyle(item.id == currentID ? Color.white : Color.secondary)
                        .frame(minWidth: 18, minHeight: 15)
                        .background(
                            item.id == currentID
                                ? Capsule().fill(Color.blue)
                                : Capsule().fill(Color.clear)
                        )
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.vertical, 4)
        .padding(.horizontal, 3)
        .background(.ultraThinMaterial, in: Capsule())
        .padding(.trailing, 2)
    }
}
