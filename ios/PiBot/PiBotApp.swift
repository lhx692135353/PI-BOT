import SwiftUI
import PiBotKit

@main
struct PiBotApp: App {
    @State private var store: AppStore
    @State private var voice: VoiceCallController
    @State private var skin = SkinStore.shared

    init() {
        let store = AppStore(timelineStore: FileTimelineCache())
        let voice = VoiceCallController(store: store)
        store.onSignedOut = { [weak voice] in voice?.hangup() }
        _store = State(initialValue: store)
        _voice = State(initialValue: voice)
    }

    var body: some Scene {
        WindowGroup {
            Group {
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--math-smoke"),
                   let url = Bundle.main.url(forResource: "math-smoke", withExtension: "json", subdirectory: "a2ui"),
                   let data = try? Data(contentsOf: url), let json = JSONValue.parse(String(decoding: data, as: UTF8.self)),
                   let source = json["source"]?.stringValue {
                    ScrollView { SelectableText(text: source).padding() }
                } else { RootView() }
                #else
                RootView()
                #endif
            }
                .environment(store)
                .environment(voice)
                .environment(skin)
                .tint(Palette.accent)
                .preferredColorScheme(skin.skin == .ironman ? .dark : .light)
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(SkinStore.self) private var skinStore
    @Environment(\.scenePhase) private var phase

    var body: some View {
        ZStack {
            Group {
                if store.session == nil { LoginView() } else { SignedInView() }
            }
            if let token = skinStore.introToken {
                IronManIntroOverlay {
                    skinStore.introToken = nil
                }
                .id(token)
                .zIndex(100)
            }
        }
        .onChange(of: phase, initial: true) { syncEvents() }
        .onChange(of: store.session) { syncEvents() }
        .onChange(of: store.bots?.count) { syncSkin() }
    }

    /// Live events only while the app is on screen, like Android's ON_START / ON_STOP.
    private func syncEvents() {
        if store.session == nil || phase == .background {
            store.stopEvents()
        } else if phase == .active {
            store.startEvents()
            syncSkin()
        }
    }

    private func syncSkin() {
        guard store.session != nil else { return }
        Task {
            if let prefs = try? await store.preferences() {
                skinStore.applyFromServer(prefs.skin)
            }
        }
    }
}
