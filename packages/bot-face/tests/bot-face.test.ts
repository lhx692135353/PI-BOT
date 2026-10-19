import test from "node:test";
import assert from "node:assert/strict";
import {
  avatarFor,
  BotEngine,
  COLORS,
  drawBot,
  isAvatar,
  moodFor,
  MOODS,
  normalizeAvatar,
  rng,
  SCHEMES,
  SHAPES,
  sleepLabel,
  smoothOutline,
  spec,
} from "../src/index.js";

/** Reference values shared with the Android port (PiBotEngineTest.kt). */
export const RNG_42 = [0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693, 0.17481389874592423];

test("spec covers every shape, color and mood with valid data", () => {
  assert.deepEqual(Object.keys(spec.shapes).sort(), [...SHAPES].sort());
  assert.deepEqual(Object.keys(spec.colors).sort(), [...COLORS].sort());
  assert.deepEqual(Object.keys(spec.moods).sort(), [...MOODS].sort());
  const hex = /^#[0-9a-f]{6}$/i;
  for (const [name, s] of Object.entries(spec.shapes)) {
    assert.ok(s.points.length >= 6, `${name} needs a closed outline`);
    for (const [x, y] of s.points) assert.ok(Math.abs(x) <= 1.3 && Math.abs(y) <= 1.3, `${name} stays in unit space`);
    assert.ok(s.face.eye > 0 && s.face.gap > 0);
  }
  for (const [name, c] of Object.entries(spec.colors))
    for (const value of [...c.light, ...c.dark, c.ink, c.cheek]) assert.match(value, hex, `${name} ${value}`);
  for (const value of spec.confetti) assert.match(value, hex);
  assert.equal(spec.defaults.shape, "blob");
  assert.equal(spec.defaults.color, "orange");
});

test("avatars validate, normalize and vary deterministically by seed", () => {
  assert.equal(isAvatar({ shape: "blob", color: "orange", scheme: "light" }), true);
  assert.equal(isAvatar({ shape: "triangle", color: "orange", scheme: "light" }), false);
  assert.deepEqual(normalizeAvatar(null), { shape: "blob", color: "orange", scheme: "light" });
  assert.deepEqual(avatarFor("abc"), avatarFor("abc"));
  const looks = new Set(Array.from({ length: 40 }, (_, i) => JSON.stringify(avatarFor(`bot-${i}`))));
  assert.ok(looks.size > 15, "new bots should rarely look alike");
  for (const scheme of SCHEMES) assert.ok(isAvatar({ ...avatarFor("x"), scheme }));
});

test("rng matches the shared reference sequence", () => {
  const r = rng(42);
  for (const expected of RNG_42) assert.ok(Math.abs(r() - expected) < 1e-12);
});

test("engine is deterministic for the same seed and settles after a hop", () => {
  const run = () => {
    const e = new BotEngine("idle", { seed: 7 });
    const frames = [];
    for (let i = 0; i < 300; i++) {
      if (i === 30) e.setMood("celebrate");
      if (i === 150) e.setMood("idle");
      e.step(1 / 60);
      frames.push(e.frame());
    }
    return frames.map((f) => [f.blink, f.gazeX, f.offsetY, f.scaleX, f.particles.length].map((v) => v.toFixed(6)).join());
  };
  assert.deepEqual(run(), run());
  const e = new BotEngine("idle", { seed: 1 });
  e.bounce();
  for (let i = 0; i < 600; i++) e.step(1 / 60);
  assert.ok(Math.abs(e.frame().offsetY) < 0.02, "hop spring returns to rest");
});

test("celebrate throws confetti, reduce-motion stays still", () => {
  const e = new BotEngine("idle", { seed: 3 });
  e.setMood("celebrate");
  e.step(0.016);
  assert.ok(e.frame().particles.length >= 20);
  for (let i = 0; i < 400; i++) e.step(0.05);
  assert.ok(e.frame().particles.length <= 80, "particle pool is bounded");
  const calm = new BotEngine("idle", { seed: 3, reduceMotion: true });
  calm.setMood("celebrate");
  for (let i = 0; i < 100; i++) calm.step(0.05);
  const f = calm.frame();
  assert.equal(f.particles.length, 0);
  assert.equal(f.blink, 0);
  assert.equal(f.scaleX, 1);
});

