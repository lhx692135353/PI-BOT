import Foundation

/// Keep aligned with the shared Markdown routing fixtures; no math is rendered natively.
public func containsMath(_ source: String) -> Bool {
    func replacing(_ pattern: String, _ value: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return value }
        return regex.stringByReplacingMatches(in: value, range: NSRange(value.startIndex..., in: value), withTemplate: "")
    }
    let text = Array(replacing(#"(`+)[\s\S]*?\1"#, replacing(#"```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)"#, source)))
    func escaped(_ at: Int) -> Bool { var i = at - 1, n = 0; while i >= 0 && text[i] == "\\" { n += 1; i -= 1 }; return n % 2 == 1 }
    for i in text.indices {
        if escaped(i) { continue }
        if i + 1 < text.count && ((text[i] == "\\" && (text[i+1] == "(" || text[i+1] == "[")) || (text[i] == "$" && text[i+1] == "$")) { return true }
        guard text[i] == "$", i + 1 < text.count else { continue }
        let next = text[i+1]
        if next.isWhitespace || next == "$" { continue }
        if !next.isNumber { return true }
        var j = i + 1
        while j < min(text.count, i + 16385) && text[j] != "\n" {
            if text[j] == "$" && !escaped(j) && j > i+1 && !text[j-1].isWhitespace && (j+1 == text.count || !text[j+1].isNumber) { return true }
            j += 1
        }
    }
    return false
}
