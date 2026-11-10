import SwiftUI
import PiBotKit

@main
struct PiBotApp: App {
    @State private var store: AppStore
    @State private var voice: VoiceCallController

    init() {
        let store = AppStore(timelineStore: FileTimelineCache())
        let voice = VoiceCallController(store: store)
        store.onSignedOut = { [weak voice] in voice?.hangup() }
        _store = State(initialValue: store)
        _voice = State(initialValue: voice)
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(store)
                .environment(voice)
                .tint(Palette.accent)
                .preferredColorScheme(.light)
        }
    }
}

struct RootView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.scenePhase) private var phase

    var body: some View {
        Group {
            if store.session == nil { LoginView() } else { SignedInView() }
        }
        .onChange(of: phase, initial: true) { syncEvents() }
        .onChange(of: store.session) { syncEvents() }
    }

    /// Live events only while the app is on screen, like Android's ON_START / ON_STOP.
    private func syncEvents() {
        if store.session == nil || phase == .background {
            store.stopEvents()
        } else if phase == .active {
            store.startEvents()
        }
    }
}
