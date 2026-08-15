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
        let all = Array(Set(entries.map(\.book))).sorted()
        let pinned = appState.settings.pinnedBooks.filter { all.contains($0) }
        let rest = all.filter { !pinned.contains($0) }
        return pinned + rest
    }

    var body: some View {
        let totalDue = dueCount()
        let totalNew = newCount
        let isActive = appState.selectedTab == .learn
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("学习").font(.largeTitle.bold())
                    HStack(spacing: 12) {
                        NavigationLink {
                            BookPickerView(mode: .review)
                        } label: {
                            HomeActionButton(title: "开始复习", icon: "arrow.clockwise", animal: "rabbit", delay: 0.0, color: .blue, isActive: isActive)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            BookPickerView(mode: .learn)
                        } label: {
                            HomeActionButton(title: "开始学习", icon: "sparkles", animal: "bear", delay: 0.35, color: .purple, isActive: isActive)
                        }
                        .buttonStyle(.plain)
                    }
                    HStack(spacing: 12) {
                        NavigationLink {
                            BrowseView()
                        } label: {
                            HomeActionButton(title: "开始慢游", icon: "leaf.fill", animal: "fox", delay: 0.7, color: .teal, isActive: isActive)
                        }
                        .buttonStyle(.plain)
                        NavigationLink {
                            DictationView()
                        } label: {
                            HomeActionButton(title: "开始听写", icon: "pencil.and.list.clipboard", animal: "cat", delay: 1.05, color: Theme.hardGray, isActive: isActive)
                        }
                        .buttonStyle(.plain)
                    }
                    Text("今日待复习 \(totalDue) · 新词 \(totalNew)")
                        .font(.subheadline).foregroundStyle(.secondary)
                    Text("我的词库").font(.headline)
                    ForEach(books, id: \.self) { book in
                        BookRow(
                            book: book,
                            wordCount: entries.filter { $0.book == book }.count,
                            dueCount: dueCount(in: book)
                        )
                    }
                }
                .padding()
            }
        }
    }
}

/// 词库行：向左滑动露出「默认 / 置顶」两个操作
struct BookRow: View {
    let book: String
    let wordCount: Int
    let dueCount: Int
    @EnvironmentObject var appState: AppState
    @State private var offsetX: CGFloat = 0
    @State private var dragStartX: CGFloat = 0
    @State private var isTracking = false
    @State private var confirmDelete = false

    private var isDefault: Bool { appState.settings.defaultBooks.contains(book) }
    private var isPinned: Bool { appState.settings.pinnedBooks.contains(book) }
    private var isOpen: Bool { offsetX < -8 }

