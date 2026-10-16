package com.notebar.app.sync

import com.notebar.engine.sync.FileStore

/**
 * 同步后端的选择结果（纯数据，可单测）。
 *
 * @param store 实际使用的 [FileStore]
 * @param root 传给 `SyncEngine` 的同步根
 * @param logicalPrefix 后端自己声明的逻辑前缀；null 表示交给 engine 的启发式探测
 * @param isRemote true = 百度网盘后端；false = 本地目录后端
 * @param notice 本次选择需要用户看见的提示（兜底原因 / 配置缺失），null 表示一切正常
 */
data class SyncBackendChoice(
    val store: FileStore,
    val root: String?,
    val logicalPrefix: String?,
    val isRemote: Boolean,
    val notice: String? = null,
)

/**
 * 同步后端选择：**百度网盘优先，本地目录兜底**。
 *
 * 规则（与设置页的开关一一对应）：
 * 1. 网盘开关打开且 AppKey/SecretKey 齐备 → 网盘后端（[BaiduPanFileStore]）；
 * 2. 网盘开关打开但凭证不全 → **回落到本地目录**，并给出可见提示（绝不静默）；
 * 3. 网盘开关关闭 / 没有配置对象 → 本地目录后端。
 *
 * 为什么不在运行中「网络失败就自动切回本地」：那会让同一次同步把两份不同来源的数据
 * 混在一起（网盘写了一半、本地接着写），用户看到的是「同步成功」而磁盘上是两份真相。
 * 因此**后端切换只发生在选择时**；运行期失败一律走可见告警，由用户决定是否切换
 * （设置页提供开关）。这一取舍在报告里列为待裁决项。
 */
object SyncBackendSelector {

    /**
     * @param pan 网盘配置
     * @param localRoot 本地同步根（未配置时由调用方回落到 app 私有目录）
     * @param panClientFactory 依据配置造客户端；单测注入假传输，生产用默认实现
     */
    fun select(
        pan: BaiduPanSettings,
        localRoot: String?,
        panClientFactory: (BaiduPanSettings) -> BaiduPanClient = { BaiduPanClient(it) },
    ): SyncBackendChoice {
        if (!pan.enabled) return local(localRoot, notice = null)

        if (!pan.isConfigured) {
            return local(
                localRoot,
                notice = "百度网盘同步已启用，但 AppKey / SecretKey 尚未填写，已回退到本地目录",
            )
        }

        val client = panClientFactory(pan)
        return SyncBackendChoice(
            store = BaiduPanFileStore(
                client = client,
                remoteRoot = pan.wordsDir,
                localRoot = pan.wordsDir,
            ),
            root = pan.wordsDir,
            logicalPrefix = BaiduPanFileStore.LOGICAL_PREFIX,
            isRemote = true,
            notice = null,
        )
    }

    private fun local(root: String?, notice: String?) = SyncBackendChoice(
        store = LocalFileStore(),
        root = root,
        logicalPrefix = null,
        isRemote = false,
        notice = notice,
    )
}
