import SwiftUI
import PiBotKit

private let defaultServer = (Bundle.main.object(forInfoDictionaryKey: "PiBotDefaultServerURL") as? String)
    .flatMap { $0.isEmpty ? nil : $0 } ?? "http://localhost:8000"

struct LoginView: View {
    @Environment(AppStore.self) private var store
    @State private var server = ""
    @State private var editServer = false
    @State private var username = ""
    @State private var password = ""
    @State private var busy = false
    @State private var error: String?
    @State private var mood = "happy"
    @FocusState private var focus: Field?

    private enum Field { case username, password, server }

    private var ready: Bool { !busy && !username.trimmingCharacters(in: .whitespaces).isEmpty && !password.isEmpty }

    var body: some View {
        GeometryReader { proxy in
            ScrollView {
                VStack(spacing: 0) {
                    BotFace(avatar: .orange, mood: mood, size: 150)
                    Text("Pi Bot").font(.system(size: 28, weight: .bold)).foregroundStyle(Palette.ink)
                    Text("你的 Bot 们在电脑上干活，手机随时找它们。")
                        .foregroundStyle(Palette.muted).multilineTextAlignment(.center).padding(.top, 6)

                    VStack(spacing: 12) {
                        TextField("用户名", text: $username)
                            .textContentType(.username).textInputAutocapitalization(.never).autocorrectionDisabled()
                            .submitLabel(.next).focused($focus, equals: .username)
                            .onSubmit { focus = .password }
                            .fieldStyle()
                        SecureField("密码", text: $password)
                            .textContentType(.password).submitLabel(.go).focused($focus, equals: .password)
                            .onSubmit(submit)
                            .fieldStyle()
                        if editServer {
                            TextField("服务器地址", text: $server)
                                .keyboardType(.URL).textContentType(.URL).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .focused($focus, equals: .server)
                                .fieldStyle()
                        } else {
                            Button { editServer = true; focus = .server } label: {
                                Text("服务器：" + server.replacingOccurrences(of: "https://", with: ""))
                                    .font(.footnote).foregroundStyle(Palette.muted)
                            }
                        }
                    }
                    .padding(.top, 28)
                    .onChange(of: username) { if mood == "error" { mood = "idle" } }
                    .onChange(of: password) { if mood == "error" { mood = "idle" } }

                    if let error {
                        Text(error).foregroundStyle(Palette.danger).multilineTextAlignment(.center).padding(.top, 10)
                    }
                    Button(action: submit) {
                        if busy { ProgressView().tint(.white) } else { Text("登录") }
                    }
                    .buttonStyle(PrimaryButtonStyle())
                    .disabled(!ready)
                    .padding(.top, 16)
                    Text("账号由管理员在后台创建。").font(.caption).foregroundStyle(Palette.muted).padding(.top, 12)
                }
                .frame(maxWidth: 420)
                .padding(.horizontal, 28)
                .padding(.vertical, 32)
                .frame(maxWidth: .infinity, minHeight: proxy.size.height)
            }
            .scrollDismissesKeyboard(.interactively)
        }
        .background(Palette.paper.ignoresSafeArea())
        .onAppear { if server.isEmpty { server = store.lastServerUrl() ?? defaultServer } }
    }

    private func submit() {
        guard ready else { return }
        busy = true
        error = nil
        mood = "thinking"
        Task {
            defer { busy = false }
            do {
                try await store.login(server: server, username: username, password: password)
            } catch {
                self.error = errorText(error)
                mood = "error"
            }
        }
    }
}
