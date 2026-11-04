import Foundation

/// A deliberately small Markdown subset for bot replies: headings, lists, quotes, code fences, tables and inline marks.
public enum MarkdownBlock: Hashable, Sendable {
    case heading(level: Int, text: String)
    case paragraph(String)
    case bullet(marker: String, text: String, depth: Int)
    case quote(String)
    case code(String)
    case table([[String]])
    case rule
}

public struct Span: Hashable, Sendable {
    public var text: String
    public var bold = false
    public var italic = false
    public var code = false

    public init(_ text: String, bold: Bool = false, italic: Bool = false, code: Bool = false) {
        self.text = text; self.bold = bold; self.italic = italic; self.code = code
    }
}

private let headingPattern = try! NSRegularExpression(pattern: "^(#{1,6})\\s+(.*)$")
private let bulletPattern = try! NSRegularExpression(pattern: "^(\\s*)([-*+]|\\d+[.)])\\s+(.*)$")
private let tableDivider = try! NSRegularExpression(pattern: "^\\|?\\s*:?-{2,}:?\\s*(\\|\\s*:?-{2,}:?\\s*)*\\|?$")
private let linkPattern = try! NSRegularExpression(pattern: "\\[([^\\]\\n]+)\\]\\((https?://[^\\s)]+)\\)")

private func groups(_ regex: NSRegularExpression, _ s: String) -> [String]? {
    let ns = s as NSString
    guard let m = regex.firstMatch(in: s, range: NSRange(location: 0, length: ns.length)), m.range.location == 0, m.range.length == ns.length else { return nil }
    return (0..<m.numberOfRanges).map { i in
        let r = m.range(at: i)
        return r.location == NSNotFound ? "" : ns.substring(with: r)
    }
}

private func trim(_ s: String) -> String { s.trimmingCharacters(in: .whitespaces) }

public func parseMarkdown(_ source: String) -> [MarkdownBlock] {
    var blocks: [MarkdownBlock] = []
    let lines = source.replacingOccurrences(of: "\r\n", with: "\n").components(separatedBy: "\n")
    var paragraph: [String] = []
    func flush() {
        if !paragraph.isEmpty { blocks.append(.paragraph(paragraph.joined(separator: "\n"))) }
        paragraph.removeAll()
    }
    var i = 0
    while i < lines.count {
        let line = lines[i]
        let trimmed = trim(line)
        if trimmed.hasPrefix("```") {
            flush()
            var code: [String] = []
            i += 1
            while i < lines.count && !trim(lines[i]).hasPrefix("```") { code.append(lines[i]); i += 1 }
            blocks.append(.code(code.joined(separator: "\n")))
        } else if trimmed.isEmpty {
            flush()
        } else if trimmed == "---" || trimmed == "***" {
            flush(); blocks.append(.rule)
        } else if let m = groups(headingPattern, trimmed) {
            flush()
            blocks.append(.heading(level: m[1].count, text: m[2]))
        } else if trimmed.hasPrefix("|") && i + 1 < lines.count && groups(tableDivider, trim(lines[i + 1])) != nil {
            flush()
            var rows = [cells(trimmed)]
            i += 2
            while i < lines.count && trim(lines[i]).hasPrefix("|") { rows.append(cells(trim(lines[i]))); i += 1 }
            blocks.append(.table(rows))
            continue
        } else if let m = groups(bulletPattern, line) {
            flush()
            let marker = m[2].first?.isNumber == true ? m[2] : "•"
            blocks.append(.bullet(marker: marker, text: m[3], depth: m[1].count / 2))
        } else if trimmed.hasPrefix(">") {
            flush(); blocks.append(.quote(trim(String(trimmed.dropFirst()))))
        } else {
            paragraph.append(line)
        }
        i += 1
    }
    flush()
    return blocks
}

private func cells(_ row: String) -> [String] {
    row.trimmingCharacters(in: CharacterSet(charactersIn: "|")).components(separatedBy: "|").map(trim)
}

