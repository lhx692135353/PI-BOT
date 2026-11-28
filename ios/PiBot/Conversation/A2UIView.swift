import SwiftUI
import WebKit
import PiBotKit

private let uiScheme = "pibot-ui"
private let uiIndex = URL(string: "pibot-ui://app/a2ui/index.html")!

/// The page calls `window.PiBotUiHost.postMessage`, the Android bridge name; map it onto WebKit's handler.
private let bridgeScript = """
window.PiBotUiHost = { postMessage: function (value) { window.webkit.messageHandlers.piBotUiHost.postMessage(String(value)); } };
"""

/// Interactive A2UI surface for one bot message, rendered by the shared web renderer.
struct A2UIView: View {
    @Environment(AppStore.self) private var store
    let message: Message
    let disabled: Bool
    let viewportHeight: CGFloat
    var onDisplayed: (Set<String>, Bool) -> Void = { _, _ in }
    @State private var height: CGFloat = 180

    var body: some View {
        A2UIWebView(message: message, disabled: disabled, viewportHeight: viewportHeight, store: store, height: $height, onDisplayed: onDisplayed)
            .frame(height: height)
            .frame(maxWidth: .infinity)
    }
}

private struct A2UIWebView: UIViewRepresentable {
    let message: Message
    let disabled: Bool
    let viewportHeight: CGFloat
    let store: AppStore
    @Binding var height: CGFloat
    var onDisplayed: (Set<String>, Bool) -> Void = { _, _ in }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.setURLSchemeHandler(A2UIAssets(), forURLScheme: uiScheme)
        config.websiteDataStore = .nonPersistent()
        config.preferences.javaScriptCanOpenWindowsAutomatically = false
        let content = WKUserContentController()
        content.addUserScript(WKUserScript(source: bridgeScript, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        content.add(WeakScriptHandler(context.coordinator), name: "piBotUiHost")
        config.userContentController = content
        let web = InlineUiWebView(frame: .zero, configuration: config)
        web.isOpaque = false
        web.backgroundColor = .clear
        web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false // Enabled by measured overflow, not a fixed height cutoff.
        web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator
        context.coordinator.web = web
        web.onLayout = { [weak coordinator = context.coordinator] in coordinator?.updateHeight() }
        web.load(URLRequest(url: uiIndex))
        return web
    }

    func updateUIView(_ web: WKWebView, context: Context) {
        context.coordinator.parent = self
        context.coordinator.updateHeight()
        context.coordinator.sendDocumentIfChanged()
    }

    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.web = nil
        (web as? InlineUiWebView)?.onLayout = nil
        (web as? InlineUiWebView)?.scrolling.stop()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "piBotUiHost")
        web.stopLoading()
    }

    @MainActor
    final class Coordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
        var parent: A2UIWebView
        weak var web: WKWebView?
        private var ready = false
        private var sent: String?
        private var contentHeight: CGFloat = 180
        private var pageWidth: CGFloat = 0
        private var heightScheduled = false

        init(_ parent: A2UIWebView) { self.parent = parent }

        func updateHeight() {
            guard !heightScheduled else { return }
            heightScheduled = true
            // Coalesce layout and bridge updates; read the latest width/content after layout.
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.heightScheduled = false
                self.applyHeight()
            }
        }

        private func applyHeight() {
            guard let web else { return }
            let scale = pageWidth > 0 && web.bounds.width > 0 ? web.bounds.width / pageWidth : 1
            let naturalHeight = contentHeight * scale
            let height = CGFloat(UiViewport.displayHeight(content: Double(naturalHeight), available: Double(parent.viewportHeight)))
            let scrollEnabled = naturalHeight > height + 1
            if web.scrollView.isScrollEnabled != scrollEnabled {
                web.scrollView.isScrollEnabled = scrollEnabled
            }
            let maximum = max(0, naturalHeight - height)
            if web.scrollView.contentOffset.y > maximum {
                web.scrollView.setContentOffset(CGPoint(x: 0, y: maximum), animated: false)
            }
            if abs(parent.height - height) > 0.5 {
                parent.height = height
            }
        }

        private var payload: String {
            JSONValue.object(["document": parent.message.ui ?? .null, "disabled": .bool(parent.disabled)]).jsonString()
        }

        func sendDocumentIfChanged() {
            guard ready, let web else { return }
            let next = payload
            guard next != sent else { return }
            sent = next
            web.evaluateJavaScript("window.piBotUi?.receive(JSON.parse(\(JSONValue.string(next).jsonString())));", completionHandler: nil)
        }

        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url == uiIndex && action.targetFrame?.isMainFrame == true ? .allow : .cancel
        }

        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let raw = message.body as? String, raw.count <= 240_000, let packet = JSONValue.parse(raw) else { return }
            switch packet["type"]?.stringValue {
            case "ready":
                ready = true
                sent = nil
                sendDocumentIfChanged()
            case "height":
                if let value = packet["height"]?.intValue, value >= 0 {
                    contentHeight = CGFloat(value)
                    pageWidth = CGFloat(max(0, packet["width"]?.intValue ?? 0))
                    updateHeight()
                }
            case "copy":
                guard let id = packet["id"]?.stringValue, let text = packet["payload"]?["text"]?.stringValue, text.count <= 200_000 else { return }
                UIPasteboard.general.string = text
                let response = JSONValue.object(["id": .string(id), "result": .null]).jsonString()
                web?.evaluateJavaScript("window.piBotUi?.respond(JSON.parse(\(JSONValue.string(response).jsonString())));", completionHandler: nil)
            case "displayed":
                if case .array(let items)? = packet["ids"] {
                    let allowed = Set(parent.message.attachments.map(\.id))
                    parent.onDisplayed(Set(items.compactMap(\.stringValue)).intersection(allowed), packet["remove"]?.boolValue ?? false)
                }
            case "state", "action", "image", "open", "external":
                guard let id = packet["id"]?.stringValue, let body = packet["payload"], case .object = body else { return }
                let kind = packet["type"]?.stringValue
                let isState = kind == "state"
                let target = parent.message
                let locked = parent.disabled
                let store = parent.store
                Task { @MainActor in
                    var response: [String: JSONValue] = ["id": .string(id)]
                    do {
                        if (kind == "state" || kind == "action") && locked { throw APIError(status: 0, message: "请等待 Bot 完成当前任务后再操作") }
                        if kind == "image" || kind == "open" {
                            guard let artifactId = body["id"]?.stringValue, target.attachments.contains(where: { $0.id == artifactId }) else { throw APIError(status: 404, message: "附件不属于当前消息") }
                            if kind == "image" {
                                let variant = body["variant"]?.stringValue == "original" ? "original" : "thumbnail"
                                let image = try await store.artifactImage(botId: target.botId, messageId: target.id, artifactId: artifactId, variant: variant)
                                response["result"] = .string("data:\(image.mimeType);base64,\(image.data)")
                            } else {
                                await UIApplication.shared.open(try await store.reportOpen(artifactId))
                                response["result"] = .null
                            }
                        } else if kind == "external" {
                            guard let text = body["url"]?.stringValue, let url = URL(string: text), ["https", "http"].contains(url.scheme ?? ""), url.host != nil, url.user == nil, url.password == nil else { throw APIError(status: 422, message: "链接无效") }
                            await UIApplication.shared.open(url)
                            response["result"] = .null
                        } else if isState {
                            response["result"] = try await store.saveUiState(botId: target.botId, messageId: target.id, payload: body)
                        } else {
                            try await store.submitUiAction(botId: target.botId, messageId: target.id, payload: body)
                            response["result"] = .null
                        }
                    } catch {
                        response["error"] = .string(errorText(error))
                    }
                    let json = JSONValue.object(response).jsonString()
                    _ = try? await self.web?.evaluateJavaScript("window.piBotUi?.respond(JSON.parse(\(JSONValue.string(json).jsonString())));")
                }
            default:
                break
            }
        }
    }
}

