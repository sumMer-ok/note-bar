package com.notebar.engine

import kotlinx.serialization.json.Json

/**
 * 统一的 JSON 配置（对应 iOS 的 Codable 口径）：
 * - `encodeDefaults = true`：Swift 的 Codable 会写出所有非可选字段，即使值为默认值；
 * - `explicitNulls = false`：Swift 的可选字段为 nil 时不输出该键。
 *
 * 这两条一起保证与桌面端 / iOS 端产物逐字一致（字段名与省略规则都对齐）。
 */
object NoteBarJson {
    val instance: Json = Json {
        encodeDefaults = true
        explicitNulls = false
        ignoreUnknownKeys = true
        prettyPrint = false
    }
}
