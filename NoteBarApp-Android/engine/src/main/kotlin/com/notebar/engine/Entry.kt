package com.notebar.engine

/**
 * 手机端词条缓存模型。
 *
 * 字段与 iOS `Entry`（SwiftData 模型）逐字段对应；progress 是把散在 Entry 上的
 * 进度字段打包成 [StudyProgress] 的视图，与 iOS `Entry.progress` 的 get/set 语义一致。
 *
 * 说明：Android 侧持久化用 Room（Phase 2），这里保持纯数据类，便于引擎单测。
 */
data class Entry(
    val studyKey: String,
    val book: String,
    val source: String,
    val nodeId: String,
    val word: String,
    val aliases: List<String> = emptyList(),
    val definition: String = "",
    val color: String? = null,
    val addedDate: String? = null,
    val mastered: Boolean? = false,
    // 进度字段（与 StudyProgress 同名同义）
    val s: Double? = null,
    val d: Double? = null,
    val lapses: Int? = null,
    val dueDate: String? = null,
    val lastReview: String? = null,
    val history: List<ReviewRecord>? = null,
    val lifecycle: String? = null,
    val pinned: Boolean? = null,
    val status: String? = null,
    val stage: Int? = null,
    val firstLearnedDate: String? = null,
    /**
     * 本地编辑时间：非空表示这次编辑还没确认上传到云端，
     * 扫描时优先保留本地内容并重新推送，避免被云端旧内容覆盖。
     * 与 iOS Entry.localEditedAt 对应（iOS 是 Date，这里用 ISO8601 串）。
     */
    val localEditedAt: String? = null,
) {
    /** 把散字段打包为 StudyProgress（对应 iOS Entry.progress getter） */
    val progress: StudyProgress
        get() = StudyProgress(
            status = status,
            stage = stage,
            s = s,
            d = d,
            lapses = lapses,
            dueDate = dueDate,
            lastReview = lastReview,
            history = history,
            lifecycle = lifecycle,
            pinned = pinned,
        )

    /** 用 StudyProgress 回写散字段（对应 iOS Entry.progress setter） */
    fun withProgress(p: StudyProgress): Entry = copy(
        status = p.status,
        stage = p.stage,
        s = p.s,
        d = p.d,
        lapses = p.lapses,
        dueDate = p.dueDate,
        lastReview = p.lastReview,
        history = p.history,
        lifecycle = p.lifecycle,
        pinned = p.pinned,
    )

    /** 词库显示名：相对路径去掉目录与 .canvas 后缀（对应 iOS Entry.bookDisplayName） */
    val bookDisplayName: String
        get() {
            val base = book.substringAfterLast('/')
            return if (base.endsWith(".canvas")) base.dropLast(".canvas".length) else base
        }
}

/**
 * Canvas 解析出的一个词条（对应 iOS ParsedWord）。
 */
data class ParsedWord(
    val nodeId: String,
    val word: String,
    val aliases: List<String> = emptyList(),
    val definition: String = "",
    val color: String? = null,
    val addedDate: String? = null,
    val mastered: Boolean? = false,
)
