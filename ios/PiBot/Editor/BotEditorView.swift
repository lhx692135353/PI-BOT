import SwiftUI
import PiBotKit

struct BotEditorView: View {
    @Environment(AppStore.self) private var store
    let botId: String?
    let onDone: (String?) -> Void
    let onArchived: () -> Void
    @State private var name = ""
    @State private var persona = ""
    @State private var modelId: String?
    @State private var avatar = avatarFor(UUID().uuidString.lowercased())
    @State private var models: [Model] = []
    @State private var saving = false
    @State private var error: String?
    @State private var confirmArchive = false
    @State private var loaded = false
    @State private var runtime = "pi"
    @State private var directory = ""

    private var creating: Bool { botId == nil }
    private var cli: Bool { runtime == "cursor" || runtime == "codex" }
    private var canSave: Bool { !saving && !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    preview
                    TextField("名字（例如：研究助理）", text: $name)
                        .fieldStyle().padding(.top, 16)
                        .onChange(of: name) { if name.count > 40 { name = String(name.prefix(40)) } }
                    if cli {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(runtime == "cursor" ? "本机 Cursor" : "本机 Codex").fontWeight(.semibold)
                            if !directory.isEmpty { Text(directory).font(.footnote).foregroundStyle(Palette.muted).lineLimit(2) }
                            Text("电脑不在线时无法在云端运行。profile 和目录请在那台电脑上修改。")
                                .font(.footnote).foregroundStyle(Palette.muted)
                        }
                        .padding(.top, 12)
                    }
                    ZStack(alignment: .topLeading) {
                        if persona.isEmpty {
                            Text("人设与职责：它负责做什么、用什么风格说话、有哪些习惯……")
                                .foregroundStyle(Palette.muted.opacity(0.8)).padding(.top, 8).padding(.leading, 5)
                        }
                        TextEditor(text: $persona)
                            .frame(minHeight: 110)
                            .scrollContentBackground(.hidden)
                            .onChange(of: persona) { if persona.count > 8000 { persona = String(persona.prefix(8000)) } }
                    }
                    .fieldStyle().padding(.top, 12)
                    modelPicker.padding(.top, 12)

