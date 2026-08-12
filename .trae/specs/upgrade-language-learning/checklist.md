# Checklist

## P1：FSRS-5 算法升级
- [ ] `fsrs.ts` 实现完整 FSRS-5 公式（initStability/initDifficulty/nextDifficulty/retrievability/nextRecallStability/nextForgetStability/nextInterval）
- [ ] `flashcard-algorithm.ts` 移除 `applySm2`/`calculateEf`，评分走 FSRS，进度字段含 s/d/due/lastReview/reps/lapses
- [ ] 旧 SM-2 进度迁移：`due` 保留、`s/d` 初始化，新旧字段双写兼容
- [ ] `flashcard-review-modal.ts` 评分映射正确（忘记=1/模糊=2/记得=3/简单=4），间隔预览显示
- [ ] `flashcard-queue.ts` 按 due 升序 + 新词上限；"今日待复习"计数正确
- [ ] 验证通过：interval 指数增长；不同评分产生不同 stability；旧进度无缝迁移

## P2：高亮渐隐 + 匹配健壮性
- [ ] 渐隐公式正确（新词 alpha=1；`1 - (s/(s+20))·(1 - fadeFloor)`），styles.css 支持透明度
- [ ] 设置：单"渐隐"开关 + fadeFloor（可到 0）替代"已掌握词过滤"
- [ ] 语言无关词边界（ASCII 加边界、CJK 不加）
- [ ] 词条自身关键词在节点内不自我高亮
- [ ] `removeOverlaps` 实现真正重叠裁剪（不再 no-op）
- [ ] 验证通过：新词最亮、熟词变淡、中文无误判、自身词不高亮

## P3：相遇记账 + hover 回流
- [ ] `encounters.json` sidecar 读写，1.5s 防抖落盘 + onunload 即时保存
- [ ] 悬停/加词/侧边栏展开三事件记相遇；(词+类型) 60s 冷却
- [ ] hover 回流：due > today+N 拉至今天，只动 due 不改 s/d、不进复习日志
- [ ] 验证通过：计数与日期变化、远期词进近期队列、开关可关、渲染无卡顿

## P4：词条生命周期 + 淘汰候选
- [ ] 状态模型 status/pinned 持久化；graduated/archived 退出高亮与复习；retired 从匹配剔除
- [ ] **红线**：任何状态操作不修改 s/d/due
- [ ] stability 阈值自动毕业（设置可调），毕业仍走 Canvas 掌握同步
- [ ] Canvas"已归档"分组：归档/淘汰节点几何移入
- [ ] 淘汰候选：硬条件筛子（90 天/相遇），证据展示，淘汰/留下/已掌握三动作 + 多选
- [ ] 验证通过：毕业词无高亮可悬停；淘汰词无匹配；候选列表正确；FSRS 字段未被污染

## P5：复习主页 + 热力图 + cloze
- [ ] `reviewLog` 每次评分记录 `{date, word, grade}`
- [ ] 热力图近 18 周网格 4 档着色
- [ ] 主页视图统计/筛选/开始复习/淘汰候选入口；ribbon/命令注册
- [ ] 遗忘曲线 SVG；cloze 卡面挖空；撤销（Z）还原评分
- [ ] 验证通过：热力图着色、统计准确、cloze 可复习、撤销生效

## P6：稳定性与性能修复
- [ ] 无 `temp_` 残留 ID、快速加词后内存与文件一致
- [ ] 词典按首字母分片读取，首次查词不卡界面
- [ ] 选区事件驱动（无常驻 80ms 轮询）
- [ ] 验证通过：重载无残留、首查流畅、无选区时 CPU 空闲

## 整体回归
- [ ] `npm run build` + tsc 通过
- [ ] 全功能回归：工具栏/翻译/导出 CSV/拼写练习正常
- [ ] 部署测试 vault 验证通过
