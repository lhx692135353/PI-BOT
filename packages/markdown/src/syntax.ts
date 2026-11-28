export interface MathToken { start: number; end: number; tex: string; display: boolean; raw: string }
const escaped = (s: string, at: number) => { let n=0; while(at>0 && s[--at]==="\\") n++; return n%2===1; };
export function mathAt(source: string, start: number): MathToken | null {
  if (escaped(source,start)) return null;
  const open = ["$$", "\\[", "\\(", "$"].find(s=>source.startsWith(s,start));
  if (!open) return null;
  const close = open==="\\[" ? "\\]" : open==="\\(" ? "\\)" : open;
  const display = open==="$$" || open==="\\[", bodyStart=start+open.length;
  if (open==="$" && (!source[bodyStart] || /\s|\$/.test(source[bodyStart]))) return null;
  for(let i=bodyStart;i<Math.min(source.length,bodyStart+16384);i++) {
    if(open==="$" && source[i]==="\n") return null;
    if(!source.startsWith(close,i) || escaped(source,i)) continue;
    if(open==="$" && (/\s/.test(source[i-1]) || /\d/.test(source[i+1]??""))) continue;
    const tex=source.slice(bodyStart,i).trim();
    return tex ? {start,end:i+close.length,tex,display,raw:source.slice(start,i+close.length)} : null;
  }
  return null;
}
/** Shared detection fixtures also exercise the small native routing scanners. */
export function containsMath(source: string) {
  const text=source.replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g,"").replace(/(`+)[\s\S]*?\1/g,"");
  for(let i=0;i<text.length;i++) {
    if(mathAt(text,i)) return true;
    if(escaped(text,i)) continue;
    if(text.startsWith("\\(",i)||text.startsWith("\\[",i)||text.startsWith("$$",i)) return true;
    if(text[i]==="$" && /[^\s\d$]/.test(text[i+1]??" ")) return true;
  }
  return false;
}