                    section("造型")
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 8) {
                            ForEach(botShapes, id: \.self) { shape in
                                let picked = shape == avatar.shape
                                Button { avatar.shape = shape } label: {
                                    BotFace(avatar: Avatar(shape: shape, color: avatar.color, scheme: avatar.scheme), mood: "idle", size: 56, paused: true, effects: false)
                                        .frame(width: 64, height: 64)
                                        .background(picked ? Palette.card : Palette.chip, in: RoundedRectangle(cornerRadius: 16))
                                        .overlay(RoundedRectangle(cornerRadius: 16).stroke(picked ? Palette.accent : .clear, lineWidth: 2))
                                }
                                .buttonStyle(.plain)
                                .accessibilityLabel(BotFaceAssets.spec?.shape(shape).label ?? shape)
                                .accessibilityAddTraits(picked ? .isSelected : [])
                            }
                        }
                    }

                    section("颜色")
                    LazyVGrid(columns: [GridItem(.adaptive(minimum: 34), spacing: 10)], alignment: .leading, spacing: 10) {
                        ForEach(botColors, id: \.self) { color in
                            let picked = color == avatar.color
                            let stops = (BotFaceAssets.spec?.color(color).light ?? ["#F4692A"]).map(hexColor)
                            Button { avatar.color = color } label: {
                                Circle()
                                    .fill(LinearGradient(colors: stops, startPoint: .topLeading, endPoint: .bottomTrailing))
                                    .padding(4)
                                    .frame(width: 34, height: 34)
                                    .overlay(Circle().stroke(picked ? Palette.accent : .clear, lineWidth: 2))
                            }
                            .buttonStyle(.plain)
                            .accessibilityLabel(BotFaceAssets.spec?.color(color).label ?? color)
                            .accessibilityAddTraits(picked ? .isSelected : [])
                        }
                    }
                    Toggle("深色", isOn: Binding(get: { avatar.scheme == "dark" }, set: { avatar.scheme = $0 ? "dark" : "light" }))
                        .padding(.top, 14)

                    if creating {
                        Text("资料库会建在电脑的 ~/pi-bot/ 下，以名字生成文件夹；改名不会移动文件夹。")
                            .font(.footnote).foregroundStyle(Palette.muted).padding(.top, 8)
                    }
                    if let error { Text(error).foregroundStyle(Palette.danger).padding(.top, 8) }
                    Button(creating ? "创建" : "保存", action: save)
                        .buttonStyle(PrimaryButtonStyle()).disabled(!canSave).padding(.top, 20)
                    if !creating {
                        Button("归档这个 Bot") { confirmArchive = true }
                            .buttonStyle(OutlineButtonStyle(color: Palette.danger)).padding(.top, 12)
                    }
                }
                .frame(maxWidth: 640)
                .padding(.horizontal, 20)
                .padding(.bottom, 32)
                .frame(maxWidth: .infinity)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Palette.paper)
            .navigationTitle(creating ? "新建 Bot" : "编辑 Bot")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { onDone(nil) } }
                ToolbarItem(placement: .confirmationAction) { Button(creating ? "创建" : "保存", action: save).fontWeight(.semibold).disabled(!canSave) }
            }
            .alert("归档「\(name)」？", isPresented: $confirmArchive) {
                Button("归档", role: .destructive, action: archive)
                Button("取消", role: .cancel) {}
            } message: {
                Text("它会从列表消失。电脑上的资料库文件夹保留不动。")
            }
        }
        .interactiveDismissDisabled(saving)
        .onAppear(perform: fill)
        .task {
            do {
                try await store.refreshMe()
                models = try await store.models()
            } catch is CancellationError {
            } catch {
                self.error = errorText(error)
            }
        }
    }

    private var preview: some View {
        let dark = avatar.scheme == "dark"
        let spec = BotFaceAssets.spec
        return VStack(spacing: 2) {
            BotFace(avatar: avatar, mood: "happy", size: 150)
            Text(name.trimmingCharacters(in: .whitespaces).isEmpty ? "新 Bot" : name)
                .font(.system(size: 18, weight: .semibold)).foregroundStyle(dark ? hexColor("#F2F1EF") : Palette.ink)
            Text("\(spec?.shape(avatar.shape).label ?? avatar.shape) · \(spec?.color(avatar.color).label ?? avatar.color)")
                .font(.footnote).foregroundStyle(Palette.muted)
            Button("随机换一个") {
                var next = avatarFor(UUID().uuidString.lowercased())
                next.scheme = avatar.scheme
                avatar = next
            }
            .padding(.top, 6)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .background(
            LinearGradient(colors: dark ? [hexColor("#2C2D33"), hexColor("#1C1D21")] : [hexColor("#FFF6EE"), hexColor("#F6EFE7")],
                           startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 24)
        )
        .padding(.top, 8)
    }

    private var modelPicker: some View {
        let fallback = models.first(where: \.isDefault)
        let followLabel = "跟随默认" + (fallback.map { "（\($0.name)）" } ?? "")
        let label = models.first { $0.id == modelId }?.name ?? followLabel
        return Menu {
            Button(followLabel) { modelId = nil }
            ForEach(models) { model in Button(model.name) { modelId = model.id } }
        } label: {
            HStack {
                Text(cli ? "路由模型" : "模型").foregroundStyle(Palette.muted)
                Spacer()
                Text(label).foregroundStyle(Palette.ink).lineLimit(1)
                Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(Palette.muted)
            }
            .fieldStyle()
        }
    }

    private func section(_ title: String) -> some View {
        Text(title).fontWeight(.semibold).padding(.top, 18).padding(.bottom, 8)
    }

    private func fill() {
        guard !loaded else { return }
        loaded = true
        guard let id = botId, let bot = store.bot(id) else { return }
        name = bot.name
        persona = bot.persona
        modelId = bot.modelId
        runtime = bot.runtime
        directory = bot.cliDirectory ?? ""
        avatar = bot.avatar.normalized()
    }

    private func save() {
        guard canSave else { return }
        saving = true
        error = nil
        Task {
            defer { saving = false }
            do {
                let input = BotInput(name: name.trimmingCharacters(in: .whitespaces), persona: persona.trimmingCharacters(in: .whitespacesAndNewlines), modelId: modelId, avatar: avatar)
                let bot = if let botId { try await store.updateBot(botId, input: input) } else { try await store.createBot(input) }
                onDone(bot.id)
            } catch {
                self.error = errorText(error)
            }
        }
    }

    private func archive() {
        guard let botId else { return }
        Task {
            do {
                try await store.archiveBot(botId)
                onArchived()
            } catch {
                self.error = errorText(error)
            }
        }
    }
}
