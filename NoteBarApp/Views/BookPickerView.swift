import SwiftUI
import SwiftData

/// 开始复习/学习前的词库多选页
struct BookPickerView: View {
    let mode: ReviewView.Mode
    @EnvironmentObject var appState: AppState
    @Query private var entries: [Entry]
    @State private var selected: Set<String> = []

    private var books: [String] {
        Array(Set(entries.map(\.book))).sorted()
    }

    var body: some View {
        List {
            Section("选择词库（可多选）") {
                ForEach(books, id: \.self) { book in
                    Button {
                        if selected.contains(book) {
                            selected.remove(book)
                        } else {
                            selected.insert(book)
                        }
                    } label: {
                        HStack {
                            Text(book)
                            Spacer()
                            Image(systemName: selected.contains(book) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selected.contains(book) ? Color.blue : Color.secondary)
                        }
                    }
                    .buttonStyle(.plain)
                }
            }

            Section {
                NavigationLink {
                    ReviewView(mode: mode, books: selected)
                } label: {
                    Text(mode == .review ? "开始复习" : "开始学习")
                        .fontWeight(.semibold)
                        .frame(maxWidth: .infinity)
                }
                .disabled(selected.isEmpty)
            }
        }
        .navigationTitle(mode == .review ? "选择复习词库" : "选择学习词库")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(selected.count == books.count ? "清空" : "全选") {
                    selected = selected.count == books.count ? [] : Set(books)
                }
            }
        }
        .onAppear {
            // 默认不勾选；仅预选用户标记的「默认词库」
            if selected.isEmpty {
                selected = Set(books.filter { appState.settings.defaultBooks.contains($0) })
            }
        }
    }
}
