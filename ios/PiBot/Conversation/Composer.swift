import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import AVFoundation
import PiBotKit

@MainActor
struct Composer: View {
    let botId: String
    let botName: String
    @Binding var text: String
    let callEnabled: Bool
    let onCall: () -> Void
    @Environment(AppStore.self) private var store
    let onSend: (String, String, [ChatImage], [String]) async -> Bool
    @State private var files: [FileDraft] = []
    @State private var uploads: [String: Task<Void, Never>] = [:]
    @State private var importTask: Task<Void, Never>?
    @State private var importing = false
    @State private var showingPhotos = false
    @State private var showingCamera = false
    @State private var retryFiles: [String] = []
    @State private var sending = false
    @State private var reading = false
    @State private var images: [ChatImage] = []
    @State private var picked: [PhotosPickerItem] = []
    @State private var imageError: String?
    @State private var retryText = ""
    @State private var retryImages: [ChatImage] = []
    @State private var requestId = UUID().uuidString.lowercased()
    @FocusState private var focused: Bool

    private var attachmentCount: Int { images.count + files.count }
    private var readyToSend: Bool { !sending && !reading && files.allSatisfy { $0.artifact != nil } }
    private var canSend: Bool {
        (!text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !images.isEmpty || !files.isEmpty) && readyToSend
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
            ForEach(files) { file in
                HStack {
                    Text("\(file.name) · \(file.artifact == nil ? "\(file.progress)%" : "已上传")").lineLimit(1)
                    if let error = file.error {
                        Text(error).font(.footnote).foregroundStyle(Palette.danger)
                        Button("重试") { upload(file) }
                    }
                    Button(file.artifact == nil ? "取消上传" : "移除") { removeFile(file.id) }.disabled(sending)
                }.font(.footnote).padding(.horizontal, 16)
            }
            HStack(alignment: .bottom, spacing: 2) {
                Button(action: onCall) { Image(systemName: "phone.fill").frame(width: 40, height: 40) }
                    .disabled(!callEnabled || sending)
                    .accessibilityLabel("语音通话")
                Menu {
                    Button("拍照", systemImage: "camera") {
                        guard hasAttachmentSlot() else { return }
                        Task {
                            guard UIImagePickerController.isSourceTypeAvailable(.camera) else { imageError = "此设备没有可用相机"; return }
                            let allowed = await AVCaptureDevice.requestAccess(for: .video)
                            if allowed { showingCamera = true } else { imageError = "请在系统设置中允许相机访问" }
                        }
                    }
                    Button("照片", systemImage: "photo") { if hasAttachmentSlot() { showingPhotos = true } }
                    Button("文件", systemImage: "doc") { if hasAttachmentSlot() { importing = true } }
                } label: {
                    Image(systemName: "plus").font(.system(size: 18, weight: .semibold)).frame(width: 40, height: 40)
                }
                .disabled(sending || reading)
                .accessibilityLabel("添加附件")
                TextField("向 \(botName) 提问", text: $text, axis: .vertical)
                    .lineLimit(1...5)
                    .focused($focused)
                    .padding(.vertical, 10)
                    .padding(.horizontal, 4)
                Button(action: { send() }) {
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
        .photosPicker(isPresented: $showingPhotos, selection: $picked, maxSelectionCount: maxMessageAttachments, matching: .images)
        .sheet(isPresented: $showingCamera) {
            CameraCapture { image in
                showingCamera = false
                guard let image, hasAttachmentSlot() else { return }
                do { images = try appendCameraImage(image, existing: images) }
                catch { imageError = errorText(error) }
            }.ignoresSafeArea()
        }
        .fileImporter(isPresented: $importing, allowedContentTypes: [.item], allowsMultipleSelection: true) { result in
            switch result {
            case .success(let urls):
                guard !reading, !sending, hasAttachmentSlot(urls.count) else { return }
                imageError = nil
                reading = true
                importTask = Task {
                    defer { reading = false; importTask = nil }
                    for url in urls {
                        do {
                            let file = try await readFileDraft(url)
                            try Task.checkCancellation()
                            files.append(file); upload(file)
                        } catch is CancellationError { break }
                        catch { imageError = errorText(error) }
                    }
                }
            case .failure(let error):
                if (error as NSError).code != NSUserCancelledError { imageError = errorText(error) }
            }
        }
        .onDisappear {
            importTask?.cancel()
            for i in files.indices where files[i].artifact == nil { files[i].error = "上传已暂停，请重试" }
            uploads.values.forEach { $0.cancel() }; uploads = [:]
            let pending = files.filter { $0.artifact == nil }.map(\.id)
            Task { for id in pending { try? await store.cancelDocumentUpload(id) } }
        }
        .onChange(of: picked) {
            let items = picked
            guard !items.isEmpty else { return }
            picked = []
            guard !reading, !sending, hasAttachmentSlot(items.count) else { return }
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

    private func hasAttachmentSlot(_ adding: Int = 1) -> Bool {
        guard attachmentCount + adding <= maxMessageAttachments else { imageError = attachmentLimitHint; return false }
        return true
    }

    private func removeFile(_ id: String) {
        uploads.removeValue(forKey: id)?.cancel()
        files.removeAll { $0.id == id }
        Task { try? await store.cancelDocumentUpload(id) }
    }

    private func upload(_ file: FileDraft) {
        guard let index = files.firstIndex(where: { $0.id == file.id }) else { return }
        files[index].error = nil
        uploads[file.id] = Task { @MainActor in
            defer { uploads[file.id] = nil }
            do {
                let artifact = try await store.uploadDocument(botId: botId, id: file.id, name: file.name, data: file.data) { progress in
                    if let i = files.firstIndex(where: { $0.id == file.id }) { files[i].progress = progress }
                }
                try Task.checkCancellation()
                if let i = files.firstIndex(where: { $0.id == file.id }) { files[i].artifact = artifact }
            } catch is CancellationError {
            } catch {
                if let i = files.firstIndex(where: { $0.id == file.id }) { files[i].error = errorText(error) }
            }
        }
    }

    private func send() {
        let draft = text
        let value = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        let attachments = images
        guard readyToSend, !value.isEmpty || attachmentCount > 0, hasAttachmentSlot(0) else { return }
        // Retrying the same content reuses the request id so the server can deduplicate it.
        let documentIds = files.compactMap { $0.artifact?.id }
        if retryText != value || retryImages != attachments || retryFiles != documentIds {
            retryFiles = documentIds
            retryText = value
            retryImages = attachments
            requestId = UUID().uuidString.lowercased()
        }
        sending = true
        Task {
            defer { sending = false }
            if await onSend(value, requestId, attachments, documentIds) {
                if text == draft { text = "" }
                files = []; retryFiles = []
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
                SkinnedBotFace(avatar: bot.avatar, mood: mood, size: 180, seed: seedOf(bot.id), botId: bot.id)
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
