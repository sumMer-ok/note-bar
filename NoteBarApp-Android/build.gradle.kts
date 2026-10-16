// NoteBar Android 版 —— 根构建脚本
// 目前只含纯 JVM 的 engine 模块（Phase 1：引擎移植 + 单测）。
// Phase 2 起再挂 app 模块（Compose UI）与 sync 模块（百度网盘）。
plugins {
    kotlin("jvm") version "2.0.21" apply false
    kotlin("plugin.serialization") version "2.0.21" apply false
}

allprojects {
    repositories {
        mavenCentral()
    }
}
