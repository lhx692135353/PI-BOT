# 数学与化学公式

桌面、Android、iOS 的助手 Markdown 消息、报告、任务/文件展示及 Generative UI 使用共享数学渲染模块。KaTeX、mhchem、样式和字体随应用打包，不需要 CDN。

支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。单美元行内公式不跨行；代码块、行内代码、转义美元符号以及普通金额保持原样。没有闭合的公式继续显示源码，闭合后排版；不支持的命令局部回退，不清空回复。

示例：`$t_3$`、`$30\text{ g}$`、`$t_3\,{}^\circ\mathrm{C}$`、`$\ce{H2SO4}$`、`$\ce{SO4^2-}$`、`$$\ce{CaCO3 ->[\Delta] CaO + CO2 ^}$$`。mhchem 也提供 `\pu` 单位语法。复杂结构式或实验装置图需要独立图片工具。

移动端仅在 Markdown 消息包含公式候选时切换到本地 WebView/WKWebView，普通消息保留原生文本。选择文字时暂缓内容更新，释放选区后应用最新内容。复制选区会把其中公式转换回 TeX，避免隐藏的 MathML 重复进入剪贴板；公式旁的复制按钮可单独复制原公式。长公式可以横向滚动。

共享路由样例在 `packages/markdown/fixtures/routing.json`，由 TypeScript、Android 和 PiBotKit 测试读取。浏览器测试验证数学/化学排版、本地字体、复制、选区冻结、窄屏横向滚动与原生桥接。debug 包可通过 Android `math_smoke=true` extra 或 iOS `--math-smoke` 启动专用测试页；结果只写入该测试应用自己的数据目录，release 包没有此入口。iOS CI 在模拟器实际启动 WKWebView 并检查渲染、字体、选择复制、剪贴板与高度。
