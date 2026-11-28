import { useEffect, useState, type FormEvent } from "react";
import { api, type ImageGenerationSettings } from "./api.js";

const MODELS = ["grok-imagine-image-2.0", "gpt-image-2.6-sunburst", "gemini-3.1-flash-image"];

export function ImageGenerationPage() {
  const [form, setForm] = useState<ImageGenerationSettings | null>(null);
  const [key, setKey] = useState("");
  const [error, setError] = useState("");
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    let active = true;
    api.imageGeneration().then(value => { if (active) setForm(value); }, error => { if (active) setError(error.message); });
    return () => { active = false; };
  }, []);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!form) return;
    setSaving(true); setError(""); setSaved(false);
    try {
      const { configured: _configured, ...body } = form;
      setForm(await api.saveImageGeneration({ ...body, ...(key.trim() ? { api_key: key.trim() } : {}) }));
      setKey(""); setSaved(true);
    } catch (error) { setError(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  };
  if (!form) return <p className={error ? "error" : "muted"}>{error || "正在加载生图配置…"}</p>;
  return <form className="form" onSubmit={submit} style={{ maxWidth: 720 }}>
    <h2>图片生成</h2>
    <p className="muted">让 Bot 生成或修改图片，结果作为聊天附件保存。原图标注和裁剪不依赖模型配置。</p>
    <fieldset disabled={saving} style={{ border: 0, padding: 0, margin: 0, display: "grid", gap: 18 }}>
      <label className="check"><input type="checkbox" checked={form.enabled} onChange={event => { setForm({ ...form, enabled: event.target.checked }); setSaved(false); }} />启用生图</label>
      <label>CLIProxy 地址
        <input type="url" value={form.base_url} placeholder="https://proxy.example.com/v1" required={form.enabled}
          onChange={event => { setForm({ ...form, base_url: event.target.value }); setSaved(false); }} />
      </label>
      <label>API Key{form.configured ? "（已配置，留空保持不变）" : ""}
        <input type="password" autoComplete="off" value={key} required={form.enabled && !form.configured}
          onChange={event => { setKey(event.target.value); setSaved(false); }} />
      </label>
      <div>
        <p>可用模型</p>
        {MODELS.map(model => <label key={model} className="check" style={{ marginTop: 10 }}>
          <input type="checkbox" aria-label={model} checked={form.models.includes(model)} onChange={event => {
            const models = event.target.checked ? [...form.models, model] : form.models.filter(value => value !== model);
            setForm({ ...form, models, default_model: models.includes(form.default_model) ? form.default_model : models[0] ?? "" });
            setSaved(false);
          }} />{model}<span className="muted small">{model === "gpt-image-2.6-sunburst" ? " · 生成 / 编辑 / 蒙版" : " · 生成 / 编辑"}</span>
        </label>)}
      </div>
      <label>默认模型
        <select value={form.default_model} onChange={event => { setForm({ ...form, default_model: event.target.value }); setSaved(false); }}>
          {form.models.map(model => <option key={model} value={model}>{model}</option>)}
        </select>
      </label>
      <p className="muted small">密钥加密保存在服务端。未指定模型时使用默认模型；生成可能产生费用，失败或超时不会自动重新生成。</p>
      {error && <p className="error" role="alert">{error}</p>}
      {saved && <p role="status">配置已保存</p>}
      <footer><button className="primary" disabled={!form.models.length || !form.models.includes(form.default_model)}>{saving ? "保存中…" : "保存配置"}</button></footer>
    </fieldset>
  </form>;
}
