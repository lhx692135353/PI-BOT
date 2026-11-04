import SwiftUI
import UIKit
import PiBotKit

/// One message as one selectable text: partial selection, copy and links work like
/// Android's `CopyableMessage`. Markdown is flattened by `messageDocument`.
struct SelectableText: UIViewRepresentable {
    let text: String
    var markdown = true
    var color: UIColor = UIColor(Palette.ink)
    var size: CGFloat = 16

    final class Coordinator {
        var key: String?
        var rendered = NSAttributedString()
        var shown: String?
    }

    func makeCoordinator() -> Coordinator { Coordinator() }

    private var key: String { "\(markdown)|\(size)|\(color.hashValue)|\(text)" }

    /// Measuring may happen before `updateUIView`, so both share one cached rendering.
    private func attributed(_ coordinator: Coordinator) -> NSAttributedString {
        if coordinator.key != key {
            coordinator.key = key
            coordinator.rendered = render()
        }
        return coordinator.rendered
    }

    func makeUIView(context: Context) -> UITextView {
        let view = UITextView()
        view.isEditable = false
        view.isSelectable = true
        view.isScrollEnabled = false
        view.backgroundColor = .clear
        view.textContainerInset = .zero
        view.textContainer.lineFragmentPadding = 0
        view.adjustsFontForContentSizeCategory = true
        view.linkTextAttributes = [.foregroundColor: UIColor(Palette.accent), .underlineStyle: NSUnderlineStyle.single.rawValue]
        view.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        view.setContentHuggingPriority(.required, for: .vertical)
        return view
    }

    func updateUIView(_ view: UITextView, context: Context) {
        let coordinator = context.coordinator
        let next = attributed(coordinator)
        // Reassigning unchanged text would drop the user's selection.
        guard coordinator.shown != coordinator.key else { return }
        coordinator.shown = coordinator.key
        view.attributedText = next
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        let limit = proposal.width.flatMap { $0.isFinite ? $0 : nil } ?? 10_000
        let bounds = attributed(context.coordinator).boundingRect(
            with: CGSize(width: limit, height: .greatestFiniteMagnitude),
            options: [.usesLineFragmentOrigin, .usesFontLeading], context: nil
        )
        return CGSize(width: min(limit, ceil(bounds.width)), height: ceil(bounds.height))
    }

    private func render() -> NSAttributedString {
        let document = messageDocument(text, markdown: markdown)
        let metrics = UIFontMetrics(forTextStyle: .body)
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        let result = NSMutableAttributedString(string: document.text, attributes: [
            .font: metrics.scaledFont(for: .systemFont(ofSize: size)),
            .foregroundColor: color,
            .paragraphStyle: paragraph,
        ])
        let length = result.length
        for mark in document.marks {
            let range = NSRange(location: mark.start, length: min(mark.end, length) - mark.start)
            guard range.location >= 0, range.length > 0, range.location + range.length <= length else { continue }
            switch mark.kind {
            case "bold": restyle(result, range) { $0.withTraits(.traitBold) }
            case "italic": restyle(result, range) { $0.withTraits(.traitItalic) }
            case "heading":
                let level = Int(mark.value) ?? 1
                let headingSize = max(15, 19 - CGFloat(level) * 1.2) + (size - 16)
                result.addAttribute(.font, value: metrics.scaledFont(for: .systemFont(ofSize: headingSize, weight: .bold)), range: range)
            case "code":
                result.addAttribute(.font, value: metrics.scaledFont(for: .monospacedSystemFont(ofSize: size - 3, weight: .regular)), range: range)
                result.addAttribute(.backgroundColor, value: UIColor(Palette.codeBackground), range: range)
            case "quote":
                result.addAttribute(.foregroundColor, value: UIColor(Palette.muted), range: range)
            case "link":
                if let url = URL(string: mark.value) { result.addAttribute(.link, value: url, range: range) }
            default:
                break
            }
        }
        return result
    }

    private func restyle(_ text: NSMutableAttributedString, _ range: NSRange, _ change: (UIFont) -> UIFont) {
        text.enumerateAttribute(.font, in: range) { value, sub, _ in
            if let font = value as? UIFont { text.addAttribute(.font, value: change(font), range: sub) }
        }
    }
}

private extension UIFont {
    func withTraits(_ trait: UIFontDescriptor.SymbolicTraits) -> UIFont {
        guard let descriptor = fontDescriptor.withSymbolicTraits(fontDescriptor.symbolicTraits.union(trait)) else { return self }
        return UIFont(descriptor: descriptor, size: pointSize)
    }
}
