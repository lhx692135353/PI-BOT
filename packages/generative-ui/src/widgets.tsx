import React, { useEffect, useLayoutEffect, useId, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { defaultGenerativeUILibrary } from '@assistant-ui/generative-ui/react';
import { renderMermaidSVG } from 'beautiful-mermaid';
import * as L from 'leaflet';
import './leaflet.css';
import { renderMarkdown } from '@pi-bot/markdown';
import { Markdown as SharedMarkdown } from '@pi-bot/markdown/react';
import '@pi-bot/markdown/styles';
import { classifyTemporal, fromLocalDateTime, getTemporalInputStep, normalizeTemporalInputValue, toPickerLocalDateTime } from './temporal.js';

export async function safeMarkdown(value: string) { return renderMarkdown(value); }
function Markdown({value,host}:{value:string;host?:MediaHost}) {
  return <div data-aui="markdown"><SharedMarkdown source={value} host={{copy:host?.copy,openLink:href=>{if(host?.openExternal)void host.openExternal(href);else window.open(href,'_blank','noopener,noreferrer');}}}/></div>;
}

export interface MediaHost {
  copy?(text:string):void|Promise<void>;
  image(id: string, variant?: 'thumbnail' | 'original'): Promise<string>;
  open(id: string): Promise<void>;
  preview?(id: string): Promise<void>;
  openExternal?(url: string): void | Promise<void>;
  displayed?(ids: string[], remove?: boolean): void;
}
export function ArtifactImage({ id, alt, host, onLoad, caption = true }: { id: string; alt: string; host?: MediaHost; onLoad?(): void; caption?: boolean }) {
  const [source,setSource]=useState(''),[error,setError]=useState(''),[attempt,retry]=useState(0),[expanded,expand]=useState(false),[original,setOriginal]=useState('');
  const figure=useRef<HTMLElement>(null),picture=useRef<HTMLImageElement>(null);
  const visibility=useRef({loaded:false,reported:false});
  const callbacks=useRef({host,onLoad});callbacks.current={host,onLoad};
  const syncVisibility=()=>{
    const rect=picture.current?.getClientRects()[0];
    const visible=!!callbacks.current.onLoad && visibility.current.loaded && !!rect && rect.width>0 && rect.height>0;
    if(visible===visibility.current.reported)return;
    visibility.current.reported=visible;
    if(visible)callbacks.current.onLoad?.();else callbacks.current.host?.displayed?.([id],true);
  };
  useLayoutEffect(()=>{
    visibility.current.loaded=false;
    const observer=new ResizeObserver(syncVisibility);
    if(figure.current)observer.observe(figure.current);
    return()=>{
      observer.disconnect();
      if(visibility.current.reported){visibility.current.reported=false;callbacks.current.host?.displayed?.([id],true);}
      visibility.current.loaded=false;
    };
  },[id,source]);
  useEffect(()=>{
    let active=true;setSource('');setError('');setOriginal('');
    if(host)void host.image(id).then(value=>{if(active)setSource(value);}).catch(()=>{if(active)setError('图片加载失败，点击重试');});
    else setError('图片预览暂不可用');
    return()=>{active=false;};
  },[id,host?.image,attempt]);
  useEffect(()=>{
    if(!expanded)return;let active=true;
    void host?.image(id,'original').then(value=>{if(active)setOriginal(value);}).catch(()=>{});
    const close=(event:KeyboardEvent)=>{if(event.key==='Escape')expand(false);};
    window.addEventListener('keydown',close);return()=>{active=false;window.removeEventListener('keydown',close);};
  },[expanded,id,host?.image]);
  return <figure ref={figure} className="pi-artifact-image">
    {source?<button type="button" className="pi-image-preview" aria-label={`放大 ${alt}`} onClick={()=>{if(host?.preview)void host.preview(id).catch(()=>setError('无法打开原图，请重试'));else expand(true);}}>
      <img ref={picture} src={source} alt={alt} onLoad={()=>{visibility.current.loaded=true;syncVisibility();}} onError={()=>{visibility.current.loaded=false;syncVisibility();setSource('');setError('图片加载失败，点击重试');}}/>
    </button>:<button type="button" onClick={()=>retry(n=>n+1)} disabled={!error}>{error||'图片加载中…'}</button>}
    <figcaption>{caption&&<span>{alt}</span>}<button type="button" onClick={()=>void host?.open(id).catch(()=>setError('无法打开文件，请重试'))}>下载 / 打开原图</button></figcaption>
    {error&&source&&<span role="alert">{error}</span>}
    {expanded&&createPortal(<div className="pi-image-backdrop" role="dialog" aria-modal="true" aria-label={alt} onClick={()=>expand(false)}><button type="button" autoFocus aria-label="关闭图片" onClick={()=>expand(false)}>×</button><img src={original||source} alt={alt}/></div>,document.body)}
  </figure>;
}

function Diagram({ code, title }: {code: string; title?: string}) {
  const theme=()=>document.documentElement.dataset.theme==='dark'||document.documentElement.dataset.theme!=='light'&&window.matchMedia('(prefers-color-scheme: dark)').matches;
  const [dark,setDark]=useState(theme);
  useEffect(()=>{
    const media=window.matchMedia('(prefers-color-scheme: dark)'), update=()=>setDark(theme());
    const observer=new MutationObserver(update);observer.observe(document.documentElement,{attributes:true,attributeFilter:['data-theme']});
    media.addEventListener('change',update);return()=>{media.removeEventListener('change',update);observer.disconnect();};
  },[]);
  const source = useMemo(() => { try { return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderMermaidSVG(code, { bg:dark?'#202127':'#ffffff', fg:dark?'#efeff1':'#292929', transparent:true }))}`; } catch { return ''; } }, [code,dark]);
  return <figure data-aui="diagram">{source ? <img src={source} alt={title || '流程图'} /> : <pre role="status">流程图暂无法绘制：{code}</pre>}{title && <figcaption>{title}</figcaption>}</figure>;
}
function GeoMap({ places = [], route }: { places?: {label: string; lat: number; lng: number; detail?: string}[]; route?: boolean }) {
  const target = useRef<HTMLDivElement>(null), [failed, setFailed] = useState(false);
  const signature = JSON.stringify([places, route]);
  useEffect(() => {
    if (!target.current) return;
    const valid = places.filter(p => Number.isFinite(p.lat) && Math.abs(p.lat)<=90 && Number.isFinite(p.lng) && Math.abs(p.lng)<=180);
    const map = L.map(target.current, { attributionControl:true }).setView([0,0], 2);
    let errors = 0; setFailed(false);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap contributors', maxZoom:19 }).on('tileerror',()=>{if(++errors>=3)setFailed(true);}).on('tileload',()=>setFailed(false)).addTo(map);
    for (const place of valid) {
      const label=document.createElement('span');label.textContent=place.label;
      L.marker([place.lat, place.lng], {title:place.label,icon:L.divIcon({className:'pi-map-marker',html:'',iconSize:[12,12]})}).addTo(map).bindTooltip(label);
    }
    if (valid.length===1) map.setView([valid[0].lat,valid[0].lng],12);
    else if (valid.length>1) map.fitBounds(L.latLngBounds(valid.map(p=>[p.lat,p.lng])),{padding:[20,20]});
    if(route && valid.length>1)L.polyline(valid.map(p=>[p.lat,p.lng] as L.LatLngTuple),{color:'#ff7a2f'}).addTo(map);
    const observer = new ResizeObserver(()=>map.invalidateSize()); observer.observe(target.current);
    return () => {observer.disconnect();map.remove();};
  }, [signature]);
  return <section data-aui="map"><div ref={target} className="pi-geo-map" aria-label="地点地图" />{failed && <p role="status">地图加载失败，地点仍可查看</p>}<ol>{places.map((p,i)=><li key={i}>{p.label}{p.detail && ` · ${p.detail}`}</li>)}</ol></section>;
}

export const CONTROL_KEYS: Record<string,string> = {Input:'defaultValue',Select:'defaultValue',Checkbox:'defaultChecked',Slider:'defaultValue',DatePicker:'value',RadioGroup:'defaultValue',CheckboxGroup:'defaultValue'};
function DateField({props:p,change,fire}:{props:Record<string,any>;change(value:unknown):void;fire():void}) {
  const value=String(p.value??''),mode=p.inputType??'date',kind=classifyTemporal(value).kind;
  const compatible=value===''||(mode==='datetime'?kind==='instant'||kind==='floating':kind===mode);
  const nativeType=compatible?(mode==='datetime'?'datetime-local':mode):'text';
  const selection=useRef({anchor:value,written:value,committed:value,keyboard:false});
  useEffect(()=>{if(value!==selection.current.written){selection.current.anchor=value;selection.current.committed=value;}selection.current.written=value;},[value]);
  const display=compatible?(mode==='datetime'?toPickerLocalDateTime(value):normalizeTemporalInputValue(value)):value;
  const bound=(raw:string|undefined,maximum=false)=>{
    if(raw===undefined||!compatible)return undefined;
    const type=classifyTemporal(raw).kind;
    if(mode==='datetime'){
      if(type==='date')return raw+(maximum?'T23:59:59.999':'T00:00');
      return type==='instant'||type==='floating'?toPickerLocalDateTime(raw):undefined;
    }
    return type===mode?normalizeTemporalInputValue(raw):undefined;
  };
  const commit=(next=value)=>{if(next!==selection.current.committed){selection.current.committed=next;fire();}};
  return <label data-aui="control"><span>{p.label??p.name??'日期'}</span><input data-aui="input" aria-label={p.label??p.name??'日期'} name={p.name} type={nativeType} value={display} required={p.required}
    min={bound(p.min)} max={bound(p.max,true)} step={compatible&&mode!=='date'?getTemporalInputStep(selection.current.anchor,display,p.min,p.max):undefined}
    onPointerDown={()=>{selection.current.keyboard=false;}}
    onChange={event=>{
      const raw=event.target.value,next=compatible&&mode==='datetime'?fromLocalDateTime(normalizeTemporalInputValue(raw),selection.current.anchor):raw;
      selection.current.written=next;change(next);
      if(!selection.current.keyboard)commit(next);
    }}
    onBlur={()=>{selection.current.keyboard=false;commit();}}
    onKeyDown={event=>{
      selection.current.keyboard=true;
      if(event.key==='Enter'&&!event.nativeEvent.isComposing&&!event.currentTarget.form){event.preventDefault();selection.current.keyboard=false;commit();}
    }}/></label>;
}
function Control({type,props:p,change,fire}:{type:string;props:Record<string,any>;change(value:unknown):void;fire():void}) {
  const generated = useId(), id=`aui-${generated}`, value=p[CONTROL_KEYS[type]], options=p.options ?? [];
  const label = p.label ?? p.name ?? '输入';
  const update = (v:unknown, commit=true) => {change(v);if(commit)fire();};
  if(type==='RadioGroup'||type==='CheckboxGroup') return <fieldset data-aui={type==='RadioGroup'?'radio-group':'checkbox-group'}><legend>{label}</legend>{options.map((o:any)=><label key={o.value}><input type={type==='RadioGroup'?'radio':'checkbox'} name={id} checked={type==='RadioGroup'?value===o.value:(value??[]).includes(o.value)} onChange={e=>update(type==='RadioGroup'?o.value:e.target.checked?[...(value??[]),o.value]:(value??[]).filter((v:string)=>v!==o.value))}/><span>{o.label}{o.description&&<small>{o.description}</small>}</span></label>)}{p.progress&&<progress value={(value??[]).length} max={options.length}/>}</fieldset>;
  if(type==='Checkbox') return <label data-aui="checkbox" data-aui-variant={p.variant}><input id={id} type="checkbox" checked={!!value} required={p.required} onChange={e=>update(e.target.checked)}/><span>{label}</span></label>;
  if(type==='Select') return <label data-aui="control"><span>{label}</span><select id={id} name={p.name} data-aui="select" value={value??''} required={p.required} onChange={e=>update(e.target.value)}><option value="">{p.placeholder??'请选择'}</option>{options.map((o:any)=><option key={o.value} value={o.value}>{o.label}</option>)}</select></label>;
  if(type==='Slider') return <label data-aui="slider-field"><span data-aui="slider-label">{label} · {value}{p.unit}</span><input id={id} name={p.name} data-aui="slider" type="range" value={value??p.min} min={p.min} max={p.max} step={p.step??1} onChange={e=>update(Number(e.target.value),false)} onPointerUp={fire} onKeyUp={fire}/></label>;
  const attrs = {id,name:p.name,value:value??'',required:p.required,'aria-label':label,onChange:(e:React.ChangeEvent<HTMLInputElement|HTMLTextAreaElement>)=>update(e.target.value,false)};
  return <label data-aui="control"><span>{label}</span>{type==='Input'&&p.multiline&&p.inputType!=='number' ? <textarea {...attrs} data-aui="input" placeholder={p.placeholder} minLength={p.minLength} maxLength={p.maxLength}/>:<input {...attrs} data-aui="input" type={p.inputType??'text'} step={p.inputType==='number'?'any':undefined} placeholder={p.placeholder} min={p.min} max={p.max} minLength={p.minLength} maxLength={p.maxLength} onKeyDown={e=>{if(e.key==='Enter'&&!e.nativeEvent.isComposing&&e.nativeEvent.keyCode!==229&&!e.currentTarget.form){e.preventDefault();fire();}}}/>}</label>;
}

/** Each render function gets its own React fiber; upstream components may use hooks. */
function LibraryWidget({type,props,children}:{type:string;props:Record<string,any>;children?:React.ReactNode}) {
  return defaultGenerativeUILibrary[type].render({...props,children,$status:'done'});
}
export function Widget({ type, props, children, change, fire, host }: {type:string;props:Record<string,any>;children?:React.ReactNode;change(value:unknown):void;fire(slot?:'confirm'|'cancel'):void;host?:MediaHost}) {
  if(type==='Markdown')return <Markdown value={props.value} host={host}/>;
  if(type==='DatePicker')return <DateField props={props} change={change} fire={()=>fire()}/>;
  if(CONTROL_KEYS[type])return <Control type={type} props={props} change={change} fire={()=>fire()}/>;
  if(type==='Image'&&props.artifact_id)return <ArtifactImage id={props.artifact_id} alt={props.alt} caption={false} host={host} onLoad={()=>host?.displayed?.([props.artifact_id])}/>;
  if(type==='Image'&&!/^data:image\/(png|jpeg|webp|gif);base64,/.test(props.src??''))return <span>{props.alt}</span>;
  if(type==='Diagram')return <Diagram code={props.code} title={props.title}/>;
  if(type==='Map')return <GeoMap places={props.places} route={props.route}/>;
  if(type==='Table')return <div className="pi-ui-table-scroll" role="region" aria-label="数据表格，可横向滚动" tabIndex={0} style={{'--pi-table-columns':Math.max(1,props.columns?.length??0)} as React.CSSProperties}><LibraryWidget type={type} props={props}/></div>;
  const adapted: Record<string,any> = {...props, $action:props.action ? {type:'event'}:undefined, $dispatch:()=>fire()};
  for(const slot of ['confirm','cancel'] as const)if(props[slot])adapted[slot]={...props[slot],_action:{type:slot}};
  adapted.$dispatch = (action?:any)=>fire(action?.type==='confirm'?'confirm':action?.type==='cancel'?'cancel':undefined);
  return <LibraryWidget type={type} props={adapted}>{children}</LibraryWidget>;
}
