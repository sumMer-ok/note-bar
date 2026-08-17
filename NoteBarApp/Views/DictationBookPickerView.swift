import SwiftUI
import SwiftData

/// 听写第一步：选择要听写的词库（单选）
struct DictationBookPickerView: View {
    @EnvironmentObject var appState: AppState
    @Query private var entries: [Entry]

    private var books: [String] {
        Array(Set(entries.map(\.book))).sorted()
    }

    var body: some View {
        List {
            Section("选择单词本") {
                if books.isEmpty {
                    Text("词库为空")
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(books, id: \.self) { book in
                        NavigationLink {
                            DictationDatePickerView(book: book)
                        } label: {
                            HStack {
                                Text(displayName(book))
                                Spacer()
                                Text("\(wordCount(in: book)) 词")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                }
            }
        }
        .navigationTitle("选择单词本")
        .navigationBarTitleDisplayMode(.inline)
    }

    private func displayName(_ book: String) -> String {
        let base = (book as NSString).lastPathComponent
        return base.hasSuffix(".canvas") ? String(base.dropLast(".canvas".count)) : base
    }

    private func wordCount(in book: String) -> Int {
        entries.reduce(0) { $0 + ($1.book == book ? 1 : 0) }
    }
}
