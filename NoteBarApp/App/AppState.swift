import SwiftUI
import SwiftData
import AVFoundation

@MainActor
final class AppState: ObservableObject {
    @Published var settings: Settings {
        didSet { saveSettings() }
    }
    @Published var syncStatus = "未连接"
    @Published var conflicts: [String] = []

    private let context: ModelContext
    private let speaker = Speaker()
    lazy var sync: SyncService = {
        SyncService(store: DataStore(context: context)) { [weak self] message in
            Task { @MainActor in self?.conflicts.append(message) }
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
        var ttsTemplate = "https://dict.youdao.com/dictvoice?audio={{word}}&type=2"

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
