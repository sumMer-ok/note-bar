import Foundation

/// 刷新 vault 快照的决策结果。
/// 不加 `Equatable`：`VaultConfig` 含数组与可选结构体，本身没有 Equatable，
/// 强行给整棵类型树加 conformance 只为测试不值当——用 switch/pattern matching 断言即可。
public enum VaultRefreshDecision {
    /// 用新快照替换（附带给日志的一行）
    case adopt(loaded: VaultConfig, logLines: [String])
    /// 沿用旧快照（附带给日志的一行）
    case keep(cached: VaultConfig?, logLines: [String])
}

/// 纯决策：给定「上一次快照」与「本次读取结果」，决定要不要替换快照以及写什么日志。
///
/// 抽出来的原因：现场 bug 的核心就是这段回退语义——用户在助手启动后才新增词库时，
/// 过期的快照会让浮窗少列词库；而读盘失败又**不能**把快照清空（否则连浮窗都打不开）。
/// 决策与「真正读盘」拆开后，两个方向都能直接单测。
public func decideVaultRefresh(cached: VaultConfig?,
                               attempt: Result<VaultConfig, Error>) -> VaultRefreshDecision {
    switch attempt {
    case .success(let loaded):
        return .adopt(loaded: loaded, logLines: [vaultSnapshotDescription(loaded)])
    case .failure(let error):
        guard let cached else {
            return .keep(cached: nil, logLines: ["刷新 vault 配置失败且没有可用的旧快照：\(error)"])
        }
        return .keep(cached: cached, logLines: ["刷新 vault 配置失败，沿用上一次的快照：\(error)"])
    }
}

/// 载入状态的一句话描述（成功与失败两条路径共用，避免两套文案漂移）
public func vaultSnapshotDescription(_ config: VaultConfig) -> String {
    "已载入 \(config.enabledCanvasBooks.count) 个启用词库，收件箱=\(config.inboxDir ?? "未配置")"
}
