import SwiftUI
import SwiftData

/// 听写第二步：在所选词库内按添加日期选择（可多选）
struct DictationDatePickerView: View {
    let book: String
    @Query private var entries: [Entry]
    @State private var selected: Set<String> = []

    private var bookEntries: [Entry] {
        entries.filter { $0.book == book }
    }

    /// 倒序日期选项；存在无日期词条时追加「无日期」
    private var dateOptions: [String] {
        var dates = Set(bookEntries.compactMap(\.addedDate)).sorted(by: >)
        if bookEntries.contains(where: { $0.addedDate == nil }) {
            dates.append(StudyQueue.undatedLabel)
        }
        return dates
    }

    private var selectedWordCount: Int {
        bookEntries.filter { selected.contains($0.addedDate ?? StudyQueue.undatedLabel) }.count
    }

    var body: some View {
        List {
            Section {
                ForEach(dateOptions, id: \.self) { date in
                    Button {
                        toggle(date)
                    } label: {
                        HStack {
                            Text(date)
                            Spacer()
                            Text("\(wordCount(on: date)) 词")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Image(systemName: selected.contains(date) ? "checkmark.circle.fill" : "circle")
                                .foregroundStyle(selected.contains(date) ? Color.blue : Color.secondary)
                        }
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                }
            } header: {
                Text("按添加日期选择（可多选）")
            } footer: {
                Text("将听写「\(displayName)」词库中这些日期添加的单词")
            }
        }
        .navigationTitle("选择日期")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Button(selected.count == dateOptions.count ? "清空" : "全选") {
                    selected = selected.count == dateOptions.count ? [] : Set(dateOptions)
                }
            }
        }
        .safeAreaInset(edge: .bottom) {
            NavigationLink {
                DictationView(books: [book], dates: selected)
            } label: {
                Text("开始听写（\(selectedWordCount) 词）")
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 14)
            }
            .buttonStyle(.borderedProminent)
            .disabled(selected.isEmpty)
            .padding()
            .background(.bar)
        }
    }

    private var displayName: String {
        let base = (book as NSString).lastPathComponent
        return base.hasSuffix(".canvas") ? String(base.dropLast(".canvas".count)) : base
    }

    private func wordCount(on date: String) -> Int {
        if date == StudyQueue.undatedLabel {
            return bookEntries.filter { $0.addedDate == nil }.count
        }
        return bookEntries.filter { $0.addedDate == date }.count
    }

    private func toggle(_ date: String) {
        if selected.contains(date) {
            selected.remove(date)
        } else {
            selected.insert(date)
        }
    }
}
