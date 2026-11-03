import { useEffect, useState } from 'react';
import { Icon } from './icons.js';

type Theme = 'light' | 'dark';
const key = 'pi-bot.theme';
const system = window.matchMedia('(prefers-color-scheme: dark)');
function storedTheme(): Theme | null {
  try { const value = localStorage.getItem(key); return value === 'light' || value === 'dark' ? value : null; }
  catch { return null; }
}
let preference = storedTheme();
let current: Theme = preference ?? (system.matches ? 'dark' : 'light');
const listeners = new Set<() => void>();
function apply(theme: Theme) {
  current = theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  listeners.forEach(listener => listener());
}
apply(current);
system.addEventListener('change', event => { if (!preference) apply(event.matches ? 'dark' : 'light'); });
window.addEventListener('storage', event => {
  if (event.key !== key && event.key !== null) return;
  preference = storedTheme();
  apply(preference ?? (system.matches ? 'dark' : 'light'));
});

export function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const [theme, setTheme] = useState(current);
  useEffect(() => {
    const update = () => setTheme(current);
    listeners.add(update);
    update();
    return () => { listeners.delete(update); };
  }, []);
  const next = theme === 'dark' ? 'light' : 'dark';
  return <button type="button" className={compact ? 'icon-button ghost theme-toggle' : 'theme-choice'} title={`切换到${next === 'dark' ? '深色' : '浅色'}模式`} aria-label={`切换到${next === 'dark' ? '深色' : '浅色'}模式`} onClick={() => {
    preference = next;
    try { localStorage.setItem(key, next); } catch { /* The theme still works when storage is unavailable. */ }
    apply(next);
  }}><Icon name={theme === 'dark' ? 'moon' : 'sun'} size={18} />{!compact && <><span>{theme === 'dark' ? '深色模式' : '浅色模式'}</span><span className="muted small">切换</span></>}</button>;
}
