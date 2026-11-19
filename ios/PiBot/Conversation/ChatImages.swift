import SwiftUI
import PhotosUI
import UniformTypeIdentifiers
import PiBotKit

let imageLimitHint = "最多 4 张图片，单张原图不超过 20 MB，合计不超过 32 MB；原图保存，模型仅使用压缩副本；支持 JPEG、PNG、WebP、GIF"
private let maxImageBytes = 20 * 1024 * 1024
private let maxTotalBytes = 32 * 1024 * 1024
private let allowedTypes: [(UTType, String)] = [(.jpeg, "image/jpeg"), (.png, "image/png"), (.webP, "image/webp"), (.gif, "image/gif")]

struct ImageLimitError: LocalizedError { var errorDescription: String? { imageLimitHint } }

/// Keep supported originals byte-for-byte; only the model boundary resizes images.
func readChatImages(_ items: [PhotosPickerItem], existing: [ChatImage]) async throws -> [ChatImage] {
    guard existing.count + items.count <= 4 else { throw ImageLimitError() }
    var added: [ChatImage] = []
    for (index, item) in items.enumerated() {
        guard let data = try await item.loadTransferable(type: Data.self) else { throw ImageLimitError() }
        let type = item.supportedContentTypes.first
        let name = "图片\(existing.count + index + 1)"
        guard !data.isEmpty, data.count <= maxImageBytes else { throw ImageLimitError() }
        if let match = allowedTypes.first(where: { type?.conforms(to: $0.0) == true }), data.count <= maxImageBytes, !data.isEmpty {
            added.append(ChatImage(name: name + "." + (match.0.preferredFilenameExtension ?? "img"), mimeType: match.1, data: data.base64EncodedString()))
        } else {
            let png = try await Task.detached(priority: .userInitiated) { try reencode(data) }.value
            added.append(ChatImage(name: name + ".png", mimeType: "image/png", data: png.base64EncodedString()))
        }
    }
    let all = existing + added
    guard all.reduce(0, { $0 + decodedSize($1.data) }) <= maxTotalBytes else { throw ImageLimitError() }
    return all
}

func appendCameraImage(_ image: UIImage, existing: [ChatImage]) throws -> [ChatImage] {
    guard existing.count < 4, let raw = image.jpegData(compressionQuality: 0.9) else { throw ImageLimitError() }
    guard raw.count <= maxImageBytes else { throw ImageLimitError() }
    let data = raw
    let result = existing + [ChatImage(name: "拍照.jpg", mimeType: "image/jpeg", data: data.base64EncodedString())]
    guard result.reduce(0, { $0 + decodedSize($1.data) }) <= maxTotalBytes else { throw ImageLimitError() }
    return result
}

private func decodedSize(_ base64: String) -> Int {
    base64.count * 3 / 4 - (base64.hasSuffix("==") ? 2 : base64.hasSuffix("=") ? 1 : 0)
}

private func reencode(_ data: Data) throws -> Data {
    guard let image = UIImage(data: data) else { throw ImageLimitError() }
    // Unsupported picker formats (e.g. HEIC) need a lossless upload representation.
    guard let output = image.pngData(), output.count <= maxImageBytes else { throw ImageLimitError() }
    return output
}

/// Bounded preview decoded off the main thread, even for high resolution uploads.
private func preview(_ image: ChatImage) async throws -> UIImage {
    try await Task.detached(priority: .userInitiated) {
        guard let data = Data(base64Encoded: image.data, options: .ignoreUnknownCharacters),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, [
                  kCGImageSourceCreateThumbnailFromImageAlways: true,
                  kCGImageSourceCreateThumbnailWithTransform: true,
                  kCGImageSourceThumbnailMaxPixelSize: 1600,
              ] as CFDictionary)
        else { throw ImageLimitError() }
        return UIImage(cgImage: cg)
    }.value
}

/// A local attachment (`image`) or a stored message image (`remote`), tap to view full screen.
struct ChatPicture: View {
    @Environment(AppStore.self) private var store
    var image: ChatImage?
    var remote: MessageImage?
    var botId = ""
    var messageId = ""
    var maxHeight: CGFloat = 220
    @State private var loaded: UIImage?
    @State private var failed = false
    @State private var attempt = 0
    @State private var expanded = false

    var body: some View {
        Group {
            if let loaded {
                Image(uiImage: loaded).resizable().scaledToFit()
                    .frame(maxHeight: maxHeight)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
                    .onTapGesture { expanded = true }
            } else {
                Button { if failed { attempt += 1 } } label: {
                    Text(failed ? "图片加载失败，点击重试" : "图片加载中…").font(.footnote).foregroundStyle(Palette.muted).padding(8)
                }
                .buttonStyle(.plain)
                .disabled(!failed)
            }
        }
        .task(id: "\(image?.data.count ?? 0)-\(remote?.id ?? "")-\(attempt)") {
            failed = false
            do {
                let source: ChatImage
                if let image { source = image } else { source = try await store.image(botId: botId, messageId: messageId, imageId: remote?.id ?? "") }
                loaded = try await preview(source)
            } catch is CancellationError {
            } catch {
                failed = true
            }
        }
        .fullScreenCover(isPresented: $expanded) {
            ZStack {
                Color.black.ignoresSafeArea()
                if let loaded { Image(uiImage: loaded).resizable().scaledToFit() }
            }
            .onTapGesture { expanded = false }
            .accessibilityAddTraits(.isButton)
            .accessibilityLabel("关闭图片")
        }
        .accessibilityLabel(image?.name ?? remote?.name ?? "图片")
    }
}
