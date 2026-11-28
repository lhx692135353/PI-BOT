import SwiftUI
import WebKit
import UIKit
import PiBotKit

struct MathMarkdown: View {
    let text: String
    let color: UIColor
    let size: CGFloat
    @State private var height: CGFloat = 24
    var body: some View { MathMarkdownWeb(text: text, color: color, size: size, height: $height).frame(height: height).frame(maxWidth: .infinity) }
}

private struct MathMarkdownWeb: UIViewRepresentable {
    let text: String
    let color: UIColor
    let size: CGFloat
    @Binding var height: CGFloat
    func makeCoordinator() -> Coordinator { Coordinator(self) }
    func makeUIView(context: Context) -> WKWebView {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.setURLSchemeHandler(A2UIAssets(), forURLScheme: "pibot-ui")
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: "window.PiBotUiHost={postMessage:v=>window.webkit.messageHandlers.mathHost.postMessage(String(v))};", injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "mathHost")
        configuration.userContentController = controller
        let web = InlineUiWebView(frame: .zero, configuration: configuration)
        web.isOpaque = false; web.backgroundColor = .clear; web.scrollView.backgroundColor = .clear
        web.scrollView.isScrollEnabled = false; web.scrollView.contentInsetAdjustmentBehavior = .never
        web.navigationDelegate = context.coordinator; context.coordinator.web = web
        web.load(URLRequest(url: URL(string: "pibot-ui://app/a2ui/index.html")!))
        return web
    }
    func updateUIView(_ web: WKWebView, context: Context) { context.coordinator.parent = self; context.coordinator.update() }
    static func dismantleUIView(_ web: WKWebView, coordinator: Coordinator) {
        coordinator.web = nil; (web as? InlineUiWebView)?.scrolling.stop()
        web.configuration.userContentController.removeScriptMessageHandler(forName: "mathHost"); web.stopLoading()
    }
    @MainActor final class Coordinator: NSObject, WKScriptMessageHandler, WKNavigationDelegate {
        var parent: MathMarkdownWeb
        weak var web: WKWebView?
        var ready = false, sent = ""
        var smokeStarted = false
        init(_ parent: MathMarkdownWeb) { self.parent = parent }
        func update() {
            guard ready, let web else { return }
            var red: CGFloat = 0, green: CGFloat = 0, blue: CGFloat = 0, alpha: CGFloat = 0
            parent.color.getRed(&red, green: &green, blue: &blue, alpha: &alpha)
            let color = String(format: "#%02x%02x%02x", Int(red*255), Int(green*255), Int(blue*255))
            let fontSize = UIFontMetrics(forTextStyle: .body).scaledFont(for: .systemFont(ofSize: parent.size)).pointSize
            let payload = JSONValue.object(["markdown": .object(["source": .string(parent.text), "fontSize": .double(Double(fontSize)), "color": .string(color)])]).jsonString()
            guard sent != payload else { return }; sent = payload
            web.evaluateJavaScript("window.piBotUi?.receive(JSON.parse(\(JSONValue.string(payload).jsonString())));", completionHandler: nil)
            #if DEBUG
            if ProcessInfo.processInfo.arguments.contains("--math-smoke"), !smokeStarted,
               let url = Bundle.main.url(forResource: "math-smoke", withExtension: "js", subdirectory: "a2ui"), let script = try? String(contentsOf: url, encoding: .utf8) {
                smokeStarted = true
                web.evaluateJavaScript(script + ";window.piBotMathSmoke(JSON.parse(\(JSONValue.string(payload).jsonString())));", completionHandler: nil)
            }
            #endif
        }
        func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction) async -> WKNavigationActionPolicy {
            action.request.url?.absoluteString == "pibot-ui://app/a2ui/index.html" && action.targetFrame?.isMainFrame == true ? .allow : .cancel
        }
        func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
            guard let text = message.body as? String, text.count <= 500_000, let packet = JSONValue.parse(text) else { return }
            switch packet["type"]?.stringValue {
            case "ready": ready = true; sent = ""; update()
            case "height":
                if let value = packet["height"]?.intValue, value > 0, value <= 1_000_000 { parent.height = CGFloat(value) }
            case "math_smoke":
                #if DEBUG
                if ProcessInfo.processInfo.arguments.contains("--math-smoke"), case .object(var result)? = packet["result"],
                   let directory = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first {
                    result["clipboard_text"] = .string(UIPasteboard.general.string ?? "")
                    result["clipboard_ok"] = .bool(UIPasteboard.general.string == result["expectedCopy"]?.stringValue)
                    try? JSONValue.object(result).jsonString().write(to: directory.appendingPathComponent("math-smoke.json"), atomically: true, encoding: .utf8)
                }
                #endif
            case "copy", "external":
                guard let id = packet["id"]?.stringValue, let payload = packet["payload"] else { return }
                var result: [String: JSONValue] = ["id": .string(id), "result": .null]
                if packet["type"]?.stringValue == "copy", let value = payload["text"]?.stringValue, value.count <= 400_000 {
                    UIPasteboard.general.string = value
                } else if packet["type"]?.stringValue == "external", let value = payload["url"]?.stringValue, let url = URL(string: value), ["https","http"].contains(url.scheme ?? ""), url.host != nil, url.user == nil, url.password == nil {
                    UIApplication.shared.open(url)
                } else { result["error"] = .string("操作参数无效") }
                web?.evaluateJavaScript("window.piBotUi?.respond(JSON.parse(\(JSONValue.string(JSONValue.object(result).jsonString()).jsonString())));", completionHandler: nil)
            default: break
            }
        }
    }
}
