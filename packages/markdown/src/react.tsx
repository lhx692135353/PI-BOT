import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { bindMarkdown, hasSelection, renderMarkdown, type MarkdownHost } from "./index.js";

/** One selection surface; a live selection freezes updates until released. */
export function Markdown({source,className,host}:{source:string;className?:string;host?:MarkdownHost}) {
  const root=useRef<HTMLDivElement>(null), latest=useRef(source); latest.current=source;
  const [shown,setShown]=useState(source);
  const callbacks=useRef(host);callbacks.current=host;
  useEffect(()=>{if(root.current&&!hasSelection(root.current))setShown(source);},[source]);
  useLayoutEffect(()=>bindMarkdown(root.current!,{
    copy:text=>callbacks.current?.copy?callbacks.current.copy(text):navigator.clipboard.writeText(text),
    openLink:href=>callbacks.current?.openLink?callbacks.current.openLink(href):window.open(href,"_blank","noopener,noreferrer"),
    selection:active=>{callbacks.current?.selection?.(active);if(!active)setShown(latest.current);},
  }),[]);
  const html=useMemo(()=>renderMarkdown(shown),[shown]);
  return <div ref={root} className={`pi-markdown ${className??""}`} dangerouslySetInnerHTML={{__html:html}}/>;
}
