import SwiftUI
import PiBotKit

/// Read-only browser for a bot's library on the selected source (`~/pi-bot/<slug>`).
struct FilesView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    let botId: String
    @State private var sources: [FileSource] = []
    @State private var source: String?
    @State private var path = ""
    @State private var opened: String?
    @State private var list: FileList?
    @State private var file: FileContent?
    @State private var error: String?
    @State private var reload = 0

    private var bot: Bot? { store.bot(botId) }
    private var targetOnline: Bool { sources.first { $0.target == source }?.online == true }
    private var nested: Bool { opened != nil || !path.isEmpty }

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(sources) { item in
                        Button {
                            source = item.target; path = ""; opened = nil; list = nil; file = nil
                        } label: {
                            Text("\(item.label) · \(item.online ? "在线" : "离线")")
                                .font(.footnote)
                                .foregroundStyle(item.target == source ? Palette.accent : Palette.ink)
                                .padding(.horizontal, 12).padding(.vertical, 6)
                                .background(item.target == source ? Palette.accentSoft : Palette.card, in: Capsule())
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.horizontal, 16).padding(.vertical, 8)
            }
            ZStack(alignment: .bottomTrailing) {
                content
                if let bot, opened == nil, !(list?.entries.isEmpty ?? true) {
                    BotFace(avatar: bot.avatar, mood: "searching", size: 56, seed: seedOf(bot.id))
                        .padding(16)
                        .allowsHitTesting(false)
                }
            }
        }
        .background(Palette.paper)
        .navigationTitle(opened.map { ($0 as NSString).lastPathComponent } ?? "资料库")
        .navigationBarTitleDisplayMode(.inline)
        .navigationBarBackButtonHidden(nested)
        .toolbar {
            if nested {
                ToolbarItem(placement: .topBarLeading) {
                    Button(action: up) { Image(systemName: "chevron.backward") }.accessibilityLabel("返回")
                }
            }
            ToolbarItem(placement: .principal) {
                VStack(spacing: 0) {
                    Text(opened.map { ($0 as NSString).lastPathComponent } ?? "资料库").font(.headline).lineLimit(1)
                    Text((sources.first { $0.target == source }?.label ?? "文件来源") + " / " + (opened ?? path))
                        .font(.caption).foregroundStyle(Palette.muted).lineLimit(1).truncationMode(.head)
                }
            }
        }
        .task(id: store.devices.map { "\($0.id):\($0.online)" }.joined(separator: ",")) {
            do {
                let found = try await store.fileSources(botId: botId).sources
                sources = found
                if source == nil { source = found.first(where: \.online)?.target ?? found.first?.target }
            } catch is CancellationError {
            } catch {
                self.error = errorText(error)
            }
        }
        .task(id: "\(path)|\(reload)|\(targetOnline)|\(source ?? "")") {
            list = nil
            error = nil
            guard let source else { return }
            do { list = try await store.files(botId: botId, path: path, target: source) }
            catch is CancellationError {}
            catch { self.error = errorText(error) }
        }
        .task(id: "\(opened ?? "")|\(source ?? "")|\(targetOnline)|\(reload)") {
            file = nil
            guard let target = opened else { return }
            do { file = try await store.file(botId: botId, path: target, target: source) }
            catch is CancellationError {}
            catch { self.error = errorText(error); opened = nil }
        }
    }

    @ViewBuilder private var content: some View {
        let avatar = bot?.avatar ?? .orange
        if opened != nil {
            FilePreview(file: file)
        } else if let error {
            EmptyStateView(avatar: avatar, mood: targetOnline ? "error" : "sleeping", title: targetOnline ? "打不开" : "电脑离线", message: error) {
                Button("重试") { reload += 1 }.buttonStyle(.borderedProminent)
            }
        } else if source == nil {
            EmptyStateView(avatar: avatar, mood: "idle", title: "暂无文件来源", message: "添加电脑或启用云端环境后，可在这里选择文件来源。")
        } else if let entries = list?.entries {
            if entries.isEmpty {
                EmptyStateView(avatar: avatar, mood: "idle", title: "这里还是空的", message: "让 \(bot?.name ?? "Bot") 写点东西进来吧。")
            } else {
                List(entries, id: \.name) { entry in
                    Button {
                        let child = path.isEmpty ? entry.name : "\(path)/\(entry.name)"
                        if entry.type == "dir" { path = child } else { opened = child }
                    } label: {
                        EntryRow(entry: entry)
                    }
                    .listRowBackground(Color.clear)
                }
                .listStyle(.plain)
                .scrollContentBackground(.hidden)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func up() {
        if opened != nil {
            opened = nil
        } else if !path.isEmpty {
            path = path.contains("/") ? String(path[..<path.lastIndex(of: "/")!]) : ""
        } else {
            dismiss()
        }
    }
}

private struct EntryRow: View {
    let entry: FileEntry

    var body: some View {
        HStack(spacing: 8) {
            Text(entry.type == "dir" ? "📁" : "📄").font(.system(size: 22)).frame(width: 32)
            VStack(alignment: .leading, spacing: 2) {
                Text(entry.name).foregroundStyle(Palette.ink).lineLimit(1)
                if entry.type != "dir" {
                    Text(humanSize(entry.size) + (entry.modified.map { " · " + dayLabel($0) + " " + clockTime($0) } ?? ""))
                        .font(.caption).foregroundStyle(Palette.muted)
                }
            }
            Spacer()
            if entry.type == "dir" { Image(systemName: "chevron.right").font(.footnote).foregroundStyle(Palette.muted) }
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
    }
}

private struct FilePreview: View {
    let file: FileContent?

    var body: some View {
        if let file {
            switch file.kind {
            case "text":
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if file.name.lowercased().hasSuffix(".md") {
                            SelectableText(text: file.content ?? "")
                        } else {
                            ScrollView(.horizontal) {
                                Text(file.content ?? "")
                                    .font(.system(size: 12, design: .monospaced))
                                    .textSelection(.enabled)
                                    .fixedSize()
                                    .padding(12)
                            }
                            .background(Palette.card, in: RoundedRectangle(cornerRadius: 12))
                        }
                        if file.truncated {
                            Text("文件较大，只显示前 512KB。").font(.caption).foregroundStyle(Palette.muted)
                        }
                    }
                    .padding(16)
                }
            case "image":
                if let data = file.base64.flatMap({ Data(base64Encoded: $0, options: .ignoreUnknownCharacters) }), let image = UIImage(data: data) {
                    Image(uiImage: image).resizable().scaledToFit().padding(16)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    unsupported(file)
                }
            default:
                unsupported(file)
            }
        } else {
            ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func unsupported(_ file: FileContent) -> some View {
        VStack(spacing: 8) {
            Text("📄").font(.system(size: 48))
            Text(file.name).fontWeight(.semibold)
            Text("\(humanSize(file.size)) · 手机上暂不支持预览，请在电脑的文件管理器里打开。")
                .foregroundStyle(Palette.muted).multilineTextAlignment(.center)
        }
        .padding(32)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}
