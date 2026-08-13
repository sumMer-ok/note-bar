import type { AllCanvasNodeData, CanvasData as ObsidianCanvasData } from 'obsidian/canvas';

export type CanvasNode = AllCanvasNodeData;
export type CanvasData = ObsidianCanvasData;

export interface WordSection {
    title: string;
    content: string;
}

export interface WordCardDefinition {
    pos?: string;
    zh?: string;
    en?: string;
}

export interface WordCardExample {
    text: string;
    translation?: string;
    source?: string;
}

export interface WordCardMemory {
    hint?: string;
    note?: string;
    root?: string;
    mnemonic?: string;
}

export interface WordCardPhonetics {
    uk?: string;
    us?: string;
}

export interface WordCardAudio {
    uk?: string;
    us?: string;
    default?: string;
}

export interface WordCardImage {
    src: string;
    alt?: string;
    caption?: string;
    credit?: string;
}

export interface WordCardConfusable {
    word: string;
    note: string;
    examples?: string[];
}

export interface WordCardAffix {
    text: string;
    meaning?: string;
    role?: string;
}

export interface WordCardMorphology {
    type?: string;
    root?: string;
    prefixes?: WordCardAffix[];
    suffixes?: WordCardAffix[];
    compound?: string[];
    breakdown?: string;
    explanation?: string;
}

export interface WordCardPhrase {
    phrase: string;
    meaning?: string;
    note?: string;
    example?: string;
}

export interface WordCardRelation {
    type: string;
    target: string;
    targetType?: LearningItemType | 'topic' | 'grammar' | 'pattern' | 'concept';
    note?: string;
}

export interface WordCardUsageMistake {
    wrong: string;
    correct: string;
    note?: string;
}

export interface WordCardUsage {
    register?: string;
    domains?: string[];
    topics?: string[];
    commonPatterns?: string[];
    mistakes?: WordCardUsageMistake[];
}

export interface WordCardLearning {
    depth?: 'light' | 'medium' | 'core' | string;
    priority?: number;
    reason?: string;
}

export type WordCardDetailSection =
    | 'definitions'
    | 'examples'
    | 'collocations'
    | 'memory'
    | 'forms'
    | 'morphology'
    | 'phrases'
    | 'usage'
    | 'confusables'
    | 'relations';

export type WordCardPreviewDensity = 'simple' | 'standard' | 'rich';

export interface VocabularyBookDisplaySettings {
    previewDensity?: WordCardPreviewDensity;
    previewSections?: WordCardDetailSection[];
    detailSections?: WordCardDetailSection[];
    hiddenSections?: WordCardDetailSection[];
}

export interface WordCard {
    id?: string;
    version?: number;
    word: string;
    type?: LearningItemType;
    aliases?: string[];
    color?: string;
    phonetic?: string;
    phonetics?: WordCardPhonetics;
    audio?: WordCardAudio;
    language?: string;
    level?: string;
    partsOfSpeech?: string[];
    difficulty?: number;
    priority?: number;
    tags?: string[];
    frequency?: number;
    register?: string;
    domains?: string[];
    examTags?: string[];
    definitions?: WordCardDefinition[];
    definition?: string;
    examples?: WordCardExample[];
    memory?: WordCardMemory;
    collocations?: string[];
    phrases?: WordCardPhrase[];
    forms?: Record<string, string | string[] | number | boolean | null | undefined>;
    morphology?: WordCardMorphology;
    relations?: WordCardRelation[];
    usage?: WordCardUsage;
    learning?: WordCardLearning;
    confusables?: WordCardConfusable[];
    images?: WordCardImage[];
}

/** 词条生命周期状态：只叠加在 FSRS 之上，不修改 s/d/due */
export type WordLifecycle = 'active' | 'graduated' | 'archived' | 'retired';

