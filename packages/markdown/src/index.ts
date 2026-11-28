import MarkdownIt from "markdown-it";
import katex from "katex";
import "katex/contrib/mhchem";
import DOMPurify from "dompurify";
import { mathAt } from "./syntax.js";
export { containsMath, mathAt } from "./syntax.js";

const markdown = new MarkdownIt({ html: false, linkify: true, breaks: false });
const escape = markdown.utils.escapeHtml;
function formula(raw: string, tex: string, display: boolean) {
  let html: string;
  try {
    html = katex.renderToString(tex,{displayMode:display,throwOnError:true,trust:false,maxExpand:500,maxSize:20,output:"htmlAndMathml",strict:"ignore"});
  } catch { html=`<code class="pi-math-error">${escape(raw)}</code>`; }
  return `<span class="pi-math${display?" pi-math-block":""}" data-tex="${escape(raw)}" role="math" aria-label="${escape(tex)}"><span class="pi-math-content">${html}</span><button type="button" class="pi-math-copy" aria-label="复制公式" title="复制公式">⧉</button></span>`;
}
markdown.inline.ruler.before("escape","pi_math",(state,silent)=>{
  const token=mathAt(state.src,state.pos); if(!token || token.end>state.posMax) return false;
  if(!silent) { const t=state.push("pi_math","",0);t.content=token.tex;t.meta=token; }
  state.pos=token.end;return true;
});
markdown.renderer.rules.pi_math=(tokens,index)=>{const t=tokens[index].meta;return formula(t.raw,t.tex,t.display);};
markdown.block.ruler.before("fence","pi_math_block",(state,start,end,silent)=>{
  const at=state.bMarks[start]+state.tShift[start];
  if(!state.src.startsWith("$$",at)&&!state.src.startsWith("\\[",at))return false;
  const math=mathAt(state.src,at);if(!math || math.end>state.eMarks[end-1])return false;
  let line=start;while(line+1<end && state.bMarks[line+1]<math.end)line++;
  if(state.src.slice(math.end,state.eMarks[line]).trim())return false;
  if(silent)return true;
  const token=state.push("pi_math_block","",0);token.content=math.tex;token.meta=math;token.map=[start,line+1];state.line=line+1;return true;
},{alt:["paragraph","reference","blockquote","list"]});
markdown.renderer.rules.pi_math_block=(tokens,index)=>{const t=tokens[index].meta;return formula(t.raw,t.tex,true)+"\n";};

export function renderMarkdown(source: string) {
  // Raw model HTML is disabled; keep KaTeX's generated MathML and local CSS styles.
  const html=DOMPurify.sanitize(markdown.render(source),{ADD_ATTR:["aria-label","data-tex"],FORBID_TAGS:["script","iframe","object","embed","style"]});
  const document=new DOMParser().parseFromString(html,"text/html");
  for(const image of document.querySelectorAll("img"))if(!/^data:image\/(png|jpeg|webp|gif);base64,/.test(image.getAttribute("src")??""))image.replaceWith(document.createTextNode(image.alt));
  return document.body.innerHTML;
}
export interface MarkdownHost { copy?(text:string):void|Promise<void>; openLink?(href:string):void; selection?(active:boolean):void }
export function hasSelection(root:HTMLElement) {
  const selection=root.ownerDocument.getSelection();return !!selection && !selection.isCollapsed && !!selection.anchorNode && root.contains(selection.anchorNode);
}
export function bindMarkdown(root:HTMLElement,host:MarkdownHost={}) {
  const doc=root.ownerDocument;
  const click=(event:MouseEvent)=>{
    const target=event.target as Element;
    const button=target.closest(".pi-math-copy");
    if(button) { event.preventDefault();const text=button.closest<HTMLElement>("[data-tex]")?.dataset.tex??"";void (host.copy?host.copy(text):navigator.clipboard.writeText(text));return; }
    const link=target.closest<HTMLAnchorElement>("a[href]");if(link&&host.openLink){event.preventDefault();host.openLink(link.getAttribute("href")!);}
  };
  const copy=(event:ClipboardEvent)=>{
    const selection=doc.getSelection();if(!selection?.rangeCount||!hasSelection(root)||!event.clipboardData)return;
    const range=selection.getRangeAt(0).cloneRange();
    for(const node of root.querySelectorAll<HTMLElement>("[data-tex]"))if(range.intersectsNode(node)) {
      if(node.contains(range.startContainer))range.setStartBefore(node);
      if(node.contains(range.endContainer))range.setEndAfter(node);
    }
    const fragment=range.cloneContents();
    for(const math of fragment.querySelectorAll<HTMLElement>("[data-tex]"))math.replaceWith(doc.createTextNode(math.dataset.tex??""));
    for(const button of fragment.querySelectorAll(".pi-math-copy"))button.remove();
    const container=doc.createElement("div");container.append(fragment);container.style.whiteSpace="pre-wrap";
    event.clipboardData.setData("text/plain",container.textContent??"");event.preventDefault();
  };
  const selection=()=>host.selection?.(hasSelection(root));
  root.addEventListener("click",click);root.addEventListener("copy",copy);doc.addEventListener("selectionchange",selection);
  return ()=>{root.removeEventListener("click",click);root.removeEventListener("copy",copy);doc.removeEventListener("selectionchange",selection);};
}
