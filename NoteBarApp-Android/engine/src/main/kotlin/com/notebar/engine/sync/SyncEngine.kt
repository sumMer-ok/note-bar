package com.notebar.engine.sync

import com.notebar.engine.CanvasEditor
import com.notebar.engine.Entry
import com.notebar.engine.Merge
import com.notebar.engine.NoteBarJson
import com.notebar.engine.ParsedWord
import com.notebar.engine.SidecarFile
import com.notebar.engine.StudyKey
import com.notebar.engine.StudyProgress
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import java.time.Instant
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit

/**
 * 同步编排的纯逻辑层，逐函数移植自 `NoteBarApp/Sync/SyncService.swift`。
 *
 * 本类**不持有任何词条存储**（iOS 里是 SwiftData），也不做文件 IO：
 * - 文件访问一律经 [FileStore] 端口；
 * - 词条存储由调用方持有，本类以「传入词条、返回合并结果」的纯函数形式工作
 *   （对应 iOS 的 `store.entry(forKey:)` 读 + `store.context.save()` 写）。
 *
 * 有意未移植的 iOS 行为（属宿主/并发职责，非纯逻辑，交由 Phase 4 的 [FileStore] 实现）：
 * - `scanning` 重入闸门：纯逻辑同步执行，不存在并发重入；
 * - `syncDir = nil`（权限失效后清空缓存目录）、安全作用域、NSFileCoordinator 协调、
 *   `Task.detached` 后台线程；
 * - `readCanvas` / `writeCanvas` / `deleteBook` / `pushLocalEntry` / `persist` 的异步包装。
 *
 * 冲突副本命名规律（`<名> <n>.ext`）由 [Merge.isConflictCopy] / [Merge.conflictBaseName] 提供。
 */
class SyncEngine {

    /**
     * 上一次扫描时各词库的 (canvas, sidecar) 修改时间；用于「未变化则跳过」。
     * 对应 iOS `SyncService.lastMtimes`。key 是逻辑名 `Words/xxx.canvas`。
     */
    private val lastMtimes = mutableMapOf<String, MtimePair>()

    /** 对应 iOS `lastMtimes` 的元组 `(canvas: Date?, sidecar: Date?)`；null 表示文件缺失 */
    data class MtimePair(val canvas: Long?, val sidecar: Long?)

    /** 单测/宿主可用它强制忘记某个词库的 mtime（对应 iOS `deleteBook` / `resolve` 里的 `removeValue`） */
    fun forgetMtime(book: String) {
        lastMtimes.remove(book)
    }

    // ---------------------------------------------------------------- 扫描

    /**
     * 全量扫描：只列词库目录这一层，读 canvas 与同名边车，识别冲突副本，
     * 并用 mtime 闸门挑出真正需要合并的词库。
     *
     * 对应 iOS `SyncService.scan()` 的**文件层**部分（L105-140、L172-186）：
     * - `collect` 返回 null → 目录权限不可用，[SyncScanResult.status] 为 [SyncStatus.SCAN_FAILED]；
     * - 与上次 mtime 完全一致（canvas 与 sidecar 都比对）→ 不进 [SyncScanResult.changed]；
     * - 每个处理过的词库都会刷新 [lastMtimes]（与 iOS 一样，先落 mtime 再合并）。
     *
     * iOS 在 `root()` 为 nil 时的两条提示（未选择目录 / 无法访问目录）依赖书签状态，
     * 属调用方知识，由 [SyncStatus.MISSING_DIRECTORY] / [SyncStatus.INACCESSIBLE_DIRECTORY] 常量透传。
     *
     * @param root 同步目录（iOS 里用户选中的 NoteBar 或 Words 目录）
     * @param logicalPrefix `"Words/"` 或 `""`，一般由 [logicalPrefixFor] 决定
     */
    fun scan(store: FileStore, root: String, logicalPrefix: String): SyncScanResult {
        val payload = collect(store, root, logicalPrefix)
            ?: return SyncScanResult(
                snapshots = emptyList(),
                conflicts = emptyList(),
                changed = emptyList(),
                status = SyncStatus(SyncStatus.SCAN_FAILED),
            )

        val changed = ArrayList<CanvasSnapshot>()
        for (snapshot in payload.snapshots) {
            // 逐字对应 iOS：`previous?.canvas == snapshot.canvasMtime, previous?.sidecar == ...`
            // 注意 Swift 的可选比较是 `nil == nil → true`，所以 key 尚不存在（previous 为 nil）
            // 且快照两个 mtime 也都是 nil 时，这里同样 `continue` 跳过——不得改成
            // 「previous 存在才比对」，那是行为差异而非等价实现。
            val previous = lastMtimes[snapshot.relative]
            if (previous?.canvas == snapshot.canvasMtime &&
                previous?.sidecar == snapshot.sidecarMtime
            ) {
                continue
            }
            lastMtimes[snapshot.relative] = MtimePair(snapshot.canvasMtime, snapshot.sidecarMtime)
            changed.add(snapshot)
        }

        return SyncScanResult(
            snapshots = payload.snapshots,
            conflicts = payload.conflicts,
            changed = changed,
            status = SyncStatus.connected(
                rootName = lastPathComponent(root),
                time = SyncStatus.timeString(),
            ),
        )
    }

