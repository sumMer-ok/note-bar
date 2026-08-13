import SwiftUI
import SwiftData

struct StatsView: View {
    @Query private var entries: [Entry]
    @State private var selectedDay: String?

    private var byDay: [String: [DayRecord]] {
        var map: [String: [DayRecord]] = [:]
        for entry in entries {
            for record in entry.history ?? [] {
                let day = String(record.date.prefix(10))
                map[day, default: []].append(DayRecord(word: entry.word, quality: record.quality))
            }
        }
        return map
    }

    private var streak: Int {
        let days = Set(byDay.keys)
        var count = 0
        var cursor = FSRS.startOfDay(Date())
        while days.contains(FSRS.dayString(cursor)) {
            count += 1
            cursor = Calendar.current.date(byAdding: .day, value: -1, to: cursor)!
        }
        return count
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        statCard("连续天数", "\(streak)")
                        statCard("今日复习", "\(byDay[FSRS.dayString(Date())]?.count ?? 0)")
                    }
                    Text("日历").font(.headline)
                    CalendarGrid(byDay: byDay, selected: $selectedDay)
                    if let selectedDay {
                        Text("\(selectedDay) · 复习 \(byDay[selectedDay]?.count ?? 0) 词")
                            .font(.headline)
                        ForEach(byDay[selectedDay] ?? [], id: \.self) { record in
                            HStack {
                                Text(record.word)
                                Spacer()
                                Text(qualityLabel(record.quality)).font(.caption).foregroundStyle(.secondary)
                            }
                            .padding(.horizontal)
                        }
                    }
                    Text("近 18 周热力图").font(.headline)
                    Heatmap(byDay: byDay)
                }
                .padding()
            }
            .navigationTitle("统计")
        }
    }

    private func statCard(_ title: String, _ value: String) -> some View {
        VStack {
            Text(value).font(.title.bold())
            Text(title).font(.caption).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
        .glassCard()
    }

    private func qualityLabel(_ q: String) -> String {
        switch q {
        case "again": return "不认识"
        case "hard": return "模糊"
        case "easy": return "太简单"
        default: return "认识"
        }
    }
}

struct DayRecord: Hashable {
    var word: String
    var quality: String
}

struct CalendarGrid: View {
    let byDay: [String: [DayRecord]]
    @Binding var selected: String?

    var body: some View {
        let weeks = weeksOfCurrentMonth()
        VStack(spacing: 4) {
            HStack {
                ForEach(["一", "二", "三", "四", "五", "六", "日"], id: \.self) { Text($0).font(.caption2).frame(maxWidth: .infinity) }
            }
            ForEach(weeks, id: \.self) { week in
                HStack {
                    ForEach(week, id: \.self) { day in
                        if let day {
                            let key = FSRS.dayString(day)
                            let has = (byDay[key]?.count ?? 0) > 0
                            Button {
                                selected = selected == key ? nil : key
                            } label: {
                                Text("\(Calendar.current.component(.day, from: day))")
                                    .frame(maxWidth: .infinity, minHeight: 30)
                                    .background(has ? Color.blue : Color.clear, in: RoundedRectangle(cornerRadius: 8))
                                    .foregroundStyle(has ? .white : .primary)
                            }
                            .buttonStyle(.plain)
                        } else {
                            Color.clear.frame(maxWidth: .infinity, minHeight: 30)
                        }
                    }
                }
            }
        }
        .padding()
        .glassCard()
    }

    private func weeksOfCurrentMonth() -> [[Date?]] {
        let cal = Calendar.current
        let now = Date()
        let range = cal.range(of: .day, in: .month, for: now)!
        let first = cal.date(from: cal.dateComponents([.year, .month], from: now))!
        let weekday = cal.component(.weekday, from: first) // 1=周日
        let leading = (weekday + 5) % 7
        var cells: [Date?] = Array(repeating: nil, count: leading)
        for day in range { cells.append(cal.date(byAdding: .day, value: day - 1, to: first)) }
        while cells.count % 7 != 0 { cells.append(nil) }
        return stride(from: 0, to: cells.count, by: 7).map { Array(cells[$0..<$0 + 7]) }
    }
}

struct Heatmap: View {
    let byDay: [String: [DayRecord]]

    var body: some View {
        let days = last18Weeks()
        let columns = Array(repeating: GridItem(.flexible(), spacing: 3), count: 18)
        LazyVGrid(columns: columns, spacing: 3) {
            ForEach(days, id: \.self) { day in
                let count = byDay[FSRS.dayString(day)]?.count ?? 0
                RoundedRectangle(cornerRadius: 3)
                    .fill(color(count))
                    .aspectRatio(1, contentMode: .fit)
            }
        }
        .padding()
        .glassCard()
    }

    private func last18Weeks() -> [Date] {
        let cal = Calendar.current
        let today = FSRS.startOfDay(Date())
        let start = cal.date(byAdding: .day, value: -17 * 7, to: today)!
        return (0..<(18 * 7)).map { cal.date(byAdding: .day, value: $0, to: start)! }
    }

    private func color(_ count: Int) -> Color {
        switch count {
        case 0: return Color.gray.opacity(0.12)
        case 1...3: return Color.green.opacity(0.35)
        case 4...9: return Color.green.opacity(0.65)
        default: return Color.green
        }
    }
}
