// NoteBar Android 版 —— 根构建脚本
//
// 模块划分：
// - :engine —— 纯 JVM 复习引擎与同步纯逻辑（无 Android SDK 依赖，任何机器可单测）
// - :app    —— Compose UI + Room + DataStore + 百度网盘客户端（Phase 4）
plugins {
    alias(libs.plugins.android.application) apply false
    alias(libs.plugins.kotlin.android) apply false
    alias(libs.plugins.kotlin.compose) apply false
    alias(libs.plugins.kotlin.serialization) apply false
    alias(libs.plugins.ksp) apply false
}