/// Inline `**bold**`, `*italic*` / `_italic_` and `` `code` ``; unmatched markers stay literal.
public func parseInline(_ text: String) -> [Span] {
    var spans: [Span] = []
    var plain = ""
    func flush() {
        if !plain.isEmpty { spans.append(Span(plain)) }
        plain = ""
    }
    let chars = Array(text)
    func find(_ mark: [Character], from: Int) -> Int? {
        var j = from
        while j + mark.count <= chars.count {
            if Array(chars[j..<j + mark.count]) == mark { return j }
            j += 1
        }
        return nil
    }
    var i = 0
    while i < chars.count {
        var match: (Span, Int)? = nil
        let c = chars[i]
        if c == "`" {
            if let end = find(["`"], from: i + 1), end > i + 1 { match = (Span(String(chars[i + 1..<end]), code: true), end + 1 - i) }
        } else if c == "*" && i + 1 < chars.count && chars[i + 1] == "*" {
            if let end = find(["*", "*"], from: i + 2), end > i + 2 { match = (Span(String(chars[i + 2..<end]), bold: true), end + 2 - i) }
        } else if c == "*" || c == "_" {
            if let end = find([c], from: i + 1), end > i + 1, !chars[i + 1].isWhitespace {
                match = (Span(String(chars[i + 1..<end]), italic: true), end + 1 - i)
            }
        }
        if let (span, length) = match {
            flush()
            spans.append(span)
            i += length
        } else {
            plain.append(c)
            i += 1
        }
    }
    flush()
    return spans
}

/// Rendered text plus style ranges; one document is one message's selection boundary.
public struct MessageDocument: Hashable, Sendable {
    public var text: String
    public var marks: [MessageMark]
}

/// Ranges are UTF-16 offsets so they map directly onto `NSAttributedString`.
public struct MessageMark: Hashable, Sendable {
    public var start: Int
    public var end: Int
    public var kind: String
    public var value: String = ""
}

public func messageDocument(_ source: String, markdown: Bool) -> MessageDocument {
    if !markdown { return MessageDocument(text: source, marks: []) }
    var text = ""
    var length = 0
    var marks: [MessageMark] = []
    func append(_ s: String) { text += s; length += s.utf16.count }
    func mark(_ start: Int, _ kind: String, _ value: String = "") {
        if length > start { marks.append(MessageMark(start: start, end: length, kind: kind, value: value)) }
    }
    func inline(_ value: String) {
        for span in parseInline(value) {
            let start = length
            if span.code {
                append(span.text)
            } else {
                let ns = span.text as NSString
                var offset = 0
                for link in linkPattern.matches(in: span.text, range: NSRange(location: 0, length: ns.length)) {
                    append(ns.substring(with: NSRange(location: offset, length: link.range.location - offset)))
                    let linkStart = length
                    append(ns.substring(with: link.range(at: 1)))
                    mark(linkStart, "link", ns.substring(with: link.range(at: 2)))
                    offset = link.range.location + link.range.length
                }
                append(ns.substring(from: offset))
            }
            if span.bold { mark(start, "bold") }
            if span.italic { mark(start, "italic") }
            if span.code { mark(start, "code") }
        }
    }
    for (index, block) in parseMarkdown(source).enumerated() {
        if index > 0 { append("\n\n") }
        let start = length
        switch block {
        case .heading(let level, let value): inline(value); mark(start, "heading", String(level))
        case .paragraph(let value): inline(value)
        case .bullet(let marker, let value, let depth):
            append(String(repeating: "  ", count: depth) + marker + " ")
            inline(value)
        case .quote(let value): inline(value); mark(start, "quote")
        // Never parse inline marks, trim, or replace spaces inside a fenced code block.
        case .code(let value): append(value); mark(start, "code")
        case .table(let rows):
            for (rowIndex, row) in rows.enumerated() {
                if rowIndex > 0 { append("\n") }
                let rowStart = length
                for (cellIndex, cell) in row.enumerated() {
                    if cellIndex > 0 { append("  |  ") }
                    inline(cell)
                }
                if rowIndex == 0 { mark(rowStart, "bold") }
            }
        case .rule: append("────────")
        }
    }
    return MessageDocument(text: text, marks: marks)
}
