package dev.pibot.android.domain

/** Keep aligned with packages/markdown/src/syntax.ts and its shared routing fixtures. */
fun containsMath(source: String): Boolean {
    val text = source.replace(Regex("```[\\s\\S]*?(?:```|$)|~~~[\\s\\S]*?(?:~~~|$)"), "")
        .replace(Regex("(`+)[\\s\\S]*?\\1"), "")
    fun escaped(at: Int): Boolean { var i = at - 1; var n = 0; while (i >= 0 && text[i--] == '\\') n++; return n % 2 == 1 }
    for (i in text.indices) {
        if (escaped(i)) continue
        if (text.startsWith("\\(", i) || text.startsWith("\\[", i) || text.startsWith("$$", i)) return true
        if (text[i] != '$') continue
        val next = text.getOrNull(i + 1) ?: continue
        if (next.isWhitespace() || next == '$') continue
        if (!next.isDigit()) return true
        var j = i + 1
        while (j < minOf(text.length, i + 16385) && text[j] != '\n') {
            if (text[j] == '$' && !escaped(j) && j > i + 1 && !text[j - 1].isWhitespace() && text.getOrNull(j + 1)?.isDigit() != true) return true
            j++
        }
    }
    return false
}