/** 淘汰候选条目：展示证据供用户判决 */
export interface RetirementCandidate {
    studyKey: string;
    word: string;
    source: string;
    nodeId: string;
    /** 入库日期（YYYY-MM-DD，来自 Canvas 日期分组） */
    addedDate?: string;
    /** 最近一次相遇日期（YYYY-MM-DD） */
    lastEncounter?: string;
    /** 悬停查看释义次数 */
    hoverCount: number;
    /** 总相遇次数 */
    encounterCount: number;
    /** 入库天数 */
    daysSinceAdded: number;
    /** 距上次相遇天数（未相遇则等于入库天数） */
    daysSinceEncounter: number;
}

export interface WordDefinition {
    word: string;
    type?: LearningItemType;
    language?: string;
    studyKey?: string;
    aliases?: string[];
    definition: string;
    rawDefinition?: string;
    sections?: WordSection[];
    source: string;
    nodeId: string;
    color?: string;
    mastered?: boolean;
    isPattern?: boolean;
    patternParts?: string[];
    card?: WordCard;
    /** 添加日期（YYYY-MM-DD，来自 Canvas 日期分组） */
    addedDate?: string;
    /** FSRS stability（复习稳定度），由 VocabularyManager 从 studyProgress 填充，供高亮渐隐使用；undefined 视为新词（全强度） */
    fsrsS?: number;
    /** 生命周期状态：active=正常 | graduated=已毕业（退出高亮与复习，悬停可查） | archived=已归档（退出高亮与复习，悬停可查） | retired=已淘汰（从匹配中彻底剔除） */
    status?: WordLifecycle;
    /** 常驻标记：pinned 的词永不再进入淘汰候选 */
    pinned?: boolean;
}

export interface StudyItem {
    studyKey: string;
    word: string;
    type?: LearningItemType;
    language?: string;
    aliases: string[];
    mastered: boolean;
    sources: WordDefinition[];
    primary: WordDefinition;
}

export interface VocabularyBook {
    path: string;
    name: string;
    enabled: boolean;
    color?: string;
    display?: VocabularyBookDisplaySettings;
}

export type HighlightStyle = 'underline' | 'background' | 'bold' | 'dotted' | 'wavy';

export type AIProvider = 'openai-compatible' | 'anthropic' | 'gemini' | 'custom';

export interface AIServiceSettings {
    provider: AIProvider;
    apiUrl: string;
    apiKey: string;
    model: string;
    extraParams: string;
}

export interface AIDefinitionSettings {
    enabled: boolean;
    prompt: string;
}

export interface SelectionTranslateSettings {
    enabled: boolean;
    targetLang: string;
    prompt: string;
}

export type LearningItemType = 'word' | 'phrase' | 'concept' | 'term';

export interface ReviewRecord {
    date: string;
    quality: 'again' | 'hard' | 'good' | 'easy';
}

/** 手机同步设置（iOS App 经 iCloud Drive 目录同步） */
export interface MobileSyncSettings {
    enabled: boolean;
    /** iCloud 同步目录绝对路径 */
    syncDir: string;
    /** 轮询间隔（秒），默认 15 */
    pollIntervalSec: number;
}

/** 相遇记录：同一单词在插件内的相遇次数统计（key 为 wordKey，即 studyKey 或 word 小写） */
export interface EncounterData {
    /** 悬停查看释义次数 */
    hoverCount: number;
    /** 总相遇次数（悬停 / 添加 / 打开均计入） */
    encounterCount: number;
    /** 最近一次相遇日期（YYYY-MM-DD） */
    lastEncounter?: string;
}

/** 相遇类型：悬停查看释义 / 添加或编辑单词 / 侧边栏展开词条 */
export type EncounterType = 'hover' | 'add' | 'open';

/** hover 回流设置：悬停查看释义时把到期日较远的复习词提前到今天 */
export interface HoverFeedbackSettings {
    enabled: boolean;
    /** 天数阈值 N：仅当 dueDate 在 today + N 之后才回流 */
    days: number;
}