    /** 对应 iOS `collect(root:logicalPrefix:)` 的返回元组 */
    data class CollectPayload(
        val snapshots: List<CanvasSnapshot>,
        val conflicts: List<SyncConflict>,
    )

    /**
     * 目录枚举 + 边车解析 + 冲突副本识别。
     *
     * 逐行对应 iOS `SyncService.collect`（L386-478）。返回 null 表示目录不可用
     * （对应 iOS 枚举失败返回 nil，调用方提示用户重新授权）。
     *
     * 关键口径：
     * - 词库固定在 `<root>/Words/` 下且没有更深层级，**只列这一层**，
     *   避免把 `Words/Words/...` 错误嵌套当成新词库；
     * - 逻辑名一律是 `Words/<文件名>`（与桌面插件契约一致）；
     * - 边车按**文件内声明的 `book` 字段**建索引，而快照按 `relative` 取用，
     *   两者不一致时该词库就取不到进度（与 iOS 一致，不做模糊匹配）；
     * - 冲突副本不进 `canvases` / `sidecars`，只产出 [SyncConflict]。
     */
    fun collect(store: FileStore, root: String, logicalPrefix: String): CollectPayload? {
        val rootEntries = store.list(root) ?: return null

        val files: List<FileMeta> = if (logicalPrefix == "$WORDS_DIR/") {
            val wordsEntry = rootEntries.firstOrNull { it.name == WORDS_DIR }
            if (wordsEntry == null || !wordsEntry.isDirectory) {
                // iOS：词库目录不存在时 files 为空数组（而非枚举失败）
                emptyList()
            } else {
                // iOS：Words 目录存在但枚举失败 → 返回 nil，提示重新授权
                store.list(join(root, WORDS_DIR)) ?: return null
            }
        } else {
            rootEntries
        }

        val sidecars = mutableMapOf<String, SidecarFile>()
        val canvasMtimes = mutableMapOf<String, Long?>()
        val sidecarMtimes = mutableMapOf<String, Long?>()
        val canvases = ArrayList<Pair<String, String>>() // (relative, path)
        val conflicts = ArrayList<SyncConflict>()

        for (file in files) {
            val path = pathOf(root, logicalPrefix, file.name)
            val relative = "$WORDS_DIR/${file.name}"
            val ext = extensionOf(file.name).lowercase()
            val mtime = file.mtime

            if (ext == "canvas") {
                val base = conflictBase(file.name, ".canvas")
                if (base != null) {
                    val mainPath = join(dirOfPath(path), base)
                    conflicts.add(
                        SyncConflict(
                            book = "$WORDS_DIR/$base",
                            kind = SyncConflictKind.CANVAS,
                            mainPath = mainPath,
                            conflictPath = path,
                            mainUpdatedAt = mtimeOf(store, mainPath),
                            conflictUpdatedAt = mtime,
                            mainWords = canvasWords(store, mainPath),
                            conflictWords = canvasWords(store, path),
                        ),
                    )
                } else {
                    canvases.add(relative to path)
                    canvasMtimes[relative] = mtime
                }
            } else if (ext == "json" && file.name.endsWith(SIDECAR_SUFFIX)) {
                val base = Merge.conflictBaseName(file.name)
                if (base != null) {
                    val mainPath = join(dirOfPath(path), base)
                    // iOS：主文件的 book 由 `.../xxx.nb-sync.json` 换成 `.canvas`
                    val book = "$WORDS_DIR/$base".replace(Regex("\\.nb-sync\\.json$"), ".canvas")
                    conflicts.add(
                        SyncConflict(
                            book = book,
                            kind = SyncConflictKind.SIDECAR,
                            mainPath = mainPath,
                            conflictPath = path,
                            mainUpdatedAt = mtimeOf(store, mainPath),
                            conflictUpdatedAt = mtime,
                            mainWords = sidecarWords(store, mainPath),
                            conflictWords = sidecarWords(store, path),
                        ),
                    )
                } else {
                    val sidecar = store.readText(path)?.let { decodeSidecar(it) }
                    if (sidecar != null) {
                        sidecars[sidecar.book] = sidecar
                        sidecarMtimes[sidecar.book] = mtime
                    }
                }
            }
        }

        val snapshots = canvases.map { (relative, path) ->
            val text = store.readText(path) ?: ""
            val words = runCatching { CanvasEditor.parseWords(text, source = relative) }
                .getOrDefault(emptyList())
            CanvasSnapshot(
                relative = relative,
                words = words,
                progress = sidecars[relative]?.words ?: emptyMap(),
                canvasMtime = canvasMtimes[relative],
                sidecarMtime = sidecarMtimes[relative],
            )
        }
        return CollectPayload(snapshots, conflicts)
    }

