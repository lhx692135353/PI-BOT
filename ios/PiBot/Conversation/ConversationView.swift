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
    @State private var olderError: String?
    /// Distances from the viewport edges to the oldest loaded and the newest message.
    @State private var topGap: CGFloat = 0
    @State private var bottomGap: CGFloat = 0
    /// Older pages wait until the newest message has been on screen once, so opening never pages through history.
    @State private var reachedBottom = false
    @State private var settling = false
    @State private var firstRow: (id: String, frame: CGRect)?
    @State private var followTail = false

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
        .task(id: botId) {
            reachedBottom = false; settling = false; firstRow = nil; olderError = nil
            store.hydrate(botId)
            await load()
        }
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
                        followTail = true
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
            let viewport = geometry.size.height
            ScrollViewReader { proxy in
                ScrollView {
                    stack(bot, timeline: timeline, bubbleWidth: bubbleWidth, viewport: viewport, proxy: proxy)
                }
                .coordinateSpace(name: Self.scrollSpace)
                .defaultScrollAnchor(.bottom)
                .scrollDismissesKeyboard(.interactively)
                .onChange(of: reachedBottom) { loadMore(proxy: proxy, viewport: viewport) }
                .onChange(of: tailKey) {
                    guard !loadingMore else { return }
                    // Reading older history is not interrupted by a streaming reply; sending always returns to it.
                    guard followTail || bottomGap < viewport / 2 else { return }
                    followTail = false
                    withAnimation(.easeOut(duration: 0.2)) { proxy.scrollTo("bottom", anchor: .bottom) }
                }
                .overlay(alignment: .bottom) {
                    if bottomGap > viewport { jumpToBottom(proxy) }
                }
            }
        }
    }

    private func stack(_ bot: Bot, timeline: Timeline, bubbleWidth: CGFloat, viewport: CGFloat, proxy: ScrollViewProxy) -> some View {
        LazyVStack(spacing: 10) {
            if timeline.hasMore, !timeline.messages.isEmpty {
                Group {
                    if let olderError {
                        Button("\(olderError) · 点按重试") { self.olderError = nil; loadMore(proxy: proxy, viewport: viewport) }
                            .font(.footnote).foregroundStyle(Palette.muted)
                    } else {
                        ProgressView()
                    }
                }
                .frame(maxWidth: .infinity)
            }
            if timeline.loaded && timeline.messages.isEmpty {
                Intro(bot: bot)
            }
            ForEach(timeline.messages) { message in
                MessageRow(message: message, bubbleWidth: bubbleWidth, onOpenBot: onOpenBot)
                    .id(message.id)
                    .background {
                        if message.id == timeline.messages.first?.id {
                            FrameReader(space: Self.scrollSpace) { firstRow = (message.id, $0) }
                        }
                    }
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
        // Lazy children appear and disappear unreliably; the stack's own frame is the scroll position.
        .background(FrameReader(space: Self.scrollSpace) { trackScroll($0, viewport: viewport, proxy: proxy) })
        .frame(maxWidth: 900)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 20)
        .padding(.vertical, 16)
    }

    private func jumpToBottom(_ proxy: ScrollViewProxy) -> some View {
        Button {
            withAnimation(.easeOut(duration: 0.25)) { proxy.scrollTo("bottom", anchor: .bottom) }
        } label: {
            Image(systemName: "chevron.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(Palette.ink)
                .frame(width: 38, height: 38)
                .background(Palette.card, in: Circle())
                .overlay(Circle().stroke(Palette.line, lineWidth: 1))
                .shadow(color: .black.opacity(0.08), radius: 6, y: 2)
        }
        .accessibilityLabel("回到最新消息")
        .padding(.bottom, 12)
        .transition(.opacity)
    }

    private static let scrollSpace = "conversation-scroll"

    /// Older history starts loading this far before the top is reached.
    private static let loadAhead: CGFloat = 600

    private func trackScroll(_ frame: CGRect, viewport: CGFloat, proxy: ScrollViewProxy) {
        topGap = -frame.minY
        bottomGap = frame.maxY - viewport
        if bottomGap < 40, !reachedBottom, !settling {
            // A lazy stack's first layouts use estimated heights that can look like a short history.
            settling = true
            Task { try? await Task.sleep(nanoseconds: 400_000_000); reachedBottom = true }
        }
        loadMore(proxy: proxy, viewport: viewport)
    }

    /// Older pages are prepended; keep the previously first message where it was on screen.
    private func loadMore(proxy: ScrollViewProxy, viewport: CGFloat) {
        let timeline = store.timeline(botId)
        guard reachedBottom, !loadingMore, olderError == nil, timeline.hasMore, topGap < Self.loadAhead,
              let anchor = timeline.messages.first?.id else { return }
        let before = firstRow?.id == anchor ? firstRow?.frame : nil
        loadingMore = true
        Task {
            do {
                try await store.loadMore(botId)
                // Scrolling to the row needs the layout that already contains the older page.
                await Task.yield()
                // Aligning point y of the row with point y of the viewport puts its top at y * (viewport - height).
                if let before, abs(viewport - before.height) > 1 {
                    proxy.scrollTo(anchor, anchor: UnitPoint(x: 0.5, y: before.minY / (viewport - before.height)))
                } else {
                    proxy.scrollTo(anchor, anchor: .top)
                }
                // The restored offset lands a layout later; until then the old offset still looks like the top.
                try? await Task.sleep(nanoseconds: 150_000_000)
            } catch is CancellationError {
            } catch {
                olderError = errorText(error)
            }
            loadingMore = false
        }
    }
}

/// Reports the view's frame in a named scroll space whenever it moves.
private struct FrameReader: View {
    let space: String
    let report: (CGRect) -> Void

    var body: some View {
        GeometryReader { g in
            let frame = g.frame(in: .named(space))
            Color.clear.onChange(of: frame, initial: true) { report(frame) }
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
