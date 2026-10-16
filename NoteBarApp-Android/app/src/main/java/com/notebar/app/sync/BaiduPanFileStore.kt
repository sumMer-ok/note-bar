package com.notebar.app.sync

import com.notebar.engine.sync.FileMeta
import com.notebar.engine.sync.FileStore

/**
 * [FileStore] 的百度网盘实现：把 engine 的同步端口接到网盘上。
 *
 * ## 远端布局（**照抄桌面端 provider 的实际行为**，含它的不对称）
 * 桌面端 `BaiduPanProvider` 上传时用了两个不同的命名函数：
 * - Canvas 走 `remoteBaseName()` → `/apps/<dir>/Words/<文件名>.canvas`
 * - 边车走 `remoteSidecarName()`，**保留词库的相对目录前缀** → `/apps/<dir>/Words/Words/<文件名>.nb-sync.json`
 *
 * （见 `src/sync/baidu-pan-provider.ts` L39-46 与 `tests/sync/baidu-pan-provider.test.ts`
 * L348-351、L419：两端测试里的远端路径正是这两个形状。canvas 与 sidecar 落在不同层级是
 * 桌面端的既有事实，不是笔误——本实现按事实复刻，否则边车通道无法互通。）
 *
 * 为了让 engine「同一目录里既有 .canvas 又有同名 .nb-sync.json」的假设成立，
 * [list] 会把这两层**合并成一份虚拟列表**返回。
 *
 * ## 与 engine 端口契约的对齐
 * - [list]：目录不存在 → null（枚举失败）；目录存在但为空 → 空列表。
 *   例外：远端同步根 `/apps/<dir>/Words` 与它下面的边车目录是同步层自己负责创建的，
 *   首次同步时「不存在」等价于「还没有文件」→ 返回空列表（否则首次同步会报权限错误）。
 * - [readText]：不存在 → null；真失败也返回 null（端口契约只有 null），**但必须可见**（[lastError]）。
 * - [writeAtomic]：端口承诺 temp + rename。网盘没有 rename 语义（`filemanager` 的 move 是
 *   跨目录异步任务，不能当原子替换用），因此落成「上传（ondup=overwrite）→ 回读校验长度」。
 *   校验失败一律返回 false，**绝不谎报成功**——engine 的 `writeSidecar` 正是靠回读发现这类失败。
 * - [delete]：文件本就不存在时返回 true（与 [LocalFileStore] 的幂等语义一致）。
 *
 * ## 沙箱
 * 所有路径都经 [BaiduPanClient] 的沙箱守卫；越界**不做静默降级**：记入 [lastError]
 * 并返回失败，由调用方把失败暴露给用户。（端口契约是「不抛异常」，因此这里不把
 * [BaiduPanSandboxError] 抛给 engine；但错误信息里明确写「沙箱越界」。）
 */
