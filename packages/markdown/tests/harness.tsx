import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "../src/react.js";
import "../src/style.css";

const source=String.raw`# 溶解度与化学公式

位于 $t_3$ 时，溶解度为 **$30\text{ g}$**，温度写为 $t_3\,{}^\circ\mathrm{C}$。

$$\frac{30\text{ g}}{100\text{ g}+30\text{ g}}\times100\%\approx23.1\%$$

$\ce{H2SO4}$，$\ce{SO4^2-}$

$$\ce{2H2 + O2 -> 2H2O}$$

$$\ce{CaCO3 ->[\Delta] CaO + CO2 ^}$$

价格 $5 和 $10；代码：

`+"`$x_1$`"+String.raw`

| 条件 | 数值 |
| --- | --- |
| 质量 | $30\text{ g}$ |
`;
function App(){const[value,setValue]=useState(source);(window as any).setMarkdown=setValue;return <Markdown source={value}/>;}
createRoot(document.getElementById("root")!).render(<App/>);
