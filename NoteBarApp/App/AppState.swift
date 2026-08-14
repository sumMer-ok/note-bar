import SwiftUI
import SwiftData
import AVFoundation

enum AppTab: Hashable {
    case learn, library, stats, settings
}

@MainActor
final class AppState: ObservableObject {
    @Published var settings: Settings {
        didSet { saveSettings() }
    }
    @Published var syncStatus = "未连接"
    @Published var conflicts: [SyncConflict] = []
    @Published var selectedTab: AppTab = .learn
    @Published var libraryFilter: String?

    private let context: ModelContext
    private let speaker = Speaker()
    private var libraryFilterConsumed = false
    lazy var sync: SyncService = {
        SyncService(store: DataStore(context: context)) { [weak self] conflicts in
            Task { @MainActor in self?.conflicts = conflicts }
        }
    }()

    init(context: ModelContext) {
        self.context = context
        settings = Settings.load()
    }

    struct Settings: Codable, Equatable {
        var autoPronounce = true
        var forceDarkMode = false
        var dailyNewWordLimit = 20
        var dailyReviewLimit = 50
        var dictationPerSession = 20
        var dictationAutoAdvance = true
        var ttsTemplate = "https://dict.youdao.com/dictvoice?audio={{word}}&type=2"
        var definitionOrder: [DefinitionModule] = DefinitionModule.allCases
        var aiApiUrl = "https://api.openai.com/v1"
        var aiApiKey = ""
        var aiModel = "gpt-4o-mini"
        var aiExtraParams = "{}"
        var aiNotesPrompt = "你是一个英语学习助手。请针对单词 \"{{word}}\"（上下文句子，可能为空：{{sentence}}）写一段简短的自定义笔记，帮助记忆，包含：1）一个贴近真实语境的例句；2）词根词缀拆解（如有）；3）一个联想记忆技巧。只输出纯文本，不要 markdown 标题、不要 JSON。"
        var defaultBooks: [String] = []
        var pinnedBooks: [String] = []

        private enum CodingKeys: String, CodingKey {
            case autoPronounce, forceDarkMode, dailyNewWordLimit
            case dailyReviewLimit, dictationPerSession, ttsTemplate, definitionOrder
            case dictationAutoAdvance
            case aiApiUrl, aiApiKey, aiModel, aiExtraParams, aiNotesPrompt
            case defaultBooks, pinnedBooks
        }

        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            autoPronounce = try container.decodeIfPresent(Bool.self, forKey: .autoPronounce) ?? true
            forceDarkMode = try container.decodeIfPresent(Bool.self, forKey: .forceDarkMode) ?? false
            dailyNewWordLimit = try container.decodeIfPresent(Int.self, forKey: .dailyNewWordLimit) ?? 20
            dailyReviewLimit = try container.decodeIfPresent(Int.self, forKey: .dailyReviewLimit) ?? 50
            dictationPerSession = try container.decodeIfPresent(Int.self, forKey: .dictationPerSession) ?? 20
            dictationAutoAdvance = try container.decodeIfPresent(Bool.self, forKey: .dictationAutoAdvance) ?? true
            ttsTemplate = try container.decodeIfPresent(String.self, forKey: .ttsTemplate)
                ?? "https://dict.youdao.com/dictvoice?audio={{word}}&type=2"
            definitionOrder = try container.decodeIfPresent([DefinitionModule].self, forKey: .definitionOrder)
                ?? DefinitionModule.allCases
            aiApiUrl = try container.decodeIfPresent(String.self, forKey: .aiApiUrl) ?? "https://api.openai.com/v1"
            aiApiKey = try container.decodeIfPresent(String.self, forKey: .aiApiKey) ?? ""
            aiModel = try container.decodeIfPresent(String.self, forKey: .aiModel) ?? "gpt-4o-mini"
            aiExtraParams = try container.decodeIfPresent(String.self, forKey: .aiExtraParams) ?? "{}"
            aiNotesPrompt = try container.decodeIfPresent(String.self, forKey: .aiNotesPrompt)
                ?? "你是一个英语学习助手。请针对单词 \"{{word}}\"（上下文句子，可能为空：{{sentence}}）写一段简短的自定义笔记，帮助记忆，包含：1）一个贴近真实语境的例句；2）词根词缀拆解（如有）；3）一个联想记忆技巧。只输出纯文本，不要 markdown 标题、不要 JSON。"
            defaultBooks = try container.decodeIfPresent([String].self, forKey: .defaultBooks) ?? []
            pinnedBooks = try container.decodeIfPresent([String].self, forKey: .pinnedBooks) ?? []
        }

        var aiConfig: AIDefinitionService.Config {
            AIDefinitionService.Config(
                apiUrl: aiApiUrl,
                apiKey: aiApiKey,
                model: aiModel,
                extraParams: aiExtraParams,
                prompt: AIDefinitionService.loadPrompt()
            )
        }

        var notesAIConfig: AIDefinitionService.Config {
            AIDefinitionService.Config(
                apiUrl: aiApiUrl,
                apiKey: aiApiKey,
                model: aiModel,
                extraParams: aiExtraParams,
                prompt: aiNotesPrompt
            )
        }

        static func load() -> Settings {
            guard let data = UserDefaults.standard.data(forKey: "app-settings"),
                  let settings = try? JSONDecoder().decode(Settings.self, from: data) else {
                return Settings()
            }
            return settings
        }
    }

    private func saveSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: "app-settings")
        }
    }

    func ttsURL(word: String, us: Bool = true) -> URL? {
        let encoded = word.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? word
        let url = settings.ttsTemplate
            .replacingOccurrences(of: "{{word}}", with: encoded)
            .replacingOccurrences(of: "{{type}}", with: us ? "2" : "1")
            .replacingOccurrences(of: "{{accent}}", with: us ? "us" : "uk")
        return URL(string: url)
    }

    func speak(_ word: String) {
        speaker.speak(word: word, url: ttsURL(word: word))
    }

    /// 从首页点词库时：带上过滤条件切到「词库」Tab
    func showLibrary(book: String?) {
        libraryFilter = book
        libraryFilterConsumed = true
        selectedTab = .library
    }

    /// Tab 变化时：直接点击「词库」Tab 栏则清空过滤条件（显示全部词库）
    func handleTabChange(_ tab: AppTab) {
        guard tab == .library else { return }
        if libraryFilterConsumed {
            libraryFilterConsumed = false
        } else {
            libraryFilter = nil
        }
    }
}

/// 有道 TTS 远程播放，失败降级 AVSpeechSynthesizer
final class Speaker: NSObject {
    private var player: AVPlayer?
    private let synthesizer = AVSpeechSynthesizer()

    func speak(word: String, url: URL?) {
        if let url {
            player = AVPlayer(url: url)
            player?.play()
            DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) { [weak self] in
                guard let self, self.player?.timeControlStatus != .playing else { return }
                self.fallback(word)
            }
        } else {
            fallback(word)
        }
    }

    private func fallback(_ word: String) {
        let utterance = AVSpeechUtterance(string: word)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }
}