test("eyes track the pointer except while busy", () => {
  const e = new BotEngine("idle", { seed: 1 });
  e.look({ x: 1, y: -1 });
  for (let i = 0; i < 120; i++) e.step(1 / 60);
  assert.ok(e.frame().gazeX > 0.9 && e.frame().gazeY < -0.9);
  e.setMood("working");
  for (let i = 0; i < 120; i++) e.step(1 / 60);
  assert.ok(Math.abs(e.frame().gazeX) < 0.1, "working looks at the desk");
});

test("run status maps to moods", () => {
  const now = 1_000_000_000;
  assert.equal(moodFor({ status: null, now }), "idle");
  assert.equal(moodFor({ status: "queued", now }), "thinking");
  assert.equal(moodFor({ status: "running", now }), "thinking");
  assert.equal(moodFor({ status: "running", tool: "web_search", now }), "searching");
  assert.equal(moodFor({ status: "running", tool: "run_command", now }), "working");
  assert.equal(moodFor({ status: "running", tool: "ask_agent", now }), "waiting");
  assert.equal(moodFor({ status: "waiting_approval", now }), "waiting");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 1000, now }), "celebrate");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 60000, now }), "idle");
  assert.equal(moodFor({ status: "failed", finishedAt: now - 1000, now }), "error");
  assert.equal(moodFor({ status: "failed", finishedAt: now - 60000, now }), "idle");
  assert.equal(moodFor({ status: "cancelled", finishedAt: now, now }), "idle");
  assert.equal(moodFor({ status: "completed", finishedAt: now - 8 * 86400_000, lastActiveAt: now - 7 * 86400_000, now }), "sleeping");
  assert.equal(sleepLabel(now - 7 * 86400_000, now), "7 天");
  assert.equal(sleepLabel(now - 3600_000, now), null);
});