    private var displayName: String {
        let base = (book as NSString).lastPathComponent
        return base.hasSuffix(".canvas") ? String(base.dropLast(".canvas".count)) : base
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .trailing) {
                // 动作层：平时完全隐藏，只有向左滑动后才浮现
                HStack(spacing: 0) {
                    actionButton(isDefault ? "取消默认" : "默认", active: isDefault, color: .purple) { toggleDefault() }
                    actionButton(isPinned ? "取消置顶" : "置顶", active: isPinned, color: .orange) { togglePinned() }
                }
                .allowsHitTesting(isOpen)
                .opacity(isOpen ? 1 : 0)
                .animation(.easeOut(duration: 0.16), value: isOpen)

                // 前景行：只负责渲染，不挂任何手势，避免挡住身后的按钮
                HStack {
                    VStack(alignment: .leading, spacing: 2) {
                        HStack(spacing: 5) {
                            Text(book).fontWeight(.medium).lineLimit(1)
                            if isDefault {
                                Text("（默认）")
                                    .font(.caption2.weight(.semibold))
                                    .foregroundStyle(.red)
                            }
                        }
                        Text("\(wordCount) 词")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Text("待复习 \(dueCount)").font(.caption).foregroundStyle(.red)
                }
                .padding()
                // 不透明前景：遮住背后的按钮，避免透明材质与按钮图层重叠
                .background(Color(.systemBackground), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .shadow(color: .black.opacity(isOpen ? 0.12 : 0), radius: 5, x: isOpen ? -3 : 0, y: 1)
                .offset(x: offsetX)
            }
            .contentShape(Rectangle())
            .gesture(
                DragGesture(minimumDistance: 12)
                    .onChanged { value in
                        if !isTracking {
                            isTracking = true
                            dragStartX = offsetX
                        }
                        offsetX = min(0, max(-160, dragStartX + value.translation.width))
                    }
                    .onEnded { value in
                        let projected = dragStartX + value.translation.width
                        isTracking = false
                        withAnimation(.spring(duration: 0.3)) {
                            offsetX = projected < -45 ? -160 : 0
                        }
                    }
            )
            .gesture(
                SpatialTapGesture()
                    .onEnded { value in
                        if offsetX != 0 {
                            // 点在已露出的按钮区时交给按钮处理；否则轻点收回
                            if value.location.x < geo.size.width - 160 {
                                withAnimation(.spring(duration: 0.3)) { offsetX = 0 }
                            }
                        } else {
                            appState.showLibrary(book: book)
                        }
                    }
            )
        }
        .frame(height: 70)
        .clipShape(RoundedRectangle(cornerRadius: 18, style: .continuous))
        .overlay(alignment: .topLeading) {
            if isPinned {
                Image(systemName: "pin.fill")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.orange)
                    .rotationEffect(.degrees(-32))
                    .padding(6)
                    .background(Circle().fill(Color(.systemBackground)))
                    .shadow(color: .black.opacity(0.18), radius: 2, y: 1)
                    .offset(x: -5, y: -8)
                    .transition(.scale.combined(with: .opacity))
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                confirmDelete = true
            } label: {
                Label("删除词库", systemImage: "trash")
            }
        }
        .alert("删除词库「\(displayName)」？", isPresented: $confirmDelete) {
            Button("删除", role: .destructive) {
                Task { await appState.sync.deleteBook(book) }
            }
            Button("取消", role: .cancel) {}
        } message: {
            Text("将删除该词库在 iCloud 中的 Canvas 和复习进度文件，电脑端同步后也会移除，此操作不可恢复。")
        }
        .animation(.spring(duration: 0.32), value: isPinned)
    }

    private func actionButton(_ title: String, active: Bool, color: Color, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.subheadline.bold())
                .foregroundStyle(.white)
                .frame(width: 80, height: 70)
                .background(active ? color : color.opacity(0.55))
        }
        .buttonStyle(.plain)
    }

    private func toggleDefault() {
        if isDefault {
            appState.settings.defaultBooks.removeAll { $0 == book }
        } else {
            appState.settings.defaultBooks.append(book)
        }
    }

    private func togglePinned() {
        if isPinned {
            appState.settings.pinnedBooks.removeAll { $0 == book }
        } else {
            appState.settings.pinnedBooks.append(book)
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
    let isActive: Bool

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
            CartoonAnimal(name: animal, delay: delay, isActive: isActive)
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
    let isActive: Bool
    @State private var visible = false
    @State private var point: CGPoint = .zero
    @State private var tick: Int

    private let timer = Timer.publish(every: 0.55, on: .main, in: .common).autoconnect()

    init(name: String, delay: Double, isActive: Bool) {
        self.name = name
        self.delay = delay
        self.isActive = isActive
        _tick = State(initialValue: Int(delay / 0.55))
    }

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .topLeading) {
                Image(name)
                    .resizable()
                    .scaledToFit()
                    .frame(width: 36, height: 36)
                    .rotationEffect(.degrees(visible ? 0 : -12))
                    .scaleEffect(visible ? 1 : 0.45)
                    .opacity(visible ? 1 : 0)
                    .offset(x: point.x, y: point.y)
            }
            .onAppear {
                point = randomPoint(in: geo.size)
            }
            .onReceive(timer) { _ in
                // 不在学习页时停止更新动画，避免后台 Tab 每 0.55 秒触发一次重绘
                guard isActive else { return }
                let shouldShow = tick % 2 == 0
                if shouldShow {
                    point = randomPoint(in: geo.size)
                }
                withAnimation(.spring(duration: 0.42, bounce: 0.45)) {
                    visible = shouldShow
                }
                tick += 1
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
