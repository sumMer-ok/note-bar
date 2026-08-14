import Foundation

enum BookmarkStore {
    private static let key = "sync-folder-bookmark"

    static func save(_ bookmark: Data) {
        UserDefaults.standard.set(bookmark, forKey: key)
    }

    static func load() -> Data? {
        UserDefaults.standard.data(forKey: key)
    }

    /// 恢复安全作用域书签；过期（stale）或失败返回 nil（调用方引导重新授权）
    static func resolve() -> URL? {
        guard let data = load() else { return nil }
        var stale = false
        do {
            let url = try URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale)
            // iCloud 文件提供者的书签经常被标记 stale，但仍能正确解析并取得访问权限；
            // 只有真正拿不到访问权限才视为失败。
            let scoped = url.startAccessingSecurityScopedResource()
            if stale {
                NSLog("[BookmarkStore] bookmark is stale but resolvable: %@", url.path)
                // 用当前 URL 重新生成书签，避免每次启动都带 stale 标记
                if let refreshed = try? url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil) {
                    save(refreshed)
                }
            }
            return scoped ? url : nil
        } catch {
            NSLog("[BookmarkStore] resolve error: %@", String(describing: error))
            return nil
        }
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
