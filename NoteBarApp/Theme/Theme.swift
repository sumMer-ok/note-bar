import SwiftUI

enum Theme {
    static let againRed = Color(red: 0.76, green: 0.22, blue: 0.24)
    static let hardGray = Color(red: 0.55, green: 0.58, blue: 0.62)
    static let goodGreen = Color(red: 0.18, green: 0.55, blue: 0.34)
    static let easyOrange = Color(red: 0.90, green: 0.54, blue: 0.0)
    static let darkPurpleWord = Color(red: 0.72, green: 0.62, blue: 1.0)

    static func wordColor(_ scheme: ColorScheme) -> Color {
        scheme == .dark ? darkPurpleWord : .black
    }
}

struct GlassBackground: ViewModifier {
    func body(content: Content) -> some View {
        content
            .background(.ultraThinMaterial, in: RoundedRectangle(cornerRadius: 24, style: .continuous))
    }
}

extension View {
    func glassCard() -> some View { modifier(GlassBackground()) }
}
