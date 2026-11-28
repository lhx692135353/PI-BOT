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
const toIco = (frame: Buffer) => {
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4);
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(frame.length, 14); header.writeUInt32LE(22, 18);
  return Buffer.concat([header, frame]);
};
writeFileSync(join(assets, 'pi-bot.ico'), toIco(png(256)));

// Iron Man themed app icon: dark titanium crimson shell + iconic red/gold helmet + glowing arc-cyan eyes.
const drawIronManIcon = (size: number, fullBleed: boolean) => {
  const canvas = createCanvas(size, size);
  const ctx = canvas.getContext('2d');
  ctx.scale(size / 1024, size / 1024);
  const rounded = (x: number, y: number, width: number, height: number, radius: number) => {
    ctx.beginPath(); ctx.roundRect(x, y, width, height, radius);
  };

  if (fullBleed) {
    const bg = ctx.createRadialGradient(512, 360, 40, 512, 512, 760);
    bg.addColorStop(0, '#2a1218');
    bg.addColorStop(0.55, '#130b12');
    bg.addColorStop(1, '#080a10');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, 1024, 1024);
  } else {
    const shell = ctx.createLinearGradient(100, 50, 860, 970);
    shell.addColorStop(0, '#2c171d');
    shell.addColorStop(0.45, '#171018');
    shell.addColorStop(1, '#0b0e16');
    ctx.shadowColor = '#00000055';
    ctx.shadowBlur = 32 * size / 1024;
    ctx.shadowOffsetY = 14 * size / 1024;
    rounded(64, 54, 896, 906, 218);
    ctx.fillStyle = shell;
    ctx.fill();
    ctx.shadowColor = 'transparent';

    const rim = ctx.createLinearGradient(64, 54, 960, 960);
    rim.addColorStop(0, '#f3d48c');
    rim.addColorStop(0.35, '#a7262d');
    rim.addColorStop(0.7, '#d8b467');
    rim.addColorStop(1, '#4c1419');
    rounded(67, 57, 890, 900, 215);
    ctx.strokeStyle = rim;
    ctx.lineWidth = 6;
    ctx.stroke();

    const inset = ctx.createRadialGradient(512, 380, 40, 512, 520, 620);
    inset.addColorStop(0, '#2c131a');
    inset.addColorStop(0.6, '#140c14');
    inset.addColorStop(1, '#090b12');
    rounded(88, 78, 848, 854, 194);
    ctx.fillStyle = inset;
    ctx.fill();
    ctx.save();
    ctx.clip();
  }

  // Subtle HUD arc rings behind helmet
  ctx.save();
  ctx.strokeStyle = '#6fe8ff28';
  ctx.lineWidth = 4;
  ctx.beginPath(); ctx.arc(512, 520, 390, 0, Math.PI * 2); ctx.stroke();
  ctx.strokeStyle = '#d8b46730';
  ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.arc(512, 520, 345, -Math.PI * 0.85, Math.PI * 0.15); ctx.stroke();
  ctx.beginPath(); ctx.arc(512, 520, 345, Math.PI * 0.35, Math.PI * 0.95); ctx.stroke();
  ctx.restore();

  // Helmet coordinate space centered at (512, 525)
  ctx.save();
  ctx.translate(512, 525);
  const scale = fullBleed ? 1.06 : 0.96;
  ctx.scale(scale, scale);

  // Outer crimson dome
  const dome = () => {
    ctx.beginPath();
    ctx.moveTo(0, -330);
    ctx.bezierCurveTo(185, -330, 290, -210, 292, -35);
    ctx.lineTo(270, 125);
    ctx.bezierCurveTo(255, 225, 160, 305, 86, 336);
    ctx.lineTo(0, 354);
    ctx.lineTo(-86, 336);
    ctx.bezierCurveTo(-160, 305, -255, 225, -270, 125);
    ctx.lineTo(-292, -35);
    ctx.bezierCurveTo(-290, -210, -185, -330, 0, -330);
    ctx.closePath();
  };
  const crimsonGrad = ctx.createLinearGradient(-240, -330, 260, 350);
  crimsonGrad.addColorStop(0, '#d9454e');
  crimsonGrad.addColorStop(0.35, '#a7262d');
  crimsonGrad.addColorStop(0.75, '#74141b');
  crimsonGrad.addColorStop(1, '#460a0f');
  ctx.shadowColor = '#00000080';
  ctx.shadowBlur = 30 * size / 1024;
  ctx.shadowOffsetY = 16 * size / 1024;
  dome();
  ctx.fillStyle = crimsonGrad;
  ctx.fill();
  ctx.shadowColor = 'transparent';
  ctx.strokeStyle = '#ff8a9044';
  ctx.lineWidth = 4;
  ctx.stroke();

  // Specular top crown highlight
  ctx.save();
  dome();
  ctx.clip();
  const crownGlow = ctx.createRadialGradient(-90, -230, 10, -40, -180, 340);
  crownGlow.addColorStop(0, '#ff9aa060');
  crownGlow.addColorStop(1, '#ff9aa000');
  ctx.fillStyle = crownGlow;
  ctx.fillRect(-320, -360, 640, 420);
  ctx.restore();

  // Side cheek armor recesses
  ctx.fillStyle = '#3c090e';
  for (const dir of [-1, 1]) {
    ctx.beginPath();
    ctx.moveTo(dir * 290, -20);
    ctx.lineTo(dir * 238, 12);
    ctx.lineTo(dir * 224, 140);
    ctx.lineTo(dir * 268, 125);
    ctx.closePath();
    ctx.fill();
  }

  // Gold faceplate
  const faceplate = () => {
    ctx.beginPath();
    ctx.moveTo(-148, -248);
    ctx.lineTo(-92, -142);
    ctx.lineTo(92, -142);
    ctx.lineTo(148, -248);
    ctx.bezierCurveTo(212, -190, 232, -98, 224, -12);
    ctx.lineTo(188, 72);
    ctx.lineTo(205, 134);
    ctx.lineTo(148, 234);
    ctx.lineTo(78, 286);
    ctx.lineTo(66, 250);
    ctx.lineTo(-66, 250);
    ctx.lineTo(-78, 286);
    ctx.lineTo(-148, 234);
    ctx.lineTo(-205, 134);
    ctx.lineTo(-188, 72);
    ctx.lineTo(-224, -12);
    ctx.bezierCurveTo(-232, -98, -212, -190, -148, -248);
    ctx.closePath();
  };
  const goldGrad = ctx.createLinearGradient(-210, -240, 220, 290);
  goldGrad.addColorStop(0, '#fae4a4');
  goldGrad.addColorStop(0.32, '#dfb968');
  goldGrad.addColorStop(0.68, '#b88c3a');
  goldGrad.addColorStop(1, '#7c591c');
  faceplate();
  ctx.fillStyle = goldGrad;
  ctx.fill();
  ctx.strokeStyle = '#241214';
  ctx.lineWidth = 7;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Brow & nose bridge bevel lines
  ctx.strokeStyle = '#6c4d18aa';
  ctx.lineWidth = 5;
  ctx.beginPath();
  ctx.moveTo(-188, -56); ctx.lineTo(-56, -24); ctx.lineTo(0, -34); ctx.lineTo(56, -24); ctx.lineTo(188, -56);
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(-144, 152); ctx.lineTo(-74, 184); ctx.lineTo(74, 184); ctx.lineTo(144, 152);
  ctx.stroke();

  // Chin crimson plate
  ctx.beginPath();
  ctx.moveTo(-72, 252);
  ctx.lineTo(72, 252);
  ctx.lineTo(84, 330);
  ctx.lineTo(0, 348);
  ctx.lineTo(-84, 330);
  ctx.closePath();
  ctx.fillStyle = '#8b1a22';
  ctx.fill();
  ctx.strokeStyle = '#241214';
  ctx.lineWidth = 6;
  ctx.stroke();

  // Mouth slit
  ctx.beginPath();
  ctx.moveTo(-88, 212);
  ctx.lineTo(-42, 198);
  ctx.lineTo(42, 198);
  ctx.lineTo(88, 212);
  ctx.lineTo(78, 226);
  ctx.lineTo(-78, 226);
  ctx.closePath();
  ctx.fillStyle = '#221114';
  ctx.fill();

  // Glowing arc-cyan eyes
  for (const dir of [-1, 1]) {
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(dir * 40, -14);
    ctx.lineTo(dir * 168, -42);
    ctx.lineTo(dir * 156, 8);
    ctx.lineTo(dir * 46, 20);
    ctx.closePath();
    ctx.shadowColor = '#32d5ff';
    ctx.shadowBlur = 34 * size / 1024;
    ctx.fillStyle = '#4ad8ff';
    ctx.fill();
    ctx.fillStyle = '#d6f9ff';
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = '#1b2733';
    ctx.lineWidth = 5;
    ctx.stroke();
    ctx.restore();
  }

  ctx.restore();

  if (!fullBleed) {
    ctx.restore();
    rounded(89, 79, 846, 852, 193);
    ctx.strokeStyle = '#d8b46755';
    ctx.lineWidth = 2.5;
    ctx.stroke();
  }
  return canvas.toBuffer('image/png');
};

writeFileSync(join(assets, 'pi-bot-ironman.png'), drawIronManIcon(1024, false));
writeFileSync(join(assets, 'pi-bot-ironman.ico'), toIco(drawIronManIcon(256, false)));

const iosIronManDir = resolve(import.meta.dirname, '../../ios/PiBot/Assets.xcassets/AppIconIronMan.appiconset');
mkdirSync(iosIronManDir, { recursive: true });
writeFileSync(join(iosIronManDir, 'AppIconIronMan.png'), drawIronManIcon(1024, true));
writeFileSync(
  join(iosIronManDir, 'Contents.json'),
  JSON.stringify(
    {
      images: [
        {
          filename: 'AppIconIronMan.png',
          idiom: 'universal',
          platform: 'ios',
          size: '1024x1024',
        },
      ],
      info: {
        author: 'xcode',
        version: 1,
      },
    },
    null,
    2,
  ) + '\n',
);
