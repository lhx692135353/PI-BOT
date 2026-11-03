import { createCanvas } from '@napi-rs/canvas';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { smoothOutline, spec } from '../../packages/bot-face/src/index.js';

// A close-up of the original Pi Bot silhouette, framed as a native app icon.
// Draw at a common unit size so every platform gets the same composition.
const assets = resolve(import.meta.dirname, '../apps/desktop/assets');
mkdirSync(assets, { recursive: true });
const png = (size: number) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(size / 1024, size / 1024);
  const rounded = (x: number, y: number, width: number, height: number, radius: number) => {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
  };
  const shellGradient = ctx.createLinearGradient(100, 50, 840, 970);
  shellGradient.addColorStop(0, '#ffffff'); shellGradient.addColorStop(0.35, '#f3f4f5');
  shellGradient.addColorStop(0.7, '#e2e4e7'); shellGradient.addColorStop(1, '#f6f7f8');
  ctx.shadowColor = '#64708033'; ctx.shadowBlur = 32 * size / 1024; ctx.shadowOffsetY = 14 * size / 1024;
  rounded(64, 54, 896, 906, 218); ctx.fillStyle = shellGradient; ctx.fill();
  ctx.shadowColor = 'transparent';
  const rim = ctx.createLinearGradient(0, 64, 0, 950);
  rim.addColorStop(0, '#ffffff'); rim.addColorStop(0.5, '#ffffff60'); rim.addColorStop(1, '#cfd3d980');
  rounded(67, 57, 890, 900, 215); ctx.strokeStyle = rim; ctx.lineWidth = 3; ctx.stroke();
  const inset = ctx.createLinearGradient(0, 85, 0, 928);
  inset.addColorStop(0, '#ffffff'); inset.addColorStop(0.65, '#fafaf9'); inset.addColorStop(1, '#f1f2f3');
  rounded(88, 78, 848, 854, 194); ctx.fillStyle = inset; ctx.fill();
  ctx.save(); ctx.clip();
  ctx.translate(510, 702); ctx.rotate(-0.16); ctx.scale(540, 540);
  const outline = smoothOutline(spec.shapes.blob.points);
  const body = () => {
    ctx.beginPath(); ctx.moveTo(...outline.start);
    for (const [c1, c2, point] of outline.segments) ctx.bezierCurveTo(...c1, ...c2, ...point);
    ctx.closePath();
  };
  const bodyColor = ctx.createLinearGradient(-0.6, -0.8, 0.7, 0.9);
  bodyColor.addColorStop(0, '#ffad6c'); bodyColor.addColorStop(0.38, '#ff9147');
  bodyColor.addColorStop(0.7, '#ff742d'); bodyColor.addColorStop(1, '#e85c18');
  ctx.shadowColor = '#a8754126'; ctx.shadowBlur = 36 * size / 1024; ctx.shadowOffsetY = -6 * size / 1024;
  body(); ctx.fillStyle = bodyColor; ctx.fill(); ctx.shadowColor = 'transparent';
  ctx.save(); body(); ctx.clip();
  const glow = ctx.createRadialGradient(-0.35, -0.6, 0, -0.25, -0.45, 1.2);
  glow.addColorStop(0, '#ffd5ae55'); glow.addColorStop(1, '#ffd5ae00');
  ctx.fillStyle = glow; ctx.fillRect(-1, -1, 2, 2);
  ctx.restore();
  body(); ctx.strokeStyle = '#ffd6ad90'; ctx.lineWidth = 0.008; ctx.stroke();
  ctx.fillStyle = '#171717';
  for (const x of [-0.24, 0.24]) {
    ctx.save(); ctx.translate(x, -0.03); ctx.rotate(-0.12);
    rounded(-0.065, -0.12, 0.13, 0.25, 0.065); ctx.fill(); ctx.restore();
  }
  ctx.beginPath(); ctx.moveTo(-0.082, 0.21); ctx.quadraticCurveTo(0, 0.29, 0.082, 0.21);
  ctx.strokeStyle = '#292929'; ctx.lineWidth = 0.026; ctx.lineCap = 'round'; ctx.stroke();
  ctx.restore();
  // A fine inner edge keeps the cropped mascot inside a crisp, continuous frame.
  rounded(89, 79, 846, 852, 193); ctx.strokeStyle = '#d6d9df80'; ctx.lineWidth = 2; ctx.stroke();
  return canvas.toBuffer('image/png');
};
writeFileSync(join(assets, 'pi-bot.png'), png(1024));
if (process.platform === 'darwin') {
  const temp = mkdtempSync(join(tmpdir(), 'pi-bot-icon-'));
  const iconset = join(temp, 'pi-bot.iconset');
  mkdirSync(iconset);
  try {
    for (const size of [16, 32, 128, 256, 512]) {
      writeFileSync(join(iconset, `icon_${size}x${size}.png`), png(size));
      writeFileSync(join(iconset, `icon_${size}x${size}@2x.png`), png(size * 2));
    }
    const result = spawnSync('iconutil', ['-c', 'icns', iconset, '-o', join(assets, 'pi-bot.icns')], { stdio: 'inherit' });
    if (result.status !== 0) throw new Error('生成应用图标失败');
  } finally { rmSync(temp, { recursive: true, force: true }); }
}

// Windows ICO can carry a PNG-compressed 256x256 frame (Vista and later).
const frame = png(256);
const header = Buffer.alloc(22);
header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
header.writeUInt32LE(frame.length, 14); header.writeUInt32LE(22, 18);
writeFileSync(join(assets, 'pi-bot.ico'), Buffer.concat([header, frame]));