    /**
     * 用户选中 NoteBar 目录时为 `"Words/"`；直接选中 Words 目录本身时为空串。
     * 对应 iOS `SyncService.logicalPrefix(for:)`（L345-350）：目录里直接有 `.canvas` 就认为选的是 Words。
     */
    fun logicalPrefixFor(store: FileStore, root: String): String {
        val entries = store.list(root) ?: emptyList()
        val hasCanvasDirectly = entries.any { it.name.lowercase().endsWith(".canvas") }
        return if (hasCanvasDirectly) "" else "$WORDS_DIR/"
    }

    /**
     * 逻辑名 → 物理路径。对应 iOS `SyncService.physicalURL(for:suffix:replacingExtension:)`。
     *
     * 例：书 `Words/words.canvas`、suffix `.nb-sync.json`、ext `.canvas`、prefix `"Words/"`
     * → `<root>/Words/words.nb-sync.json`。选的是 Words 目录本身时（prefix 为空）落在 root 下，
     * **不会**写出 `Words/Words` 嵌套。
     */
    fun physicalPath(
        root: String,
        logicalPrefix: String,
        logical: String,
        suffix: String,
        replacingExtension: String?,
    ): String {
        var name = logical
        if (name.startsWith("$WORDS_DIR/")) name = name.drop("$WORDS_DIR/".length)
        if (replacingExtension != null && name.endsWith(replacingExtension)) {
            name = name.dropLast(replacingExtension.length)
        }
        val base = if (logicalPrefix == "$WORDS_DIR/") join(root, WORDS_DIR) else root
        return join(base, name + suffix)
    }

    // ------------------------------------------------------------ 词条合并

