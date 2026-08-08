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

export interface StudyProgressItem {
    status: 'new' | 'learning' | 'review' | 'mastered';
    stage?: number;
    reps?: number;
    ef?: number;
    interval?: number;
    dueDate?: string;
    lastReview?: string;
    history?: ReviewRecord[];
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
    flashcard?: FlashcardSettings;
    showDefinitionOnHover: boolean;
    enableAutoHighlight: boolean;
    highlightStyle: HighlightStyle;
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
