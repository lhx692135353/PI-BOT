import React from "react";
import { createRoot } from "react-dom/client";
import { Markdown } from "@pi-bot/markdown/react";
import "@pi-bot/markdown/styles";

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
  const mime = response.headers.get('content-type') ?? 'text/markdown';
  const blob = await response.blob();
  document.title = decodeURIComponent(
    response.headers.get("x-report-title") ?? "报告",
  );
  document.querySelector("header strong")!.textContent = document.title;
  const download = document.getElementById("download") as HTMLAnchorElement;
  download.href = URL.createObjectURL(
    blob,
  );
  download.download = decodeURIComponent(response.headers.get("x-report-name") ?? `${id}.md`);
  download.textContent = "下载文件";
  if (["image/png", "image/jpeg", "image/webp"].includes(mime.split(";")[0].trim())) {
    const image = document.createElement("img");
    image.alt = document.title; image.src = download.href;
    image.style.cssText = "display:block;max-width:100%;height:auto;margin:auto;border-radius:12px";
    target.replaceChildren(image);
  } else if (mime.startsWith('application/pdf')) {
    const frame=document.createElement('iframe'); frame.title=document.title;frame.src=download.href;frame.style.cssText='width:100%;height:80vh;border:0';target.append(frame);
  } else if (!mime.startsWith('text/')) {
    target.textContent='文件已就绪，请点击下载，使用适合此文件的应用打开。';
  } else {
  const text = await blob.text();
  createRoot(target).render(
    <Markdown source={text}/>,
  );
  }
} catch (error) {
  target.textContent =
    error instanceof Error ? error.message : "报告暂时无法打开。";
}