    /**
     * 逐词合并云端内容。逐行对应 iOS `scan()` 的词条循环（L141-167）。
     *
     * 口径（务必与 iOS 一致）：
     * - 词文本/别名/释义：若**本地有未上传编辑**（[Entry.localEditedAt] != null）且三者有差异，
     *   则**保留本地**并标记 `pendingPush`，不被云端旧内容覆盖；
     * - color / addedDate / mastered：无论上面走哪个分支都**始终以云端为准**（iOS 里这几行
     *   位于 if/else 之外）；
     * - 进度：先给远程进度补 `withLegacyFieldsDerived()`，再走 [Merge.progress]；
     * - 云端有、本地无 → 新建词条（对应 `DataStore.upsert` 的 insert 分支，进度用补齐后的远程值）。
     *
     * @param entry 本地已有词条；null 表示本地还没有这个词（对应 iOS `store.entry(forKey:)` 返回 nil）
     * @param remoteProgress 云端进度（**未**经过 legacy 补齐；本函数内部补齐，与 iOS 一致）
     */
    fun applyRemote(
        entry: Entry?,
        word: ParsedWord,
        relative: String,
        remoteProgress: StudyProgress?,
    ): ApplyRemoteResult {
        val key = StudyKey.canvas(source = relative, nodeId = word.nodeId)
        val remote = remoteProgress?.withLegacyFieldsDerived()

        if (entry == null) {
            var created = Entry(
                studyKey = key,
                book = relative,
                source = relative,
                nodeId = word.nodeId,
                word = word.word,
                aliases = word.aliases,
                definition = word.definition,
                color = word.color,
                addedDate = word.addedDate,
                mastered = word.mastered,
            )
            if (remote != null) created = created.withProgress(remote)
            return ApplyRemoteResult(entry = created, pendingPush = false, changed = true)
        }

        var result = entry
        var changed = false
        var pendingPush = false

        val textChanged = entry.word != word.word ||
            entry.definition != word.definition ||
            entry.aliases != word.aliases
        if (textChanged && entry.localEditedAt != null) {
            // 本地编辑还没成功上传：保留本地内容，稍后重新推送，避免被云端旧版覆盖
            pendingPush = true
            changed = true
        } else {
            if (entry.word != word.word) {
                result = result.copy(word = word.word)
                changed = true
            }
            if (entry.definition != word.definition) {
                result = result.copy(definition = word.definition)
                changed = true
            }
            if (entry.aliases != word.aliases) {
                result = result.copy(aliases = word.aliases)
                changed = true
            }
        }

        if (entry.color != word.color) {
            result = result.copy(color = word.color)
            changed = true
        }
        if (entry.addedDate != word.addedDate) {
            result = result.copy(addedDate = word.addedDate)
            changed = true
        }
        if (entry.mastered != word.mastered) {
            result = result.copy(mastered = word.mastered)
            changed = true
        }

        if (remote != null) {
            // local（entry.progress）与 remote 都非空，Merge.progress 必然返回非空
            val merged = Merge.progress(local = entry.progress, remote = remote)!!
            if (merged != entry.progress) {
                result = result.withProgress(merged)
                changed = true
            }
        }

        return ApplyRemoteResult(entry = result, pendingPush = pendingPush, changed = changed)
    }

    /**
     * 便捷入口：按 `nodeId` 在快照里找对应词、按 `studyKey` 找对应云端进度，再走 [applyRemote]。
     * 快照里找不到该词时原样返回（iOS 的删除只发生在清理词库阶段，不在这里删）。
     */
    fun applyRemote(entry: Entry, snapshot: CanvasSnapshot): Entry {
        val word = snapshot.words.firstOrNull { it.nodeId == entry.nodeId } ?: return entry
        return applyRemote(
            entry = entry,
            word = word,
            relative = snapshot.relative,
            remoteProgress = snapshot.progress[entry.studyKey],
        ).entry
    }

    /**
     * 产出「本地已编辑但尚未上传」的词条列表，交给调用方回推云端。
     * 对应 iOS `scan()` 里累积的 `pendingPush`（判定条件见 [applyRemote]）。
     *
     * 回推动作本身（读 canvas → `CanvasEditor.updateWord` → 原子写 → 清 `localEditedAt`）
     * 对应 iOS `pushLocalEntry`，需要写 canvas，属 Phase 4；本阶段只负责**识别**。
     */
    fun collectPendingPush(entries: List<Entry>, snapshot: CanvasSnapshot): List<Entry> {
        val byKey = entries.associateBy { it.studyKey }
        val pending = ArrayList<Entry>()
        for (word in snapshot.words) {
            val key = StudyKey.canvas(source = snapshot.relative, nodeId = word.nodeId)
            val entry = byKey[key] ?: continue
            val textChanged = entry.word != word.word ||
                entry.definition != word.definition ||
                entry.aliases != word.aliases
            if (textChanged && entry.localEditedAt != null) pending.add(entry)
        }
        return pending
    }

