import SwiftUI
import PiBotKit

struct FilesRoute: Hashable { let botId: String }

/// iPad and wide iPhone windows show the bot list beside the conversation;
/// compact widths collapse into one navigation stack.
struct SignedInView: View {
    @Environment(AppStore.self) private var store
    @Environment(\.horizontalSizeClass) private var sizeClass
    @State private var selection: String?
    @State private var columns = NavigationSplitViewVisibility.all
    @State private var path = NavigationPath()
    @State private var sheet: Sheet?
    @State private var wideSelectionMade = false

    private enum Sheet: Identifiable {
        case settings, create, edit(String)
        var id: String {
            switch self {
            case .settings: return "settings"
            case .create: return "create"
            case .edit(let id): return "edit-" + id
            }
        }
    }

    private var wide: Bool { sizeClass == .regular }

    var body: some View {
        NavigationSplitView(columnVisibility: $columns) {
            BotListView(selection: $selection, wide: wide, onCreate: { sheet = .create }, onSettings: { sheet = .settings })
                .navigationSplitViewColumnWidth(min: 280, ideal: 330, max: 380)
        } detail: {
            NavigationStack(path: $path) {
                Group {
                    if let id = selection {
                        ConversationView(
                            botId: id,
                            onEdit: { sheet = .edit(id) },
                            onFiles: { path.append(FilesRoute(botId: id)) },
                            onOpenBot: { other in if other != id { selection = other } }
                        )
                        .id(id)
                    } else {
                        EmptyStateView(avatar: .orange, mood: "happy", title: "一起开始新的对话", message: "从左侧选择一个 Bot，或新建你的专属伙伴。")
                            .background(Palette.paper)
                    }
                }
                .navigationDestination(for: FilesRoute.self) { FilesView(botId: $0.botId) }
            }
        }
        .navigationSplitViewStyle(.balanced)
        .onChange(of: selection) { path = NavigationPath() }
        .onChange(of: store.bots?.first?.id, initial: true) { selectDefault() }
        .onChange(of: wide) { selectDefault() }
        .sheet(item: $sheet) { item in
            switch item {
            case .settings:
                SettingsView()
            case .create:
                BotEditorView(botId: nil, onDone: { saved in
                    sheet = nil
                    if let saved { selection = saved }
                }, onArchived: {})
            case .edit(let id):
                BotEditorView(botId: id, onDone: { _ in sheet = nil }, onArchived: {
                    sheet = nil
                    selection = nil
                })
            }
        }
    }

    /// Wide layouts open the main bot once, so the detail column is never empty on launch.
    private func selectDefault() {
        guard wide, selection == nil, !wideSelectionMade, let bots = store.bots,
              let first = bots.first(where: \.isMain) ?? bots.first else { return }
        wideSelectionMade = true
        selection = first.id
    }
}
