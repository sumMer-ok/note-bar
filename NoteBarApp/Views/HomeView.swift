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
                    HStack(spacing: 12) {
                        NavigationLink {
                            ReviewView(mode: .review)
                        } label: {
                            HomeActionButton(title: "开始复习", icon: "arrow.clockwise", animal: "🐰", delay: 0.0, color: .blue)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            ReviewView(mode: .learn)
                        } label: {
                            HomeActionButton(title: "开始学习", icon: "sparkles", animal: "🐻", delay: 0.35, color: .purple)
                        }
                        .buttonStyle(.plain)
                    }
                    HStack(spacing: 12) {
                        NavigationLink {
                            BrowseView()
                        } label: {
                            HomeActionButton(title: "开始慢游", icon: "leaf.fill", animal: "🦊", delay: 0.7, color: .teal)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            DictationView()
                        } label: {
                            HomeActionButton(title: "开始听写", icon: "pencil.and.list.clipboard", animal: "🐱", delay: 1.05, color: Theme.hardGray)
                        }
                        .buttonStyle(.plain)
                    }
                    Text("今日待复习 \(dueCount()) · 新词 \(newCount)")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("我的词库").font(.headline)
                    ForEach(books, id: \.self) { book in
                        Button {
                            appState.showLibrary(book: book)
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

/// 首页大按钮：顶部有一只定时探头的小动物
struct HomeActionButton: View {
    let title: String
    let icon: String
    let animal: String
    let delay: Double
    let color: Color

    var body: some View {
        ZStack(alignment: .top) {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(color.gradient)
            VStack(spacing: 4) {
                Spacer().frame(height: 24)
                Label(title, systemImage: icon)
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 16)
            }
            AnimalPeek(animal: animal, delay: delay)
                .padding(.top, -12)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
    }
}

/// 小动物从按钮上缘探头又缩回去，不同按钮错峰出现
struct AnimalPeek: View {
    let animal: String
    let delay: Double
    @State private var peek = false

    var body: some View {
        Text(animal)
            .font(.title2)
            .offset(y: peek ? 2 : 10)
            .scaleEffect(peek ? 1 : 0.72)
            .opacity(peek ? 1 : 0.3)
            .onAppear {
                withAnimation(.spring(duration: 0.55, bounce: 0.55).repeatForever(autoreverses: true).delay(delay)) {
                    peek = true
                }
            }
    }
}