test("renderer draws every shape, color and mood without a real canvas", () => {
  const calls: string[] = [];
  const gradient = { addColorStop() {} };
  const ctx = new Proxy({} as Record<string, unknown>, {
    get(target, key: string) {
      if (key in target) return target[key];
      if (key === "createLinearGradient" || key === "createRadialGradient") return () => gradient;
      return (...args: unknown[]) => {
        calls.push(key);
        for (const a of args) if (typeof a === "number") assert.ok(Number.isFinite(a), `${key} got ${a}`);
      };
    },
    set(target, key: string, value) {
      target[key] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  for (const shape of SHAPES)
    for (const mood of MOODS) {
      const e = new BotEngine(mood, { seed: 2 });
      e.setMood(mood);
      e.step(0.05);
      for (const color of COLORS.slice(0, 3)) drawBot(ctx, e.frame(), { shape, color, scheme: "dark" }, 120);
      const list = new BotEngine(mood, { seed: 2, motionProfile: "list" });
      list.setInteraction({ active: true });
      list.step(0.05);
      for (const size of [44, 64]) drawBot(ctx, list.frame(), { shape, color: "orange", scheme: "light" }, size);
    }
  assert.ok(calls.includes("bezierCurveTo"));
  assert.ok(calls.includes("fill"));
});

test("outline smoothing produces one cubic per point", () => {
  const pts: [number, number][] = [[0, -1], [1, 0], [0, 1], [-1, 0]];
  const outline = smoothOutline(pts, 1);
  assert.equal(outline.segments.length, pts.length);
  assert.deepEqual(outline.segments.at(-1)![2], pts[0], "outline closes on the first anchor");
});

const advance = (engine: BotEngine, seconds = 1) => {
  for (let i = 0; i < Math.ceil(seconds * 60); i++) engine.step(1 / 60);
  return engine.frame();
};

test("list interaction greets once, tracks the row and eases back after leaving", () => {
  const once = new BotEngine("idle", { seed: 12, motionProfile: "list" });
  const moving = new BotEngine("idle", { seed: 12, motionProfile: "list" });
  const interaction = { active: true, pointer: { x: 1, y: -1 } };
  once.setInteraction(interaction);
  for (let i = 0; i < 90; i++) {
    moving.setInteraction(interaction);
    once.step(1 / 60);
    moving.step(1 / 60);
    assert.deepEqual(moving.frame(), once.frame(), "moving within a row must not repeat the hop");
  }
  assert.ok(once.frame().wave! > 0.99);
  assert.ok(once.frame().gazeX > 0.9 && once.frame().gazeY < -0.9);
  once.setInteraction({ active: false });
  const easing = advance(once, 1 / 60);
  assert.ok(easing.wave! > 0 && easing.wave! < 0.99, "wave eases out rather than snapping");
  assert.ok(advance(once).wave! < 0.001);
  assert.ok(Math.abs(once.frame().gazeX) < 0.25, "eyes return to their idle gaze");
});

test("list hover preserves task moods, acknowledges briefly and does not leak between bots", () => {
  for (const mood of ["thinking", "searching", "working", "waiting", "celebrate", "error"] as const) {
    const bot = new BotEngine(mood, { seed: 2, motionProfile: "list" });
    const other = new BotEngine(mood, { seed: 2, motionProfile: "list" });
    bot.setInteraction({ active: true, pointer: { x: -1, y: -1 } });
    const greeting = advance(bot, 0.3);
    const baseline = advance(other, 0.3);
    assert.equal(greeting.mood, mood);
    assert.equal(greeting.wave, 0);
    assert.equal(greeting.gazeX, baseline.gazeX, "busy gaze follows the task");
    assert.ok(greeting.offsetY > baseline.offsetY, "hover adds a brief nod");
    assert.equal(other.frame().wave, 0);
    assert.deepEqual(advance(bot), advance(other), "the nod settles while hover remains active");
  }
});

test("sleeping list bots wake visually without changing their real mood", () => {
  const bot = new BotEngine("sleeping", { motionProfile: "list" });
  bot.setInteraction({ active: true, pointer: { x: 0.7, y: -0.3 } });
  assert.equal(advance(bot).mood, "idle");
  assert.equal(bot.currentMood, "sleeping");
  assert.ok(bot.frame().gazeX > 0.6);
  bot.setInteraction({ active: false });
  assert.equal(advance(bot).mood, "sleeping");
});

test("list work accents are opt-in and survive transitions during hover", () => {
  for (const mood of ["thinking", "working", "searching"] as const) {
    const list = new BotEngine(mood, { motionProfile: "list" });
    const normal = new BotEngine(mood);
    const listFrame = advance(list, 0.25);
    const normalFrame = advance(normal, 0.25);
    assert.ok(Math.abs(listFrame.rotation) > 0.01);
    assert.equal(normalFrame.rotation, 0);
    assert.equal(normalFrame.armActivity, undefined);
    if (mood === "working") assert.ok(listFrame.armActivity! > 2);
  }
  const list = new BotEngine("idle", { motionProfile: "list" });
  list.setInteraction({ active: true });
  advance(list);
  list.setMood("working");
  assert.equal(advance(list).wave, 0);
  list.setMood("celebrate");
  assert.equal(advance(list, 0.1).mood, "celebrate");
  list.setMood("idle");
  assert.ok(advance(list).wave! > 0.99);
  const normal = new BotEngine("idle", { seed: 5 });
  const untouched = new BotEngine("idle", { seed: 5 });
  normal.setInteraction({ active: true, pointer: { x: 1, y: 1 } });
  assert.deepEqual(advance(normal), advance(untouched), "default avatars ignore row interaction");
});

test("reduced-motion list frames freeze all motion, including arms and effects", () => {
  for (const mood of MOODS) {
    const bot = new BotEngine(mood, { motionProfile: "list" });
    bot.setInteraction({ active: true });
    advance(bot, 0.3);
    bot.setReducedMotion(true);
    const still = advance(bot);
    assert.deepEqual(advance(bot, 5), still, `${mood} stays completely still`);
    assert.equal(still.t, 0, "renderer arms and effects use a frozen clock");
    assert.equal(still.scaleX, 1);
    assert.equal(still.scaleY, 1);
    assert.equal(still.rotation, 0);
    assert.equal(still.offsetY, 0);
    assert.equal(still.particles.length, 0);
    bot.setInteraction({ active: false });
    assert.deepEqual(advance(bot), advance(bot, 5));
    assert.equal(bot.currentMood, mood);
    bot.setReducedMotion(false);
    assert.ok(advance(bot).t > 0, "motion resumes after the preference changes");
  }
});
