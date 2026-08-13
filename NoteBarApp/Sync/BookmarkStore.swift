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
        guard let url = try? URL(resolvingBookmarkData: data, options: [], relativeTo: nil, bookmarkDataIsStale: &stale),
              !stale else { return nil }
        return url.startAccessingSecurityScopedResource() ? url : nil
    }

    static func clear() {
        UserDefaults.standard.removeObject(forKey: key)
    }
}
