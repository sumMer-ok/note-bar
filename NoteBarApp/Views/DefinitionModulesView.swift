import SwiftUI

/// 释义模块展示：按用户设置的顺序排列，模块间用横线分隔
struct DefinitionModulesView: View {
    let raw: String
    var order: [DefinitionModule] = DefinitionModule.allCases
    var onEdit: ((DefinitionModule) -> Void)?

    var body: some View {
        let items = DefinitionSections.modules(raw, order: order)
        VStack(alignment: .leading, spacing: 0) {
            if items.isEmpty {
                Text(raw.isEmpty ? "（无释义）" : raw)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(Array(items.enumerated()), id: \.offset) { index, item in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text(item.module.rawValue).font(.headline)
                            Spacer()
                            if let onEdit {
                                Button("编辑") { onEdit(item.module) }
                                    .font(.caption)
                            }
                        }
                        Text(item.content)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .padding(.vertical, 10)
                    if index < items.count - 1 {
                        Divider()
                    }
                }
            }
        }
    }
}
