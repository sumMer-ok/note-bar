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
            Task { @MainActor in
                guard let self, self.conflicts != conflicts else { return }
                self.conflicts = conflicts
            }
        } onStatusChanged: { [weak self] message in
            Task { @MainActor in
                guard let self, self.syncStatus != message else { return }
                self.syncStatus = message
            }
        }
    }()

    init(context: ModelContext) {
        self.context = context
        settings = Settings.load()
    }

    struct Settings: Codable, Equatable {
        enum Appearance: String, Codable, CaseIterable, Identifiable {
            case system, light, dark

            var id: String { rawValue }

            var title: String {
                switch self {
                case .system: return "跟随系统"
                case .light: return "日间"
                case .dark: return "暗夜"
                }
            }

            var colorScheme: ColorScheme? {
                switch self {
                case .system: return nil
                case .light: return .light
                case .dark: return .dark
                }
            }
        }

        var autoPronounce = true
        var appearance = Appearance.system
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
            case autoPronounce, appearance, forceDarkMode, dailyNewWordLimit
            case dailyReviewLimit, dictationPerSession, ttsTemplate, definitionOrder
            case dictationAutoAdvance
            case aiApiUrl, aiApiKey, aiModel, aiExtraParams, aiNotesPrompt
            case defaultBooks, pinnedBooks
        }

        init() {}

        init(from decoder: Decoder) throws {
            let container = try decoder.container(keyedBy: CodingKeys.self)
            autoPronounce = try container.decodeIfPresent(Bool.self, forKey: .autoPronounce) ?? true
            if let stored = try container.decodeIfPresent(Appearance.self, forKey: .appearance) {
                appearance = stored
            } else {
                // 兼容旧版本只存了「暗夜模式」布尔开关
                let oldDark = try container.decodeIfPresent(Bool.self, forKey: .forceDarkMode) ?? false
                appearance = oldDark ? .dark : .system
            }
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

        func encode(to encoder: Encoder) throws {
            var container = encoder.container(keyedBy: CodingKeys.self)
            try container.encode(autoPronounce, forKey: .autoPronounce)
            try container.encode(appearance, forKey: .appearance)
            try container.encode(dailyNewWordLimit, forKey: .dailyNewWordLimit)
            try container.encode(dailyReviewLimit, forKey: .dailyReviewLimit)
            try container.encode(dictationPerSession, forKey: .dictationPerSession)
            try container.encode(dictationAutoAdvance, forKey: .dictationAutoAdvance)
            try container.encode(ttsTemplate, forKey: .ttsTemplate)
            try container.encode(definitionOrder, forKey: .definitionOrder)
            try container.encode(aiApiUrl, forKey: .aiApiUrl)
            try container.encode(aiApiKey, forKey: .aiApiKey)
            try container.encode(aiModel, forKey: .aiModel)
            try container.encode(aiExtraParams, forKey: .aiExtraParams)
            try container.encode(aiNotesPrompt, forKey: .aiNotesPrompt)
            try container.encode(defaultBooks, forKey: .defaultBooks)
            try container.encode(pinnedBooks, forKey: .pinnedBooks)
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
    private var audioPlayer: AVAudioPlayer?
    private let synthesizer = AVSpeechSynthesizer()

    func speak(word: String, url: URL?) {
        // 设置播放会话：静音键开启时也能正常出声（App 内显式点击发音属于主动播放）
        Self.configureAudioSession()
        guard let url else { return fallback(word) }
        // 在线语音接口偶尔返回空音频，AVPlayer 播放空数据会直接报
        // AVAudioBuffer.mm 的 mDataByteSize (0) 断言。改为先下载并校验非空，
        // 再交给 AVAudioPlayer；任何一步失败都降级为系统离线语音。
        var request = URLRequest(url: url)
        request.timeoutInterval = 5
        URLSession.shared.dataTask(with: request) { [weak self] data, response, error in
            DispatchQueue.main.async {
                guard let self else { return }
                guard error == nil,
                      (response as? HTTPURLResponse)?.statusCode == 200,
                      let data, !data.isEmpty else {
                    self.fallback(word)
                    return
                }
                do {
                    self.audioPlayer = try AVAudioPlayer(data: data)
                    self.audioPlayer?.prepareToPlay()
                    let started = self.audioPlayer?.play() ?? false
                    if !started { self.fallback(word) }
                } catch {
                    self.fallback(word)
                }
            }
        }.resume()
    }

    private func fallback(_ word: String) {
        let utterance = AVSpeechUtterance(string: word)
        utterance.voice = AVSpeechSynthesisVoice(language: "en-US")
        synthesizer.speak(utterance)
    }

    private static func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .spokenAudio, options: [])
        try? session.setActive(true)
    }
}
