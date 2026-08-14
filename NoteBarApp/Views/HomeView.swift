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
                            HomeActionButton(title: "开始复习", icon: "arrow.clockwise", animal: "rabbit", delay: 0.0, color: .blue)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            ReviewView(mode: .learn)
                        } label: {
                            HomeActionButton(title: "开始学习", icon: "sparkles", animal: "bear", delay: 0.35, color: .purple)
                        }
                        .buttonStyle(.plain)
                    }
                    HStack(spacing: 12) {
                        NavigationLink {
                            BrowseView()
                        } label: {
                            HomeActionButton(title: "开始慢游", icon: "leaf.fill", animal: "fox", delay: 0.7, color: .teal)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            DictationView()
                        } label: {
                            HomeActionButton(title: "开始听写", icon: "pencil.and.list.clipboard", animal: "cat", delay: 1.05, color: Theme.hardGray)
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

/// 首页大按钮：按钮内随机位置有卡通小动物定时探头
struct HomeActionButton: View {
    let title: String
    let icon: String
    let animal: String
    let delay: Double
    let color: Color

    var body: some View {
        ZStack {
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(color.gradient)
            VStack(spacing: 4) {
                Label(title, systemImage: icon)
                    .font(.title3.bold())
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 18)
            }
            CartoonAnimal(name: animal, delay: delay)
        }
        .foregroundStyle(.white)
        .frame(maxWidth: .infinity)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

/// 卡通小动物在按钮内随机位置探头又缩回，不同按钮错峰出现
struct CartoonAnimal: View {
    let name: String
    let delay: Double
    @State private var visible = false
    @State private var point: CGPoint = .zero
    @State private var tilt: Double = 0
    @State private var scale: CGFloat = 0.75

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                if visible {
                    Image(name)
                        .resizable()
                        .scaledToFit()
                        .frame(width: 36, height: 36)
                        .rotationEffect(.degrees(tilt))
                        .scaleEffect(scale)
                        .offset(x: point.x, y: point.y)
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                }
            }
            .task {
                try? await Task.sleep(for: .seconds(delay))
                while !Task.isCancelled {
                    point = randomPoint(in: geo.size)
                    tilt = .random(in: -14...14)
                    scale = .random(in: 0.8...1.1)
                    withAnimation(.spring(duration: 0.45, bounce: 0.5)) { visible = true }
                    try? await Task.sleep(for: .seconds(1.1))
                    withAnimation(.easeOut(duration: 0.25)) { visible = false }
                    try? await Task.sleep(for: .seconds(0.55))
                }
            }
        }
    }

    private func randomPoint(in size: CGSize) -> CGPoint {
        guard size.width > 50, size.height > 50 else { return CGPoint(x: 10, y: 10) }
        return CGPoint(
            x: .random(in: 16...(size.width - 16)),
            y: .random(in: 12...(size.height - 12))
        )
    }
}
