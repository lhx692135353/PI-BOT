import SwiftUI
import PiBotKit

/// Messages two bots exchanged for one delegated task, refreshed every few seconds.
struct TaskConversationSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let botId: String
    let task: AgentTaskRef
    let onOpenBot: (String) -> Void
    @State private var page: TaskConversation?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                Section {
                    if let bots = page?.bots, !bots.isEmpty {
                        HStack(spacing: 6) {
                            ForEach(Array(bots.enumerated()), id: \.element.id) { index, bot in
                                if index > 0 { Text("↔").foregroundStyle(Palette.muted) }
                                BotFace(avatar: bot.avatar, mood: "happy", size: 24, seed: seedOf(bot.id))
                                Text(bot.name).font(.footnote).lineLimit(1)
                            }
                        }
                    }
                    Text("\(page?.total ?? task.messageCount) 条消息往来 · \(taskStateLabel(page?.status ?? task.status))")
                        .font(.caption).foregroundStyle(Palette.muted)
                    if let label = page?.executionLabel {
                        Text("本次使用：\(label)").font(.caption).foregroundStyle(Palette.muted)
                    }
                }
                .listRowBackground(Color.clear)
                Section {
                    if page == nil && busy { Text("正在加载传话…").foregroundStyle(Palette.muted) }
                    if page?.messages.isEmpty == true { Text("还没有传话记录").foregroundStyle(Palette.muted) }
                    ForEach(page?.messages ?? []) { message in
                        let sender = page?.bots.first { $0.id == message.fromBotId }
                        VStack(alignment: .leading, spacing: 6) {
                            HStack(spacing: 6) {
                                if let sender { BotFace(avatar: sender.avatar, mood: "happy", size: 22, seed: seedOf(sender.id)) }
                                Text(sender?.name ?? "智能体").font(.footnote).foregroundStyle(Palette.accent)
                                Spacer()
                                if let at = message.createdAt { Text(clockTime(at)).font(.system(size: 11)).foregroundStyle(Palette.muted) }
                            }
                            SelectableText(text: message.content, size: 15)
                                .padding(12)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                        }
                        .listRowSeparator(.hidden)
                    }
                    if let error {
                        VStack(alignment: .leading) {
                            Text(error).foregroundStyle(Palette.danger)
                            Button("重试") { Task { await load() } }.disabled(busy)
                        }
                    }
                    if page?.hasMore == true {
                        Button(busy ? "正在加载…" : "加载更多往来") { Task { await load(more: true) } }.disabled(busy)
                    }
                }
                .listRowBackground(Color.clear)
                Section {
                    Button("打开 \(task.botName) 的聊天 ›") {
                        dismiss()
                        onOpenBot(task.botId)
                    }
                }
                .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .background(Palette.paper)
            .navigationTitle("传话详情")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("关闭") { dismiss() } } }
        }
        .task(id: task.id) {
            await load()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 5_000_000_000)
                if Task.isCancelled { return }
                await load()
            }
        }
    }

    private func load(more: Bool = false) async {
        if busy { return }
        busy = true
        defer { busy = false }
        do {
            let old = page
            let after: Int64 = if let old, more || !old.hasMore { old.nextAfter } else { 0 }
            var next = try await store.taskConversation(botId: botId, taskId: task.id, after: after)
            var seen = Set<String>()
            next.messages = ((old?.messages ?? []) + next.messages).filter { seen.insert($0.id).inserted }.sorted { $0.seq < $1.seq }
            next.nextAfter = max(old?.nextAfter ?? 0, next.nextAfter)
            if after == 0, let old { next.hasMore = old.hasMore }
            page = next
            error = nil
        } catch is CancellationError {
        } catch {
            self.error = errorText(error)
        }
    }
}
