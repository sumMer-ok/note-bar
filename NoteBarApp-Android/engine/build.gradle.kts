// engine：复习引擎纯逻辑（FSRS / 学习队列 / 合并 / 强化状态机 / studyKey）
//
// 依赖说明：唯一的第三方依赖是 kotlinx-serialization-json，用于
// ① 强化草稿 ReinforceDraft 的编解码（对应 iOS 的 Codable，字段名必须逐字一致）
// ② 单测读取跨端共享的冻结测试向量 tests/fixtures/sync-vectors.json
// 算法本体（FSRS 公式、合并策略、队列状态机）全部手写移植，不依赖任何算法库。
plugins {
    kotlin("jvm")
    kotlin("plugin.serialization")
}

// 版本由根 build.gradle.kts 统一解析（Kotlin 2.0.21）

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")

    testImplementation(kotlin("test"))
    testImplementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.7.3")
}

kotlin {
    jvmToolchain(17)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
        showStandardStreams = false
    }
}