class BaiduPanFileStore(
    private val client: BaiduPanClient,
    /** 网盘同步根：桌面端 provider 的 `wordsDir`，即 `/apps/<dir>/Words` */
    private val remoteRoot: String = client.wordsDir,
    /** engine 传给本 store 的同步根；与 [remoteRoot] 对应，用来做前缀换算 */
    private val localRoot: String = remoteRoot,
) : FileStore {

    /** 最近一次失败的可读原因（UI/日志用）；任何一次成功都会清空，与桌面端 provider 同口径 */
    @Volatile
    var lastError: String? = null
        private set

    /** 本 store 使用的网盘同步根（沙箱校验由 client 负责） */
    val wordsDir: String get() = remoteRoot

    /**
     * 边车在网盘上的**嵌套**目录：`<同步根>/Words`。
     * 桌面端 `remoteSidecarName()` 保留了词库的 `Words/` 前缀，边车实际落在这里。
     */
    val remoteSidecarDir: String get() = "$remoteRoot/${BaiduPanConfig.WORDS_SUBDIR}"

    /**
     * 该后端的逻辑前缀：**固定为空串**（见 [LOGICAL_PREFIX]）。
     * 用它替代 engine 的启发式探测，避免首次同步时物理路径多出一层 `Words/`。
     */
    val logicalPrefix: String get() = LOGICAL_PREFIX

    private fun reportError(message: String) {
        lastError = sanitizeMessage(message, listOf(client.config.accessToken, client.config.appKey))
    }

    private fun clearError() {
        lastError = null
    }

    /**
     * engine 的物理路径 → 网盘路径。
     *
     * `<同步根>/AI.canvas`            → `/apps/<dir>/Words/AI.canvas`
     * `<同步根>/AI.nb-sync.json`      → `/apps/<dir>/Words/Words/AI.nb-sync.json`（桌面端不对称布局）
     * `<同步根>/Words/AI.canvas`      → `/apps/<dir>/Words/AI.canvas`（前缀被归一化掉）
     *
     * 不在 [localRoot] 之下的绝对路径**按网盘路径放行**（不前缀化）：那样它会被沙箱守卫
     * 如实拦下；把外来路径硬拼到 remoteRoot 之下反而会「洗白」一次越界访问。
     */
    fun remotePathOf(logicalPath: String): String {
        val root = localRoot.trimEnd('/')
        if (root.isEmpty()) return logicalPath
        val relative = when {
            logicalPath == root -> ""
            logicalPath.startsWith("$root/") -> logicalPath.removePrefix("$root/")
            // 已经在网盘上（或完全无关的绝对路径）：交给沙箱守卫判断，不做前缀拼接
            logicalPath.startsWith("/") -> return logicalPath
            else -> logicalPath
        }
        // engine 在 prefix 为空时本不该产出 Words/ 前缀，但写边车/删词库等入口可能按逻辑名
        // （`Words/xxx.canvas`）传进来，这里统一归一化，避免出现 Words/Words 的双层嵌套
        val name = relative.removePrefix("${BaiduPanConfig.WORDS_SUBDIR}/")
        if (name.isEmpty()) return remoteRoot
        return if (name.endsWith(SIDECAR_SUFFIX)) "$remoteSidecarDir/$name" else "$remoteRoot/$name"
    }

    /** 网盘路径 → engine 的物理路径（反算，供诊断与单测） */
    fun logicalPathOf(remotePath: String): String {
        val root = localRoot.trimEnd('/')
        return when {
            remotePath == remoteRoot -> root
            remotePath.startsWith("$remoteSidecarDir/") ->
                "$root/${remotePath.removePrefix("$remoteSidecarDir/")}"
            remotePath.startsWith("$remoteRoot/") ->
                "$root/${remotePath.removePrefix("$remoteRoot/")}"
            else -> remotePath
        }
    }

    override fun list(dir: String): List<FileMeta>? {
        val remote = remotePathOf(dir)
        try {
            if (remote == remoteRoot) {
                // 同步根：词库在根下，边车在根下的 Words/ 里 → 合并成一份虚拟列表。
                // 同步根与边车目录都由同步层创建，首次同步时「不存在」等价于「还没有文件」，
                // 不能报成权限失败（那会把「还没同步过」误报成「目录不可用」）。
                // 但沙箱根本身（应用授权产物）不存在时，必须如实返回失败。
                val rootEntries = listRaw(remote)
                if (rootEntries == null && listRaw(client.sandboxRoot) == null) {
                    reportError("网盘同步目录不存在或不可读：$remote")
                    return null
                }
                val sidecarEntries = listRaw(remoteSidecarDir) ?: emptyList()
                clearError()
                return ((rootEntries ?: emptyList()) + sidecarEntries).distinctBy { it.name }
            }
            val entries = listRaw(remote)
            if (entries == null) {
                // 同步层自己创建的目录：首次同步时「不存在」等价于「还没有文件」
                if (isSyncOwnedDir(remote)) {
                    clearError()
                    return emptyList()
                }
                reportError("网盘目录不存在或不可读：$remote")
                return null
            }
            clearError()
            return entries
        } catch (error: BaiduPanError) {
            reportError("列出网盘目录失败：${error.message}")
            return null
        }
    }

    override fun readText(path: String): String? {
        val remote = remotePathOf(path)
        try {
            val meta = client.fileMeta(remote)
            if (meta == null || meta.isDir) {
                clearError()
                return null
            }
            val bytes = client.downloadFile(remote)
            clearError()
            return String(bytes, Charsets.UTF_8)
        } catch (error: BaiduPanError) {
            // 端口契约只有 null 一种失败表示（对应 iOS 的 `try?`）。文件不存在属于正常情况，
            // 不该告警；沙箱越界与网络/配额失败是必须让用户看见的真失败。
            if (!isMissingFile(error)) reportError("读取网盘文件失败：${error.message}")
            return null
        }
    }

    /**
     * 原子写：先确保父目录存在，再上传并**回读校验长度**。
     *
     * 父目录必须补齐：engine 的 `writeSidecar` 会直接写边车路径，而边车落在嵌套的
     * `Words/` 目录里，该目录只在首次同步收尾时才创建。不补目录的话错峰会以
     * errno -9/31066（很难读懂）冒出来。
     */
    override fun writeAtomic(path: String, text: String): Boolean {
        val remote = remotePathOf(path)
        return try {
            val parent = remote.substringBeforeLast('/', "")
            if (parent.isNotEmpty() && parent != client.sandboxRoot) client.ensureFolder(parent)

            val bytes = text.toByteArray(Charsets.UTF_8)
            client.uploadFile(remote, bytes, ondup = "overwrite")

            // 回读校验：上传「成功」但内容被截断/被并发覆盖时，必须如实返回 false。
            // 网盘没有 rename，这道校验就是本 store 的原子性等价物。
            val verify = client.fileMeta(remote)
            if (verify == null || verify.size != bytes.size.toLong()) {
                reportError(
                    "网盘写入校验失败：$remote（期望 ${bytes.size} 字节，实际 ${verify?.size ?: -1}）",
                )
                false
            } else {
                clearError()
                true
            }
        } catch (error: BaiduPanError) {
            reportError("写入网盘失败：${error.message}")
            false
        }
    }

    override fun delete(path: String): Boolean {
        val remote = remotePathOf(path)
        return try {
            if (client.fileMeta(remote) == null) {
                // 本就不存在：与 LocalFileStore 的幂等语义一致，算成功
                clearError()
                return true
            }
            client.deleteFile(remote)
            clearError()
            true
        } catch (error: BaiduPanError) {
            if (isMissingFile(error)) {
                clearError()
                return true
            }
            reportError("删除网盘文件失败：${error.message}")
            false
        }
    }

    override fun exists(path: String): Boolean {
        val remote = remotePathOf(path)
        return try {
            val exists = client.fileMeta(remote) != null
            clearError()
            exists
        } catch (error: BaiduPanError) {
            reportError("查询网盘文件失败：${error.message}")
            false
        }
    }

    // ---------------------------------------------------------------- 内部

    /** 列一层目录；目录不存在/不可读返回 null（不告警，由调用方决定语义） */
    private fun listRaw(remoteDir: String): List<FileMeta>? = try {
        val meta = client.fileMeta(remoteDir)
        if (meta == null || !meta.isDir) {
            null
        } else {
            client.listDir(remoteDir).map { entry ->
                FileMeta(
                    name = entry.name,
                    isDirectory = entry.isDir,
                    // 网盘 mtime 为秒级，且可能为 0（未知）；与 LocalFileStore 同口径转为 null
                    mtime = entry.serverMtimeMs.takeIf { it > 0 },
                    size = if (entry.isDir) 0L else entry.size,
                )
            }
        }
    } catch (error: BaiduPanError) {
        null
    }

    /** 同步层自己负责创建的目录：首次同步时「不存在」等价于「还没有文件」 */
    private fun isSyncOwnedDir(remote: String): Boolean =
        remote == remoteRoot || remote == remoteSidecarDir

    /** 文件不存在类 errno：-3 文件不存在 / -9 文件或目录不存在 / 31066 文件名不存在 */
    private fun isMissingFile(error: BaiduPanError): Boolean =
        error.errno == -3L || error.errno == -9L || error.errno == 31066L

    companion object {
        /** 与 engine 契约一致的边车后缀 */
        const val SIDECAR_SUFFIX = ".nb-sync.json"

        /**
         * 网盘后端的逻辑前缀：固定空串。
         *
         * engine 的 `logicalPrefixFor` 是「目录里有没有 .canvas」的启发式探测，首次同步
         * （远端还空着）时会把网盘根误判成 `Words/`，导致物理路径多一层 `Words/`，
         * 与后续路径不一致。网盘布局是**已知的**（词库在同步根下、边车在同步根/Words 下），
         * 因此由后端自己声明，不走探测。
         */
        const val LOGICAL_PREFIX = ""
    }
}