export interface StudyProgressItem {
    status: 'new' | 'learning' | 'review' | 'mastered';
    stage?: number;
    reps?: number;
    ef?: number;
    interval?: number;
    s?: number;      // FSRS stability
    d?: number;      // FSRS difficulty
    lapses?: number; // 遗忘次数
    dueDate?: string;
    lastReview?: string;
    history?: ReviewRecord[];
    /** 生命周期状态（独立于 FSRS 调度，只叠加不内改 s/d/due） */
    lifecycle?: WordLifecycle;
    /** 常驻标记：永不再进淘汰候选 */
    pinned?: boolean;
    // 兼容旧数据
    masteredAt?: string;
    updatedAt?: string;
}

export interface FlashcardSettings {
    defaultMode: 'word-to-definition' | 'definition-to-word';
    newWordSteps: number;
    masteredThreshold: { reps: number; minEf: number };
    dailyNewWordLimit: number;
    dailyReviewLimit: number;
    studyOrder: 'review-first' | 'new-first';
    syncMasteredToCanvas: boolean;
    enableAnimation: boolean;
}

export interface HiWordsSettings {
    vocabularyBooks: VocabularyBook[];
    studyProgress?: Record<string, StudyProgressItem>;
    /** 手机同步（iOS App） */
    mobileSync?: MobileSyncSettings;
    flashcard?: FlashcardSettings;
    showDefinitionOnHover: boolean;
    enableAutoHighlight: boolean;
    highlightStyle: HighlightStyle;
    /** 高亮渐隐开关：开启后复习稳定度高的词按 FSRS stability 渐隐（不消失），默认 true */
    enableFadeHighlight?: boolean;
    /** 渐隐透明度下限（0-1）：已掌握/高稳定度词的可见度下限，默认 0.25，可设为 0 完全淡出 */
    fadeFloor?: number;
    enableMasteredFeature: boolean;
    showMasteredInSidebar: boolean;
    blurDefinitions: boolean;
    showSidebar?: boolean;
    masteredDetection?: 'group' | 'color';
    ttsTemplate?: string;
    pronunciationVariant?: 'uk' | 'us';
    aiService: AIServiceSettings;
    aiDefinition: AIDefinitionSettings;
    autoLayoutEnabled?: boolean;
    cardWidth?: number;
    cardHeight?: number;
    highlightMode?: 'all' | 'exclude' | 'include';
    highlightPaths?: string;
    fileNodeParseMode?: 'filename' | 'content' | 'filename-with-alias';
    enableSectionTabs?: boolean;
    sidebarDefaultDisplayMode?: 'detail' | 'word';
    selectionTranslate: SelectionTranslateSettings;
    hideDefinitions?: boolean;
    defaultVocabularyBookPaths?: string[];
    /** 中文词典配置（离线英汉词典） */
    chineseDictionary?: {
        enabled: boolean;
        /** 词典文件路径（vault 内相对路径或绝对路径） */
        path: string;
    };
    /** 法律词典配置（Black's Law Dictionary） */
    legalDictionary?: {
        enabled: boolean;
        /** 词典文件路径（vault 内相对路径或绝对路径） */
        path: string;
    };
    /** 拼写/听写练习配置 */
    spellingPractice?: {
        /** 每次听写最多单词数 */
        maxPerSession: number;
    };
    /** hover 回流配置：悬停查看释义时把到期日较远的复习词提前到今天 */
    hoverFeedback?: HoverFeedbackSettings;
    /** 淘汰候选天数阈值 N（默认 90）：入库天数与距上次相遇天数均 ≥ N 天的词条进入侧边栏「淘汰候选」列表 */
    retireCandidateDays?: number;
    /** 自动毕业稳定性阈值：FSRS stability s ≥ 此值时自动置 graduated（默认 30，约对应 1 个月间隔） */
    graduatedStabilityThreshold?: number;
}

export interface WordMatch {
    word: string;
    definition: WordDefinition;
    from: number;
    to: number;
    color: string;
    matchedText?: string;
    segments?: Array<{ from: number; to: number }>;
}
