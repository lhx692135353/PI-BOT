import { Markdown } from "@pi-bot/markdown/react";
import "@pi-bot/markdown/styles";

interface MarkdownPayload { source:string; fontSize:number; color:string }

import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { UiView } from "../src/renderer.js";
import { validateUiDocument, type UiDocument } from "../src/index.js";
import "../src/style.css";
import "./style.css";
import { observeUiHeight } from './height.js';
import { canScrollAt } from './gestures.js';
declare global {
  interface Window {
    PiBotUiHost?: { postMessage(value: string): void };
    piBotUi: {
      canScrollAt(x: number, y: number): boolean;
      receive(value: { document?: UiDocument; disabled?: boolean; markdown?: MarkdownPayload }): void;
      respond(value: { id: string; result?: unknown; error?: string }): void;
    };
  }
}
const pending = new Map<
  string,
  {
    resolve: (v: any) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }
>();
const post = (value: unknown) =>
  window.PiBotUiHost?.postMessage(JSON.stringify(value));
function request(type: string, payload: unknown): Promise<any> {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6]=(bytes[6]&15)|64;bytes[8]=(bytes[8]&63)|128;
  const hex=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  const id = `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error("连接超时，请重试"));
    }, 20_000);
    pending.set(id, { resolve, reject, timer });
    post({ type, id, payload });
  });
}
let initial: { document?: UiDocument; disabled?: boolean; markdown?: MarkdownPayload } | null = null;
let receive: (v: { document?: UiDocument; disabled?: boolean; markdown?: MarkdownPayload }) => void = (v) => {
  initial = v;
};
window.piBotUi = {
  canScrollAt,
  receive: (v) => receive(v),
  respond: (v) => {
    const p = pending.get(v.id);
    if (!p) return;
    clearTimeout(p.timer);
    pending.delete(v.id);
    if (v.error) p.reject(new Error(v.error));
    else p.resolve(v.result);
  },
};
const media = { copy:(text:string)=>request('copy',{text}).then(()=>{}), image: (id:string,variant:'thumbnail'|'original'='thumbnail')=>request('image',{id,variant}), open:(id:string)=>request('open',{id}), preview:(id:string)=>request('open',{id}), openExternal:(url:string)=>request('external',{url}), displayed:(ids:string[],remove=false)=>post({type:'displayed',ids,remove}) };
function App() {
  const [value, setValue] = useState<{
    document?: UiDocument;
    disabled?: boolean;
    markdown?: MarkdownPayload;
  } | null>(initial);
  const [error, setError] = useState("");
  receive = (v) => {
    try {
      setValue(v.markdown ? v : { ...v, document: validateUiDocument(v.document) });
      setError("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "界面无法显示");
      media.displayed([]);
    }
  };
  return error ? (
    <p role="alert">{error}</p>
  ) : value?.markdown ? (
    <div style={{fontSize:value.markdown.fontSize,color:value.markdown.color}}><Markdown source={value.markdown.source} host={{copy:media.copy,openLink:url=>{void media.openExternal(url);},selection:active=>post({type:"selection",active})}}/></div>
  ) : value?.document ? (
    <UiView
      document={value.document}
      disabled={value.disabled}
      save={(states, revision) => request("state", { states, revision })}
      action={(input) => request("action", input)}
      media={media}
    />
  ) : (
    <p className="loading">正在加载交互工具…</p>
  );
}
createRoot(document.getElementById("pi-bot-ui-root")!).render(<App />);
observeUiHeight(document.getElementById("pi-bot-ui-root")!, post);
post({ type: "ready" });
