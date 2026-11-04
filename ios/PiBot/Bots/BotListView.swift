import SwiftUI
import PiBotKit

struct BotListView: View {
    @Environment(AppStore.self) private var store
    @Binding var selection: String?
    let wide: Bool
    let onCreate: () -> Void
    let onSettings: () -> Void
    @State private var query = ""
    @State private var error: String?

    private var username: String { store.session?.user.shownName ?? "" }

    var body: some View {
        NowReader { now in
            list(now)
        }
        .background(Palette.paper)
        .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .automatic), prompt: "搜索名字或最近消息")
        .refreshable { await refresh() }
        .task { await refresh() }
        .navigationTitle(wide ? "Pi Bot" : "")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if !wide {
                ToolbarItem(placement: .topBarLeading) { AccountAvatar(name: username, action: onSettings) }
            }
            ToolbarItem(placement: .topBarTrailing) {
                Button(action: onCreate) { Image(systemName: "plus") }.accessibilityLabel("新建 Bot")
            }
        }
        .safeAreaInset(edge: .bottom) {
            if wide {
                HStack(spacing: 10) {
                    AccountAvatar(name: username, action: onSettings)
                    Text(username).fontWeight(.medium).lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                    ComputerChip(online: store.computer.online)
                }
                .padding(16)
                .background(Palette.paper)
            }
        }
    }

    private func list(_ now: Int64) -> some View {
        let all = store.bots
        let main = all?.first(where: \.isMain) ?? all?.first
        let term = query.trimmingCharacters(in: .whitespaces)
        let filtered = (all ?? []).filter {
            term.isEmpty || $0.name.localizedCaseInsensitiveContains(term) || ($0.lastMessage?.preview.localizedCaseInsensitiveContains(term) ?? false)
        }
        return List(selection: $selection) {
            hero(main, now: now)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            Section {
                if !store.computer.online && all != nil {
                    Text("电脑离线 · 仍可聊天和联网搜索，资料库暂不可用")
                        .font(.caption).foregroundStyle(Palette.muted)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if let error {
                    VStack(alignment: .leading, spacing: 8) {
                        Text(error).font(.footnote).foregroundStyle(Palette.danger)
                        Button("重试") { Task { await refresh() } }.buttonStyle(.borderedProminent)
                    }
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                if all == nil && error == nil {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else if all?.isEmpty == true {
                    VStack(spacing: 10) {
                        Text("新建你的第一个 Bot").fontWeight(.semibold)
                        Text("每个 Bot 都有自己的性格和长期记忆。").font(.footnote).foregroundStyle(Palette.muted)
                        Button("新建 Bot", action: onCreate).buttonStyle(.borderedProminent)
                    }
                    .frame(maxWidth: .infinity).padding(20)
                    .listRowBackground(Color.clear).listRowSeparator(.hidden)
                } else if all != nil && filtered.isEmpty {
                    Text("没有找到相关 Bot").foregroundStyle(Palette.muted).padding(20)
                        .listRowBackground(Color.clear).listRowSeparator(.hidden)
                }
                ForEach(filtered) { bot in
                    BotRow(bot: bot, now: now)
                        .tag(bot.id)
                        .listRowInsets(EdgeInsets(top: 0, leading: 12, bottom: 0, trailing: 12))
                        .listRowSeparator(.hidden)
                        .listRowBackground(
                            RoundedRectangle(cornerRadius: 18)
                                .fill(selection == bot.id && wide ? Palette.accentSoft : Color.clear)
                                .padding(.horizontal, 8)
                        )
                }
            } header: {
                HStack {
                    Text(term.isEmpty ? "我的 Bot" : "搜索结果").font(.footnote.weight(.medium)).foregroundStyle(Palette.muted)
                    Spacer()
                    if !wide { ComputerChip(online: store.computer.online) }
                }
                .textCase(nil)
            }
        }
        .listStyle(.plain)
        .scrollContentBackground(.hidden)
    }

    private func hero(_ main: Bot?, now: Int64) -> some View {
        VStack(spacing: 0) {
            Button {
                if let main { selection = main.id }
            } label: {
                ZStack(alignment: .bottomTrailing) {
                    BotFace(avatar: main?.avatar ?? .orange, mood: main?.mood(now: now) ?? "happy", size: 136,
                            seed: seedOf(main?.id ?? "welcome"), entrance: true)
                    if main?.isMain == true {
                        Text("★").font(.system(size: 13)).foregroundStyle(.white)
                            .frame(width: 23, height: 23)
                            .background(Palette.accent, in: Circle())
                            .padding(.trailing, 20).padding(.bottom, 12)
                    }
                }
                .padding(.horizontal, 24).padding(.vertical, 4)
            }
            .buttonStyle(.plain)
            .disabled(main == nil)
            .accessibilityLabel("打开主 Bot")
            Text(main?.name ?? "Pi Bot").foregroundStyle(Palette.muted).lineLimit(1)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 12).padding(.bottom, 16)
    }

    private func refresh() async {
        do {
            try await store.refreshBots()
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = errorText(error)
        }
    }
}

struct AccountAvatar: View {
    let name: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            Text(name.first.map { String($0).uppercased() } ?? "P")
                .font(.system(size: 17, weight: .semibold)).foregroundStyle(Palette.accent)
                .frame(width: 40, height: 40)
                .background(Palette.accentSoft, in: Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("账号与设置")
    }
}

private struct BotRow: View {
    let bot: Bot
    let now: Int64

    var body: some View {
        let waiting = !bot.pendingApprovals.isEmpty
        HStack(spacing: 12) {
            ZStack(alignment: .topTrailing) {
                BotFace(avatar: bot.avatar, mood: bot.mood(now: now), size: 54, seed: seedOf(bot.id), paused: true, effects: false)
                if waiting {
                    Circle().fill(Palette.danger).frame(width: 9, height: 9).accessibilityLabel("有待审批请求")
                }
            }
            VStack(alignment: .leading, spacing: 5) {
                HStack {
                    Text(bot.name).font(.system(size: 16, weight: .semibold)).foregroundStyle(Palette.ink).lineLimit(1)
                    Spacer(minLength: 8)
                    Text(conversationTime(bot.lastMessage?.createdAt ?? bot.lastActiveAt, now: now))
                        .font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                Text(bot.statusLine(now: now))
                    .font(.system(size: 13)).foregroundStyle(waiting ? Palette.accent : Palette.muted).lineLimit(1)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 13)
        .contentShape(Rectangle())
    }
}

private func conversationTime(_ iso: String, now: Int64) -> String {
    guard let date = parseDate(iso) else { return "" }
    let calendar = Calendar.current
    let today = Date(timeIntervalSince1970: Double(now) / 1000)
    if calendar.isDate(date, inSameDayAs: today) { return clockTime(iso) }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: today), calendar.isDate(date, inSameDayAs: yesterday) { return "昨天" }
    let parts = calendar.dateComponents([.month, .day], from: date)
    return "\(parts.month ?? 0)/\(parts.day ?? 0)"
}
