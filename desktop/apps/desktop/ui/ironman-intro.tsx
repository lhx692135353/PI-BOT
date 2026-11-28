import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';

interface IronManIntroProps {
  onDone(): void;
}

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

export function IronManIntro({ onDone }: IronManIntroProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const doneRef = useRef(false);
  const onDoneRef = useRef(onDone);
  onDoneRef.current = onDone;
  const [fading, setFading] = useState(false);

  useEffect(() => {
    const finish = () => {
      if (doneRef.current) return;
      doneRef.current = true;
      onDoneRef.current();
    };

    if (prefersReducedMotion()) {
      finish();
      return;
    }

    const container = hostRef.current;
    if (!container) {
      finish();
      return;
    }

    let renderer: THREE.WebGLRenderer | null = null;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    } catch {
      finish();
      return;
    }

    const width = Math.max(container.clientWidth, window.innerWidth);
    const height = Math.max(container.clientHeight, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(width, height);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    container.appendChild(renderer.domElement);

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(44, width / height, 0.1, 100);
    camera.position.set(0, 0, 10.2);

    const ambient = new THREE.AmbientLight(0x233149, 1.3);
    scene.add(ambient);

    const keyLight = new THREE.DirectionalLight(0xffdfaa, 2.2);
    keyLight.position.set(5, 6, 8);
    scene.add(keyLight);

    const rimLight = new THREE.DirectionalLight(0x55d8ff, 2.0);
    rimLight.position.set(-6, -3, 6);
    scene.add(rimLight);

    const reactorLight = new THREE.PointLight(0x6fe8ff, 0.2, 18);
    reactorLight.position.set(0, 0, 2.2);
    scene.add(reactorLight);

    const geometries: THREE.BufferGeometry[] = [];
    const materials: THREE.Material[] = [];
    const trackGeo = <T extends THREE.BufferGeometry>(g: T): T => { geometries.push(g); return g; };
    const trackMat = <T extends THREE.Material>(m: T): T => { materials.push(m); return m; };

    const crimsonMat = trackMat(new THREE.MeshStandardMaterial({
      color: 0x9b1d24,
      metalness: 0.78,
      roughness: 0.28,
    }));
    const goldMat = trackMat(new THREE.MeshStandardMaterial({
      color: 0xd8b366,
      metalness: 0.85,
      roughness: 0.24,
    }));
    const titaniumMat = trackMat(new THREE.MeshStandardMaterial({
      color: 0x1c2536,
      metalness: 0.82,
      roughness: 0.35,
    }));
    const cyanMat = trackMat(new THREE.MeshStandardMaterial({
      color: 0x7aeaff,
      emissive: 0x35cfff,
      emissiveIntensity: 0.2,
      metalness: 0.2,
      roughness: 0.15,
    }));

    // 6 瓣钛金红装甲闸门
    const shutterGroup = new THREE.Group();
    scene.add(shutterGroup);

    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0.45, -0.35);
    bladeShape.lineTo(5.6, -1.9);
    bladeShape.lineTo(6.1, 1.65);
    bladeShape.lineTo(1.2, 1.05);
    bladeShape.closePath();

    const bladeGeo = trackGeo(new THREE.ExtrudeGeometry(bladeShape, {
      depth: 0.26,
      bevelEnabled: true,
      bevelThickness: 0.05,
      bevelSize: 0.05,
      bevelSegments: 2,
    }));
    const trimGeo = trackGeo(new THREE.BoxGeometry(3.8, 0.14, 0.32));

    const blades: THREE.Group[] = [];
    for (let i = 0; i < 6; i++) {
      const pivot = new THREE.Group();
      const angle = (i * Math.PI) / 3;
      pivot.rotation.z = angle;

      const panel = new THREE.Mesh(bladeGeo, crimsonMat);
      panel.position.z = -0.15;
      pivot.add(panel);

      const goldTrim = new THREE.Mesh(trimGeo, goldMat);
      goldTrim.position.set(2.8, 0.35, 0.02);
      goldTrim.rotation.z = 0.08;
      pivot.add(goldTrim);

      shutterGroup.add(pivot);
      blades.push(pivot);
    }

    // 中央方舟反应堆与涡轮咬合环
    const reactorGroup = new THREE.Group();
    reactorGroup.position.z = 0.55;
    scene.add(reactorGroup);

    const outerRing = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(2.05, 0.14, 16, 64)), titaniumMat);
    reactorGroup.add(outerRing);

    const turbineGroup = new THREE.Group();
    reactorGroup.add(turbineGroup);
    const toothGeo = trackGeo(new THREE.BoxGeometry(0.18, 0.42, 0.18));
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const tooth = new THREE.Mesh(toothGeo, goldMat);
      tooth.position.set(Math.cos(a) * 1.72, Math.sin(a) * 1.72, 0.06);
      tooth.rotation.z = a + Math.PI / 2;
      turbineGroup.add(tooth);
    }

    const innerRing = new THREE.Mesh(trackGeo(new THREE.TorusGeometry(1.18, 0.11, 16, 48)), cyanMat);
    reactorGroup.add(innerRing);

    const core = new THREE.Mesh(trackGeo(new THREE.CylinderGeometry(0.68, 0.68, 0.18, 32)), cyanMat);
    core.rotation.x = Math.PI / 2;
    reactorGroup.add(core);

    const start = performance.now();
    const totalMs = 2450;
    let raf = 0;
    let fadeTriggered = false;

    const easeOutCubic = (x: number) => 1 - Math.pow(1 - x, 3);
    const easeInOutQuart = (x: number) => (x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2);

    const onResize = () => {
      if (!renderer || !container) return;
      const w = Math.max(container.clientWidth, window.innerWidth);
      const h = Math.max(container.clientHeight, window.innerHeight);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    };
    window.addEventListener('resize', onResize);

    const tick = (now: number) => {
      const elapsed = now - start;
      const t = Math.min(elapsed / totalMs, 1);

      // 阶段 1 (0 ~ 0.34): 方舟反应堆点火 + 涡轮加速咬合
      const ignite = easeOutCubic(Math.min(t / 0.34, 1));
      cyanMat.emissiveIntensity = 0.25 + ignite * 2.6;
      reactorLight.intensity = 0.4 + ignite * 5.2;
      turbineGroup.rotation.z = t * Math.PI * 3.1;
      outerRing.rotation.z = -t * Math.PI * 1.1;

      // 阶段 2 (0.32 ~ 0.85): 6 瓣钛金装甲闸门液压展开
      const openRaw = Math.max(0, Math.min((t - 0.32) / 0.53, 1));
      const open = easeInOutQuart(openRaw);
      blades.forEach((pivot, i) => {
        const angle = (i * Math.PI) / 3 + open * 0.42;
        pivot.rotation.z = angle;
        pivot.position.x = Math.cos(angle) * open * 4.4;
        pivot.position.y = Math.sin(angle) * open * 4.4;
        pivot.position.z = open * 1.4;
      });

      // 反应堆随开启向前掠过淡出
      const reactorOut = Math.max(0, (t - 0.42) / 0.45);
      const s = 1 + reactorOut * 1.6;
      reactorGroup.scale.set(s, s, 1);
      reactorGroup.position.z = 0.55 + reactorOut * 3.2;
      camera.position.z = 10.2 - open * 1.2;

      renderer!.render(scene, camera);

      if (t >= 0.74 && !fadeTriggered) {
        fadeTriggered = true;
        setFading(true);
      }
      if (t < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        finish();
      }
    };

    raf = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', onResize);
      geometries.forEach(g => g.dispose());
      materials.forEach(m => m.dispose());
      if (renderer) {
        renderer.dispose();
        renderer.domElement.remove();
      }
    };
  }, []);

  return (
    <div
      className={`ironman-intro${fading ? ' fading' : ''}`}
      role="presentation"
      onClick={onDone}
    >
      <div className="ironman-intro-canvas" ref={hostRef} />
      <div className="ironman-intro-hud">
        <span className="ironman-intro-tag">MARK-OS // STARK HUD</span>
        <span className="ironman-intro-sub">ARMOR SYSTEMS ONLINE</span>
      </div>
      <button
        type="button"
        className="ironman-intro-skip"
        onClick={event => { event.stopPropagation(); onDone(); }}
      >
        跳过
      </button>
    </div>
  );
}