/// Avoids the retain cycle between `WKUserContentController` and the coordinator.
private final class WeakScriptHandler: NSObject, WKScriptMessageHandler {
    weak var target: (any WKScriptMessageHandler)?
    init(_ target: any WKScriptMessageHandler) { self.target = target }
    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        target?.userContentController(controller, didReceive: message)
    }
}

/// Renderer assets only. No account token, file system or general native API is exposed to the page.
final class A2UIAssets: NSObject, WKURLSchemeHandler {
    private static let files = ["/a2ui/index.html": "text/html", "/a2ui/renderer.js": "text/javascript", "/a2ui/style.css": "text/css"]

    private static func mime(_ path: String) -> String? {
        if let type = files[path] { return type }
        guard path.range(of: #"^/a2ui/KaTeX_[A-Za-z0-9_-]+\.(woff2?|ttf)$"#, options: .regularExpression) != nil else { return nil }
        return path.hasSuffix("woff2") ? "font/woff2" : path.hasSuffix("woff") ? "font/woff" : "font/ttf"
    }
    func webView(_ webView: WKWebView, start task: any WKURLSchemeTask) {
        guard let url = task.request.url, url.host == "app", let mime = Self.mime(url.path),
              let file = Bundle.main.url(forResource: url.lastPathComponent, withExtension: nil, subdirectory: "a2ui"),
              let data = try? Data(contentsOf: file) else {
            task.didFailWithError(URLError(.fileDoesNotExist))
            return
        }
        let response = HTTPURLResponse(url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: [
            "Content-Type": "\(mime); charset=utf-8",
            "Content-Length": String(data.count),
            "Access-Control-Allow-Origin": "pibot-ui://app",
        ])!
        task.didReceive(response)
        task.didReceive(data)
        task.didFinish()
    }

    func webView(_ webView: WKWebView, stop task: any WKURLSchemeTask) {}
}
