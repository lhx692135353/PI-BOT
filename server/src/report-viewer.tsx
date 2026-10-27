import React from "react";
import { createRoot } from "react-dom/client";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

const target = document.getElementById("content")!;
const id = location.pathname.split("/").at(-1)!;
const ticket = new URLSearchParams(location.hash.slice(1)).get("token");
history.replaceState(null, "", location.pathname);
try {
  const response = await fetch(
    `../${id}/content?ticket=${encodeURIComponent(ticket ?? "")}`,
    { cache: "no-store", referrerPolicy: "no-referrer" },
  );
  if (!response.ok)
    throw new Error(
      response.status === 401
        ? "访问已过期，请从聊天卡片重新打开。"
        : "报告暂时无法打开。",
    );
  const text = await response.text();
  document.title = decodeURIComponent(
    response.headers.get("x-report-title") ?? "报告",
  );
  document.querySelector("header strong")!.textContent = document.title;
  const download = document.getElementById("download") as HTMLAnchorElement;
  download.href = URL.createObjectURL(
    new Blob([text], { type: "text/markdown;charset=utf-8" }),
  );
  download.download = response.headers.get("x-report-name") ?? `${id}.md`;
  createRoot(target).render(
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      skipHtml
      components={{
        a: (props) => (
          <a {...props} target="_blank" rel="noopener noreferrer" />
        ),
      }}
    >
      {text}
    </ReactMarkdown>,
  );
} catch (error) {
  target.textContent =
    error instanceof Error ? error.message : "报告暂时无法打开。";
}