    /**
     * 清理「词库」列表：只保留本次扫描实际存在的词库。
     *
     * 对应 iOS `scan()` 的 L172-186：覆盖两种情况——选错目录产生的裸文件名词库，
     * 以及此前递归扫描产生的 `Words/Words/...` 重复词库。
     * **仅在扫描到至少一个词库时清理**，避免目录暂时不可读时误清空本地数据。
     *
     * @return 应保留的词条；[currentBooks] 为空时原样返回全部（即不清理）
     */
    fun pruneMissingBooks(entries: List<Entry>, currentBooks: Set<String>): List<Entry> =
        if (currentBooks.isEmpty()) entries else entries.filter { currentBooks.contains(it.book) }

    // -------------------------------------------------------------- 写边车

    /**
     * 把一个 key 的进度写回边车，并做读回校验；失败重试一次。
     *
     * 对应 iOS `persist`（L210-233）+ `writeProgress`（L502-518）：
     * 读磁盘 → [Merge.progress] 合并 → 原子写 → 回读解析并确认 `lastReview` 与写入值一致。
     *
     * **与 iOS 的差异（按任务约定）**：iOS 重试时只重发写入、**不重新校验**，
     * 因此「写入声称成功但实际没落盘」时 iOS 不会报告失败；这里重试后**再校验一次**，
     * 校验仍不过即返回 false，让上层提示用户（对应 [SyncStatus.PROGRESS_WRITE_FAILED]）。
     *
     * @param path 边车物理路径（由 [physicalPath] 算出）
     */
    fun writeSidecar(
        store: FileStore,
        path: String,
        book: String,
        key: String,
        progress: StudyProgress,
    ): Boolean =
        attemptWriteAndVerify(store, path, book, key, progress) ||
            attemptWriteAndVerify(store, path, book, key, progress)

    private fun attemptWriteAndVerify(
        store: FileStore,
        path: String,
        book: String,
        key: String,
        progress: StudyProgress,
    ): Boolean {
        if (!writeProgress(store, path, book, key, progress)) return false
        val written = store.readText(path)?.let { decodeSidecar(it) } ?: return false
        return written.words[key]?.lastReview == progress.lastReview
    }

    /**
     * 读磁盘 → 合并 → 原子写；对应 iOS `writeProgress`（L502-518）。
     *
     * 注意：写回的是 [Merge.progress] 的**合并结果**，不是入参原值——
     * 磁盘里若已有更新的 `lastReview`，它会胜出（这正是读回校验可能失败的场景）。
     * 边车的 `version` / `book` 沿用磁盘上已有的值，仅新建时才用入参 [book]。
     */
    fun writeProgress(
        store: FileStore,
        path: String,
        book: String,
        key: String,
        progress: StudyProgress,
    ): Boolean {
        val raw = store.readText(path)
        val existing = raw?.let { decodeSidecar(it) }
        val sidecar = existing
            ?: SidecarFile(version = SIDECAR_VERSION, book = book, words = emptyMap(), updatedAt = "")

        val merged = Merge.progress(local = sidecar.words[key], remote = progress)
        val words = LinkedHashMap(sidecar.words)
        if (merged == null) words.remove(key) else words[key] = merged

        val updated = sidecar.copy(words = words, updatedAt = sidecarTimestamp())
        val text = mergeIntoRawSidecar(raw, updated, key)
        return store.writeAtomic(path, text)
    }

