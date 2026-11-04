import SwiftUI
import PiBotKit

struct ConversationView: View {
    @Environment(AppStore.self) private var store
    @Environment(VoiceCallController.self) private var voice
    @Environment(\.openURL) private var openURL
    let botId: String
    let onEdit: () -> Void
    let onFiles: () -> Void
    let onOpenBot: (String) -> Void
    @State private var error: String?
    @State private var loadingMore = false

    var body: some View {
        Group {
            if let bot = store.bot(botId) {
                content(bot)
            } else {
                VStack(spacing: 12) {
                    if let failure = error {
                        Text(failure).foregroundStyle(Palette.danger)
                        Button("重试") { error = nil; Task { await load() } }
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .background(Palette.paper)
        .navigationBarTitleDisplayMode(.inline)
        .toolbarBackground(Palette.paper, for: .navigationBar)
        .task(id: botId) { await load() }
        .onChange(of: store.voiceNotice, initial: true) {
            if let notice = store.voiceNotice, !notice.trimmingCharacters(in: .whitespaces).isEmpty {
                error = notice
                store.clearVoiceNotice()
            }
        }
    }

    private func load() async {
        do {
            try await store.refreshBot(botId)
            try await store.loadTail(botId)
        } catch is CancellationError {
        } catch {
            self.error = errorText(error)
        }
    }

    @ViewBuilder private func content(_ bot: Bot) -> some View {
        let call = store.liveCall
        VStack(spacing: 0) {
            if let call, call.local, call.botId == botId {
                CallOverlay(bot: bot, call: call, onMute: voice.setMuted, onHangup: voice.hangup)
            } else {
                messages(bot)
                if let error {
                    Text(error).font(.footnote).foregroundStyle(Palette.danger)
                        .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 4)
                }
                if let call, call.botId != botId {
                    note("语音通话在另一个对话里")
                } else if let call, !call.local {
                    note("正在其他设备通话")
                }
                Composer(
                    botId: botId, botName: bot.name,
                    text: Binding(get: { store.drafts[botId] ?? "" }, set: { store.drafts[botId] = $0.isEmpty ? nil : $0 }),
                    callEnabled: !(call?.local == true || call?.botId == botId),
                    onCall: startCall,
                    onSend: { text, requestId, images in
                        error = nil
                        do {
                            try await store.send(botId: botId, text: text, requestId: requestId, images: images)
                            return true
                        } catch {
                            self.error = errorText(error)
                            return false
                        }
                    }
                )
            }
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                NowReader { now in
                    let tool = store.timeline(botId).runningTool
                    HStack(spacing: 6) {
                        BotFace(avatar: bot.avatar, mood: bot.mood(now: now, tool: tool), size: 36, seed: seedOf(bot.id))
                        Text(bot.name).font(.headline).foregroundStyle(Palette.ink).lineLimit(1)
                    }
                }
            }
            ToolbarItem(placement: .primaryAction) {
                Menu {
                    Button("云端桌面与文件", systemImage: "desktopcomputer") {
                        Task {
                            do { openURL(try await store.remoteDesktop(botId: botId)) } catch { self.error = errorText(error) }
                        }
                    }
                    Button("资料库", systemImage: "folder", action: onFiles)
                    Button("编辑 Bot", systemImage: "pencil", action: onEdit)
                } label: {
                    Image(systemName: "ellipsis.circle")
                }
                .accessibilityLabel("更多选项")
            }
        }
    }

    private func note(_ text: String) -> some View {
        Text(text).font(.footnote).foregroundStyle(Palette.muted)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.horizontal, 16).padding(.vertical, 4)
    }

    private func startCall() {
        Task {
            if let failure = await voice.start(botId: botId) { error = failure }
        }
    }

    private func messages(_ bot: Bot) -> some View {
        let timeline = store.timeline(botId)
        let tailKey = "\(timeline.messages.last?.id ?? "")|\(timeline.messages.last?.content.count ?? 0)|\(timeline.messages.last?.status ?? "")|\(bot.pendingApprovals.count)|\(bot.activity?.summary ?? "")"
        return GeometryReader { geometry in
            let bubbleWidth = min((geometry.size.width - 40) * 0.92, 600)
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(spacing: 10) {
                        if timeline.hasMore {
                            ProgressView()
                                .frame(maxWidth: .infinity)
                                .onAppear { loadMore(timeline, proxy: proxy) }
                        }
                        if timeline.loaded && timeline.messages.isEmpty {
                            Intro(bot: bot)
                        }
                        ForEach(timeline.messages) { message in
                            MessageRow(message: message, bubbleWidth: bubbleWidth, onOpenBot: onOpenBot)
                                .id(message.id)
                        }
                        if let summary = bot.activity?.summary {
                            NowReader { now in
                                HStack(spacing: 8) {
                                    BotFace(avatar: bot.avatar, mood: bot.mood(now: now, tool: timeline.runningTool), size: 26, seed: seedOf(bot.id))
                                    Text(summary).font(.footnote).foregroundStyle(Palette.muted)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(.vertical, 6)
                            }
                        }
                        ForEach(bot.pendingApprovals) { approval in
                            ApprovalCard(approval: approval)
                        }
                        Color.clear.frame(height: 1).id("bottom")
                    }
                    .frame(maxWidth: 900)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 20)
                    .padding(.vertical, 16)
                }
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: tailKey) {
                    guard !loadingMore else { return }
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
            }
        }
    }

    /// Older pages are prepended; keep the previously first message where it was.
    private func loadMore(_ timeline: Timeline, proxy: ScrollViewProxy) {
        guard !loadingMore, timeline.hasMore else { return }
        let anchor = timeline.messages.first?.id
        loadingMore = true
        Task {
            defer { loadingMore = false }
            do { try await store.loadMore(botId) } catch is CancellationError {} catch { self.error = errorText(error) }
            if let anchor { proxy.scrollTo(anchor, anchor: .top) }
        }
    }
}

private struct Intro: View {
    let bot: Bot

    var body: some View {
        VStack(spacing: 4) {
            BotFace(avatar: bot.avatar, mood: "happy", size: 112, seed: seedOf(bot.id))
            Text("和 \(bot.name) 打个招呼").fontWeight(.semibold).padding(.top, 8)
            Text(bot.persona.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? "它会记住你们的对话。" : bot.persona)
                .font(.footnote).foregroundStyle(Palette.muted).lineLimit(4).multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 40)
    }
}
