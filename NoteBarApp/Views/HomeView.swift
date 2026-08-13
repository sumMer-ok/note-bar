import SwiftUI
import SwiftData

struct HomeView: View {
    @EnvironmentObject var appState: AppState
    @Query private var entries: [Entry]

    private func dueCount(in book: String? = nil) -> Int {
        let today = FSRS.dayString(Date())
        return entries.filter { entry in
            if let book, entry.book != book { return false }
            guard let due = entry.dueDate, due <= today else { return false }
            return !["graduated", "archived", "retired"].contains(entry.lifecycle ?? "")
        }.count
    }

    private var newCount: Int {
        entries.filter { $0.s == nil && ($0.lifecycle == nil || $0.lifecycle == "active") }.count
    }

    private var books: [String] {
        Array(Set(entries.map(\.book))).sorted()
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("学习").font(.largeTitle.bold())
                    HStack(spacing: 10) {
                        NavigationLink {
                            ReviewView(mode: .review)
                        } label: {
                            Label("开始复习", systemImage: "arrow.clockwise")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(.blue, in: RoundedRectangle(cornerRadius: 14))
                                .foregroundStyle(.white)
                        }
                        NavigationLink {
                            ReviewView(mode: .learn)
                        } label: {
                            Label("开始学习", systemImage: "sparkles")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(.purple, in: RoundedRectangle(cornerRadius: 14))
                                .foregroundStyle(.white)
                        }
                        NavigationLink {
                            DictationView()
                        } label: {
                            Label("听写", systemImage: "pencil.and.list.clipboard")
                                .frame(maxWidth: .infinity)
                                .padding(.vertical, 12)
                                .background(Theme.hardGray, in: RoundedRectangle(cornerRadius: 14))
                                .foregroundStyle(.white)
                        }
                    }
                    Text("今日待复习 \(dueCount()) · 新词 \(newCount)")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("我的词库").font(.headline)
                    ForEach(books, id: \.self) { book in
                        NavigationLink {
                            WordListView(book: book)
                        } label: {
                            HStack {
                                VStack(alignment: .leading) {
                                    Text(book).fontWeight(.medium)
                                    Text("\(entries.filter { $0.book == book }.count) 词")
                                        .font(.caption).foregroundStyle(.secondary)
                                }
                                Spacer()
                                Text("待复习 \(dueCount(in: book))").font(.caption).foregroundStyle(.red)
                            }
                            .padding()
                            .glassCard()
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding()
            }
        }
    }
}