    /**
     * 把新的词条进度合并进**原始**边车 JSON，保住一切未知字段。
     *
     * 为什么必须这么做（红线）：桌面端 `writeSidecarAtomic` 是把 `words[key]` 对象原样带回的
     * JSON 合并，词条内的未知字段（桌面端日后新增的字段、其他端的扩展键）会存活；
     * 若这里走强类型 `SidecarFile` 编解码，这些字段会被静默吃掉——等于 Android 单方面
     * 破坏既有数据模型，且用户无从察觉。实测确认过该差异（`FUTURE_FIELD`/嵌套对象丢失）。
     *
     * 顶层未知键也一并保留（桌面端会丢顶层未知键；这里更保守，且不会破坏任何既有字段）。
     * 原文缺失或不是合法 JSON 时，回落到强类型序列化，保证仍能写出合法文件。
     */
    private fun mergeIntoRawSidecar(
        raw: String?,
        updated: SidecarFile,
        writtenKey: String,
    ): String {
        val root = raw?.let {
            runCatching { NoteBarJson.instance.parseToJsonElement(it).jsonObject }.getOrNull()
        } ?: return NoteBarJson.instance.encodeToString(SidecarFile.serializer(), updated)

        val rawWords = LinkedHashMap((root["words"] as? JsonObject) ?: JsonObject(emptyMap()))

        val mergedProgress = updated.words[writtenKey]
        if (mergedProgress == null) {
            rawWords.remove(writtenKey)
        } else {
            val previous = (rawWords[writtenKey] as? JsonObject) ?: JsonObject(emptyMap())
            val encoded = NoteBarJson.instance
                .parseToJsonElement(
                    NoteBarJson.instance.encodeToString(StudyProgress.serializer(), mergedProgress),
                )
                .jsonObject
            val next = LinkedHashMap(previous)
            // 只清理「StudyProgress 认识的、且本次为空」的字段；不认识的一律保留。
            // 早先写成「凡不在本次编码结果里的键都删」会连未知字段一起误删（已由测试钉死）。
            for (field in STUDY_PROGRESS_FIELDS) {
                if (field !in encoded) next.remove(field)
            }
            next.putAll(encoded)
            rawWords[writtenKey] = JsonObject(next)
        }

        val out = LinkedHashMap(root)
        out["version"] = JsonPrimitive(updated.version)
        out["book"] = JsonPrimitive(updated.book)
        out["words"] = JsonObject(rawWords)
        out["updatedAt"] = JsonPrimitive(updated.updatedAt)
        return NoteBarJson.instance.encodeToString(JsonObject.serializer(), JsonObject(out))
    }

    // -------------------------------------------------------- 冲突副本仲裁

    /**
     * 冲突仲裁：保留主版本或保留副本版本。
     *
     * 对应 iOS `resolve`（L312-329）：
     * - `keepCopy = true`：用副本内容替换主文件（iOS 用 `replaceItemAt`），副本随之消失；
     * - `keepCopy = false`：把副本改名归档为 `<副本路径>.resolved-<epoch 秒>`。
     *
     * iOS 用 `FileManager` 的移动/替换语义；[FileStore] 只承诺原子写与删除，
     * 因此替换/改名都实现为「读 → 原子写新路径 → 删除旧路径」，内容一致。
     * 无论成败都会清掉该词库的 mtime 记录，强制下次扫描重新处理（对应 iOS L326）；
     * 调用方随后应重新 [scan]（iOS `resolve` 末尾就是 `await scan()`）。
     */
    fun resolveConflict(store: FileStore, conflict: SyncConflict, keepCopy: Boolean): Boolean {
        val content = store.readText(conflict.conflictPath) ?: return false
        val ok = if (keepCopy) {
            store.writeAtomic(conflict.mainPath, content) && store.delete(conflict.conflictPath)
        } else {
            val archive = "${conflict.conflictPath}.resolved-${Instant.now().epochSecond}"
            store.writeAtomic(archive, content) && store.delete(conflict.conflictPath)
        }
        forgetMtime(conflict.book)
        return ok
    }

    // ---------------------------------------------------------------- 内部

    private fun decodeSidecar(text: String): SidecarFile? = runCatching {
        NoteBarJson.instance.decodeFromString(SidecarFile.serializer(), text)
    }.getOrNull()

    /** 对应 iOS `canvasWords(_:)`：解析 canvas 并返回排序后的词表；失败/缺失返回空 */
    private fun canvasWords(store: FileStore, path: String): List<String> {
        val text = store.readText(path) ?: return emptyList()
        val words = runCatching { CanvasEditor.parseWords(text, source = "") }.getOrNull()
            ?: return emptyList()
        return words.map { it.word }.sorted()
    }

