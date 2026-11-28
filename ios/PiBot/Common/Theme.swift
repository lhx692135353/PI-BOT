import SwiftUI
import PiBotKit

@MainActor
enum Palette {
    private static var isIronMan: Bool { SkinStore.shared.skin == .ironman }

    static var accent: Color { isIronMan ? hexColor("#B52B33") : hexColor("#F4692A") }
    static var accentSoft: Color { isIronMan ? hexColor("#2A161B") : hexColor("#FFEFE4") }
    static var paper: Color { isIronMan ? hexColor("#0B0F17") : hexColor("#F6F4F1") }
    static var card: Color { isIronMan ? hexColor("#131A26") : Color.white }
    static var ink: Color { isIronMan ? hexColor("#EEF2F7") : hexColor("#1F1F23") }
    static var muted: Color { isIronMan ? hexColor("#93A1B5") : hexColor("#8A877F") }
    static var line: Color { isIronMan ? hexColor("#232E42") : hexColor("#E7E3DC") }
    static var good: Color { isIronMan ? hexColor("#75DDF1") : hexColor("#2FA36B") }
    static var danger: Color { isIronMan ? hexColor("#FF7A7F") : hexColor("#D9483B") }
    static var codeBackground: Color { isIronMan ? hexColor("#172030") : hexColor("#F2EFEA") }
    static var chip: Color { isIronMan ? hexColor("#192233") : hexColor("#EFEBE5") }
}

/// 皮肤感知的 Bot 头像视图：默认皮肤使用原有 BotFace，钢铁侠皮肤按 botId 确定性映射 12 款机甲。
struct SkinnedBotFace: View {
    let avatar: Avatar
    let mood: String
    let size: CGFloat
    var seed: Int32 = 1
    var paused: Bool = false
    var effects: Bool = true
    var entrance: Bool = false
    var botId: String? = nil
    var forceOriginal: Bool = false

    @Environment(SkinStore.self) private var skinStore

    var body: some View {
        if !forceOriginal && skinStore.skin == .ironman {
            let armorSeed = botId ?? "\(avatar.shape):\(avatar.color):\(avatar.scheme):\(seed)"
            IronManAvatarView(seed: armorSeed, mood: mood, size: size)
        } else {
            BotFace(avatar: avatar, mood: mood, size: size, seed: seed, paused: paused, effects: effects, entrance: entrance)
        }
    }
}

private let clockFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "HH:mm"
    return f
}()

private let dayFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "M月d日"
    return f
}()

func clockTime(_ iso: String) -> String { parseDate(iso).map(clockFormatter.string(from:)) ?? "" }

func dayLabel(_ iso: String) -> String {
    guard let date = parseDate(iso) else { return "" }
    let calendar = Calendar.current
    if calendar.isDateInToday(date) { return "今天" }
    if calendar.isDateInYesterday(date) { return "昨天" }
    return dayFormatter.string(from: date)
}

/// Shared 44 pt touch target for the list and conversation toolbars.
struct CircleAction: View {
    let label: String
    let systemImage: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Image(systemName: systemImage)
                .font(.system(size: 17, weight: .semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 44, height: 44)
                .background(Palette.card, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }
}

struct ComputerChip: View {
    let online: Bool

    var body: some View {
        HStack(spacing: 6) {
            Circle().fill(online ? Palette.good : Palette.muted).frame(width: 7, height: 7)
            Text(online ? "电脑在线" : "电脑离线").font(.caption).foregroundStyle(online ? Palette.good : Palette.muted)
        }
        .padding(.horizontal, 10).padding(.vertical, 4)
        .background((online ? Palette.good.opacity(0.12) : Palette.muted.opacity(0.14)), in: Capsule())
    }
}

struct EmptyStateView<Action: View>: View {
    let avatar: Avatar
    let mood: String
    let title: String
    let message: String
    @ViewBuilder var action: () -> Action

    init(avatar: Avatar, mood: String, title: String, message: String, @ViewBuilder action: @escaping () -> Action = { EmptyView() }) {
        self.avatar = avatar; self.mood = mood; self.title = title; self.message = message; self.action = action
    }

    var body: some View {
        VStack(spacing: 0) {
            SkinnedBotFace(avatar: avatar, mood: mood, size: 160)
            Text(title).font(.title3.weight(.semibold)).multilineTextAlignment(.center).padding(.top, 12)
            Text(message).foregroundStyle(Palette.muted).multilineTextAlignment(.center).lineSpacing(4).padding(.top, 8)
            action().padding(.top, 20)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

struct PrimaryButtonStyle: ButtonStyle {
    var color: Color = Palette.accent
    @Environment(\.isEnabled) private var enabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.semibold))
            .foregroundStyle(enabled ? Color.white : Palette.muted)
            .frame(maxWidth: .infinity, minHeight: 50)
            .background(enabled ? color : Palette.line, in: RoundedRectangle(cornerRadius: 25))
            .opacity(configuration.isPressed ? 0.85 : 1)
    }
}

struct OutlineButtonStyle: ButtonStyle {
    var color: Color = Palette.ink

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.body.weight(.medium))
            .foregroundStyle(color)
            .frame(maxWidth: .infinity, minHeight: 46)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 23))
            .overlay(RoundedRectangle(cornerRadius: 23).stroke(Palette.line))
            .opacity(configuration.isPressed ? 0.7 : 1)
    }
}

extension View {
    /// Card-like input field used on the login, editor and password screens.
    func fieldStyle() -> some View {
        padding(.horizontal, 14).padding(.vertical, 13)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line))
    }
}

/// Current time that ticks every few seconds so moods like "celebrate" fade on their own.
struct NowReader<Content: View>: View {
    var period: TimeInterval = 2
    @ViewBuilder var content: (Int64) -> Content

    var body: some View {
        TimelineView(.periodic(from: .now, by: period)) { context in
            content(Int64((context.date.timeIntervalSince1970 * 1000).rounded()))
        }
    }
}