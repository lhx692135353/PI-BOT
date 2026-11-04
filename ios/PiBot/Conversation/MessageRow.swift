import SwiftUI
import PiBotKit

struct MessageRow: View {
    @Environment(AppStore.self) private var store
    @Environment(\.openURL) private var openURL
    let message: Message
    let bubbleWidth: CGFloat
    let onOpenBot: (String) -> Void
    @State private var selectedTask: AgentTaskRef?
    @State private var artifactError: String?

    var body: some View {
        Group {
            if message.role == "user", let from = message.fromBot {
                relay(from)
            } else {
                regular
            }
        }
        .frame(maxWidth: .infinity, alignment: message.role == "user" && message.fromBot == nil ? .trailing : .leading)
        .sheet(item: $selectedTask) { task in
            TaskConversationSheet(botId: message.botId, task: task, onOpenBot: onOpenBot)
        }
    }

    private func bubble(_ text: String, user: Bool = false, markdown: Bool = true, fill: Color? = nil) -> some View {
        SelectableText(text: text, markdown: markdown, color: user ? .white : UIColor(Palette.ink))
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(fill ?? (user ? Palette.ink : Palette.card), in: RoundedRectangle(cornerRadius: 18))
            .frame(maxWidth: bubbleWidth, alignment: user ? .trailing : .leading)
    }

    private func relay(_ from: FromBot) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Button { onOpenBot(from.id) } label: {
                HStack(spacing: 6) {
                    if let avatar = from.avatar { BotFace(avatar: avatar, mood: "happy", size: 22, seed: seedOf(from.id)) }
                    Text(relayLabel(from)).font(.caption).foregroundStyle(Palette.muted)
                }
            }
            .buttonStyle(.plain)
            bubble(message.content, markdown: false, fill: Palette.accentSoft)
            Text(dayLabel(message.createdAt) + " " + clockTime(message.createdAt)).font(.system(size: 11)).foregroundStyle(Palette.muted)
        }
    }

    private var regular: some View {
        let user = message.role == "user"
        let remarks = message.replySegments.isEmpty ? message.progress : []
        let showContent = !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && !message.replySegments.contains { $0.phase == "answer" }
        let tasks = message.agentTasks.filter { $0.kind != "background" }
        return VStack(alignment: user ? .trailing : .leading, spacing: 6) {
            if !user {
                ForEach(Array(remarks.enumerated()), id: \.offset) { _, line in bubble(line) }
                ForEach(message.replySegments) { segment in
                    bubble(segment.text)
                    Text(clockTime(segment.createdAt)).font(.system(size: 11)).foregroundStyle(Palette.muted)
                }
                if !tasks.isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(tasks) { task in taskChip(task) }
                    }
                    .padding(.horizontal, 14)
                }
            }
            ForEach(message.attachments) { file in attachment(file) }
            if let artifactError { Text(artifactError).font(.footnote).foregroundStyle(Palette.danger) }
            if !message.images.isEmpty {
                VStack(alignment: user ? .trailing : .leading, spacing: 6) {
                    ForEach(message.images) { image in
                        ChatPicture(remote: image, botId: message.botId, messageId: message.id)
                    }
                }
                .frame(maxWidth: bubbleWidth, alignment: user ? .trailing : .leading)
            }
            if (user && !message.content.isEmpty) || (!user && (showContent || message.replySegments.isEmpty)) {
                if !message.content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    bubble(message.content, user: user, markdown: !user)
                } else if message.status == "running" {
                    placeholder("…")
                } else if message.status == "cancelled" {
                    placeholder("已停止")
                }
            }
            if !user, message.ui != nil {
                A2UIView(message: message, disabled: message.status != "completed")
                    .frame(maxWidth: bubbleWidth)
                    .padding(.top, 2)
            }
            footnote(user: user)
        }
    }

    private func placeholder(_ text: String) -> some View {
        Text(text).foregroundStyle(Palette.muted)
            .padding(.horizontal, 14).padding(.vertical, 10)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 18))
    }

    @ViewBuilder private func footnote(user: Bool) -> some View {
        let note: String? = switch message.status {
        case "failed": "失败"
        case "cancelled": "已停止"
        default: !user && message.executor == "cloud" ? "云端" : nil
        }
        if message.replySegments.isEmpty || note != nil {
            let time = message.replySegments.isEmpty ? dayLabel(message.createdAt) + " " + clockTime(message.createdAt) : nil
            Text([time, note].compactMap { $0 }.joined(separator: " · "))
                .font(.system(size: 11))
                .foregroundStyle(message.status == "failed" ? Palette.danger : Palette.muted)
        }
    }

    private func taskChip(_ task: AgentTaskRef) -> some View {
        let live = task.status == "queued" || task.status == "running"
        return Button { selectedTask = task } label: {
            Text("\(task.messageCount) 条消息往来 · \(task.botName) · \(taskStateLabel(task.status)) ›")
                .font(.caption)
                .foregroundStyle(task.status == "failed" ? Palette.danger : live ? Palette.accent : Palette.muted)
                .padding(.horizontal, 10).padding(.vertical, 3)
                .background(live ? Palette.accentSoft : Palette.card, in: Capsule())
        }
        .buttonStyle(.plain)
    }

    private func attachment(_ file: ReportAttachment) -> some View {
        Button {
            Task {
                do { openURL(try await store.reportOpen(file.id)) } catch { artifactError = errorText(error) }
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                Text(file.title).fontWeight(.semibold).foregroundStyle(Palette.ink)
                Text("Markdown · \(file.size / 1024 + 1) KB · 打开报告 ›").font(.subheadline).foregroundStyle(Palette.muted)
            }
            .padding(16)
            .frame(maxWidth: bubbleWidth, alignment: .leading)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 14))
            .overlay(RoundedRectangle(cornerRadius: 14).stroke(Palette.line))
        }
        .buttonStyle(.plain)
    }
}

struct ApprovalCard: View {
    @Environment(AppStore.self) private var store
    let approval: Approval
    @State private var deciding = false
    @State private var confirmAlways = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("想访问资料库以外的位置").fontWeight(.semibold)
            Text(approval.path)
                .font(.system(size: 13, design: .monospaced))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(Palette.card, in: RoundedRectangle(cornerRadius: 8))
            if !approval.reason.trimmingCharacters(in: .whitespaces).isEmpty {
                Text(approval.reason).foregroundStyle(Palette.ink.opacity(0.8))
            }
            Text(approval.scope).font(.caption)
            if let error { Text(error).font(.footnote).foregroundStyle(Palette.danger) }
            HStack(spacing: 4) {
                Spacer()
                Button("拒绝") { decide("reject") }
                Button("仅本次允许") { decide("approve") }
                Button("一直允许") { confirmAlways = true }.disabled(!approval.canRemember)
            }
            .buttonStyle(.borderless)
            .disabled(deciding)
            if !approval.canRemember {
                Text("写入、命令和旧版宽泛权限需要逐次确认。").font(.caption).foregroundStyle(Palette.muted)
            }
        }
        .padding(14)
        .background(Palette.accentSoft, in: RoundedRectangle(cornerRadius: 18))
        .alert("记住以下权限？", isPresented: $confirmAlways) {
            Button("一直允许") { decide("approve_always") }
            Button("取消", role: .cancel) {}
        } message: {
            Text("\(approval.scope)\n可在设置 → 已保存授权中撤销。")
        }
    }

    private func decide(_ decision: String) {
        deciding = true
        error = nil
        Task {
            defer { deciding = false }
            do { try await store.decide(approval, decision: decision) } catch { self.error = errorText(error) }
        }
    }
}