    /** 对应 iOS `sidecarWords(_:)`：边车里的 key 排序列表；失败/缺失返回空 */
    private fun sidecarWords(store: FileStore, path: String): List<String> {
        val sidecar = store.readText(path)?.let { decodeSidecar(it) } ?: return emptyList()
        return sidecar.words.keys.sorted()
    }

    /**
     * 单文件 mtime。iOS 用 `url.resourceValues(forKeys: [.contentModificationDateKey])`
     * 直接取；[FileStore] 只承诺 `list(dir)`，故经父目录枚举取同名项。
     * 父目录不可枚举 / 文件不存在 → null（与 iOS `try?` 的 nil 同义）。
     */
    private fun mtimeOf(store: FileStore, path: String): Long? {
        val dir = dirOfPath(path)
        if (dir.isEmpty()) return null
        return store.list(dir)?.firstOrNull { it.name == lastPathComponent(path) }?.mtime
    }

    /**
     * 对应 iOS `conflictBase(name:suffix:)`：`<名> <n><suffix>` → `<名><suffix>`，否则 null。
     * 正则与 iOS 逐字一致（`^(.+) \d+<转义后缀>$`）。
     * 注意后缀可能是 `.canvas` 或 `.nb-sync.json`；后者由 [Merge.conflictBaseName] 承担。
     */
    private fun conflictBase(name: String, suffix: String): String? {
        val match = Regex("^(.+) \\d+${Regex.escape(suffix)}$").matchEntire(name) ?: return null
        return match.groupValues[1] + suffix
    }

    /** 文件的物理路径：prefix 为 `Words/` 时落在 `<root>/Words/`，否则落在 `<root>/` */
    private fun pathOf(root: String, logicalPrefix: String, fileName: String): String =
        join(if (logicalPrefix == "$WORDS_DIR/") join(root, WORDS_DIR) else root, fileName)

    private fun dirOfPath(path: String): String {
        val i = path.lastIndexOf('/')
        return if (i <= 0) "" else path.substring(0, i)
    }

    private fun extensionOf(name: String): String {
        val i = name.lastIndexOf('.')
        return if (i < 0 || i == name.length - 1) "" else name.substring(i + 1)
    }

    /** 与 iOS `URL.lastPathComponent` 同义 */
    private fun lastPathComponent(path: String): String {
        var p = path
        while (p.length > 1 && p.endsWith("/")) p = p.dropLast(1)
        return p.substringAfterLast('/')
    }

    /**
     * 边车 `updatedAt`：对应 iOS `ISO8601DateFormatter().string(from: Date())`。
     * 该 formatter 默认只精确到**秒**（不输出小数秒），这里 `truncatedTo(SECONDS)` 对齐。
     */
    private fun sidecarTimestamp(instant: Instant = Instant.now()): String =
        DateTimeFormatter.ISO_INSTANT.format(instant.truncatedTo(ChronoUnit.SECONDS))

    private fun join(dir: String, name: String): String = when {
        dir.isEmpty() -> name
        dir.endsWith("/") -> "$dir$name"
        else -> "$dir/$name"
    }

    companion object {
        /** 与桌面插件契约一致的词库目录名 */
        const val WORDS_DIR = "Words"

        /** 边车后缀（与桌面 `SIDECAR_SUFFIX` 一致） */
        const val SIDECAR_SUFFIX = ".nb-sync.json"

        /** 边车版本（与桌面 `SIDECAR_VERSION` 一致） */
        const val SIDECAR_VERSION = 1

        /**
         * `StudyProgress` 拥有的字段名（与 iOS StudyProgress / 桌面 StudyProgressItem 逐字一致）。
         * 写入边车时只允许清理这些字段；不在名单里的键一律视为"未知字段"原样保留，
         * 避免 Android 单方面吃掉其他端写入的扩展数据。
         */
        private val STUDY_PROGRESS_FIELDS = setOf(
            "status", "stage", "reps", "ef", "interval", "s", "d", "lapses",
            "dueDate", "lastReview", "history", "lifecycle", "pinned",
            "masteredAt", "updatedAt",
        )
    }
}
