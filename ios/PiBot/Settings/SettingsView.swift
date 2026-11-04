import SwiftUI
import PiBotKit

struct SettingsView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var removing: Device?
    @State private var error: String?
    @State private var changing = false

    private var version: String { Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "" }

    var body: some View {
        NavigationStack {
            Form {
                Section("账号") {
                    LabeledContent("用户", value: store.session?.user.shownName ?? "")
                    LabeledContent("服务器", value: store.session?.serverUrl ?? "")
                    LabeledContent("实时连接", value: store.live ? "已连接" : "未连接")
                }
                Section {
                    let active = store.devices.filter { $0.revokedAt == nil }.uniqued()
                    if let cloud = store.cloudComputer {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(cloud.label)
                            Text("Linux · \(cloud.online ? "在线" : "准备中") · 资料库").font(.caption).foregroundStyle(Palette.muted)
                        }
                    }
                    if active.isEmpty && store.cloudComputer == nil {
                        Text("在 Mac 或 Linux 上安装 Pi Bot，并用同一个账号登录，即可添加执行电脑。").font(.subheadline).foregroundStyle(Palette.muted)
                    }
                    ForEach(active) { device in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(device.label)
                                Text("\(device.platformLabel) · \(device.online ? "在线" : "离线")").font(.caption).foregroundStyle(Palette.muted)
                            }
                            Spacer()
                            Button("解绑", role: .destructive) { removing = device }.buttonStyle(.borderless)
                        }
                    }
                    if let error { Text(error).foregroundStyle(Palette.danger) }
                } header: {
                    Text("执行电脑")
                } footer: {
                    Text("任务默认在云端电脑上执行，需要你电脑上的文件或应用时才用那台电脑。资料库以云端电脑为准，电脑资料库里生成的文件会同步一份到云端。")
                }
                Section {
                    Button("修改密码") { changing = true }
                    Button("退出登录", role: .destructive) {
                        dismiss()
                        store.logout()
                    }
                }
                SavedAuthorizationsSection()
                Section {
                } footer: {
                    Text("Pi Bot \(version)")
                }
            }
            .scrollContentBackground(.hidden)
            .background(Palette.paper)
            .navigationTitle("设置")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("完成") { dismiss() } } }
            .alert("解绑「\(removing?.label ?? "")」？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { device in
                Button("解绑", role: .destructive) {
                    Task {
                        do { try await store.revokeDevice(device.id) } catch { self.error = errorText(error) }
                    }
                }
                Button("取消", role: .cancel) {}
            } message: { _ in
                Text("文件会保留；新任务会选择其他可用机器。依赖该电脑文件的任务将暂时无法执行。")
            }
            .sheet(isPresented: $changing) { PasswordSheet() }
        }
        .task {
            do { try await store.refreshMe() } catch is CancellationError {} catch { self.error = errorText(error) }
        }
    }
}

private struct PasswordSheet: View {
    @Environment(AppStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var old = ""
    @State private var new = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            Form {
                SecureField("原密码", text: $old).textContentType(.password)
                SecureField("新密码（至少 8 位）", text: $new).textContentType(.newPassword)
                if let error { Text(error).foregroundStyle(Palette.danger) }
            }
            .navigationTitle("修改密码")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("取消") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("保存") {
                        busy = true
                        Task {
                            defer { busy = false }
                            do {
                                try await store.changePassword(old: old, new: new)
                                dismiss()
                            } catch {
                                self.error = errorText(error)
                            }
                        }
                    }
                    .disabled(busy || old.isEmpty || new.count < 8)
                }
            }
        }
        .presentationDetents([.medium])
    }
}

/// Read grants the user saved from approval cards, plus the audit log.
private struct SavedAuthorizationsSection: View {
    @Environment(AppStore.self) private var store
    @State private var rules: [SavedAuthorization] = []
    @State private var logs: [AuthorizationLog] = []
    @State private var error: String?
    @State private var busy = false
    @State private var removing: SavedAuthorization?
    @State private var showLogs = false

    var body: some View {
        Section {
            if let error { Text(error).foregroundStyle(Palette.danger) }
            if !busy && error == nil && rules.isEmpty { Text("暂无已保存授权。").foregroundStyle(Palette.muted) }
            ForEach(rules) { rule in
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text("\(rule.targetLabel) · 读取")
                        Text(rule.resource + (rule.resourceType == "directory" ? "（含子路径）" : "")).font(.subheadline)
                        Text("保存于 \(rule.createdAt)" + (rule.lastUsedAt.map { " · 最近使用 \($0)" } ?? ""))
                            .font(.caption).foregroundStyle(Palette.muted)
                    }
                    Spacer()
                    Button("撤销", role: .destructive) { removing = rule }.buttonStyle(.borderless).disabled(busy)
                }
            }
            Button(busy ? "正在加载…" : "刷新授权") { Task { await refresh() } }.disabled(busy)
            Button(showLogs ? "收起授权日志" : "授权及使用日志（最近 100 条）") { showLogs.toggle() }
            if showLogs {
                ForEach(logs) { log in
                    Text("\(log.createdAt) · \(action(log.action)) · \(log.operation)\n\(log.target)\n\(log.resource)")
                        .font(.caption).foregroundStyle(Palette.muted)
                }
            }
        } header: {
            Text("已保存授权")
        } footer: {
            Text("仅当前账号、指定电脑和资源的读取；不包含写入、删除或执行命令。每次使用由服务器验证。")
        }
        .task { await refresh() }
        .alert("撤销读取授权？", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { rule in
            Button("撤销", role: .destructive) {
                busy = true
                Task {
                    defer { busy = false }
                    do {
                        try await store.revokeAuthorization(rule.id)
                        busy = false
                        await refresh()
                    } catch {
                        self.error = errorText(error)
                    }
                }
            }
            Button("取消", role: .cancel) {}
        } message: { rule in
            Text("\(rule.targetLabel) · \(rule.resource)\n后续访问将重新确认。")
        }
    }

    private func action(_ value: String) -> String {
        switch value {
        case "grant": return "保存授权"
        case "allow_once": return "仅本次允许"
        case "reject": return "拒绝"
        case "use": return "使用授权"
        case "revoke": return "撤销授权"
        default: return value
        }
    }

    private func refresh() async {
        if busy { return }
        busy = true
        error = nil
        defer { busy = false }
        do {
            rules = try await store.authorizations()
            logs = try await store.authorizationLogs()
        } catch is CancellationError {
        } catch {
            self.error = errorText(error)
        }
    }
}
