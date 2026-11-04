import SwiftUI
import PhotosUI
import PiBotKit

struct Composer: View {
    let botId: String
    let botName: String
    @Binding var text: String
    let callEnabled: Bool
    let onCall: () -> Void
    let onSend: (String, String, [ChatImage]) async -> Bool
    @State private var sending = false
    @State private var reading = false
    @State private var images: [ChatImage] = []
    @State private var picked: [PhotosPickerItem] = []
    @State private var imageError: String?
    @State private var retryText = ""
    @State private var retryImages: [ChatImage] = []
    @State private var requestId = UUID().uuidString.lowercased()
    @FocusState private var focused: Bool

    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty) && !sending && !reading
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let imageError { Text(imageError).font(.footnote).foregroundStyle(Palette.danger).padding(.horizontal, 16) }
            if !images.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(Array(images.enumerated()), id: \.offset) { index, image in
                            ZStack(alignment: .topTrailing) {
                                ChatPicture(image: image, maxHeight: 76)
                                    .frame(maxWidth: 120)
                                Button {
                                    images.remove(at: index)
                                } label: {
                                    Image(systemName: "xmark.circle.fill").font(.system(size: 20)).symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, Palette.ink.opacity(0.7))
                                }
                                .disabled(sending || reading)
                                .accessibilityLabel("移除")
                                .padding(4)
                            }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button(action: onCall) { Image(systemName: "phone.fill").frame(width: 40, height: 40) }
                    .disabled(!callEnabled || sending)
                    .accessibilityLabel("语音通话")
                PhotosPicker(selection: $picked, maxSelectionCount: max(1, 4 - images.count), matching: .images) {
                    Image(systemName: "plus").font(.system(size: 18, weight: .semibold)).frame(width: 40, height: 40)
                }
                .disabled(sending || reading || images.count >= 4)
                .accessibilityLabel("上传图片")
                TextField("向 \(botName) 提问", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 4)
                Button(action: send) {
                    Image(systemName: "arrow.up").font(.system(size: 17, weight: .bold))
                        .foregroundStyle(canSend ? Color.white : Palette.muted)
                        .frame(width: 38, height: 38)
                        .background(canSend ? Palette.accent : Palette.line, in: Circle())
                }
                .disabled(!canSend)
                .accessibilityLabel("发送")
                .padding(.bottom, 1)
            }
            .tint(Palette.ink)
            .padding(.leading, 4).padding(.trailing, 4).padding(.vertical, 2)
            .background(Palette.card, in: RoundedRectangle(cornerRadius: 24))
            .overlay(RoundedRectangle(cornerRadius: 24).stroke(Palette.line))
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 16).padding(.top, 6).padding(.bottom, 10)
        }
        .onChange(of: picked) {
            let items = picked
            guard !items.isEmpty else { return }
            picked = []
            guard !reading, !sending else { return }
            reading = true
            imageError = nil
            let target = botId
            Task {
                defer { reading = false }
                do {
                    let selected = try await readChatImages(items, existing: images)
                    if target == botId { images = selected }
                } catch {
                    imageError = errorText(error)
                }
            }
        }
    }

    private func send() {
        let draft = text
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = images
        guard canSend else { return }
        // Retrying the same content reuses the request id so the server can deduplicate it.
        if retryText != value || retryImages != attachments {
            retryText = value
            retryImages = attachments
            requestId = UUID().uuidString.lowercased()
        }
        sending = true
        Task {
            defer { sending = false }
            if await onSend(value, requestId, attachments) {
                if text == draft { text = "" }
                images = []
                retryImages = []
                retryText = ""
            }
        }
    }
}

struct CallOverlay: View {
    let bot: Bot
    let call: LiveCall
    let onMute: (Bool) -> Void
    let onHangup: () -> Void

    var body: some View {
        NowReader(period: 1) { now in
            let elapsed = call.startedAt > 0 ? max(0, now - call.startedAt) / 1000 : 0
            VStack(spacing: 0) {
                BotFace(avatar: bot.avatar, mood: mood, size: 180, seed: seedOf(bot.id))
                Text(bot.name).font(.title2.weight(.semibold)).padding(.top, 16)
                Text(call.error ?? phase).foregroundStyle(call.error != nil ? Palette.danger : Palette.muted).padding(.top, 6)
                Text(String(format: "%02d:%02d", elapsed / 60, elapsed % 60))
                    .font(.system(size: 28, weight: .medium).monospacedDigit()).padding(.top, 8)
                HStack(spacing: 12) {
                    Button(call.muted ? "取消静音" : "静音") { onMute(!call.muted) }
                        .buttonStyle(OutlineButtonStyle())
                    Button("挂断", action: onHangup)
                        .buttonStyle(PrimaryButtonStyle(color: Palette.danger))
                }
                .frame(maxWidth: 320)
                .padding(.top, 28)
            }
            .padding(24)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private var phase: String {
        switch call.phase {
        case "connecting": return "接通中"
        case "listening": return "正在听"
        case "speaking": return "正在说"
        case "thinking": return "想一下"
        default: return "通话中"
        }
    }

    private var mood: String {
        switch call.phase {
        case "speaking": return "working"
        case "thinking", "connecting": return "thinking"
        default: return "happy"
        }
    }
}
