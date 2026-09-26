import { test } from "node:test";
import assert from "node:assert/strict";
import { SurfaceMotion, advanceSpring } from "../surface-motion";
import { surfaceMaterial } from "../material";
import { backdropRegion, inSystemCorner } from "../window-placement";
import { shadowBitmap, SHADOW_MARGIN } from "../shadow-bitmap";

test("native surface reverses without stale hide, settles and has no idle scheduling", () => {
  let now = 0, next = 0, hides = 0;
  const tasks = new Map<number, () => void>(), frames: number[] = [];
  const motion = new SurfaceMotion(p => frames.push(p), () => hides++, {
    now: () => now, schedule: cb => { tasks.set(++next, cb); return next; }, cancel: id => { tasks.delete(id as number); },
  });
  const frame = () => { now += 16; const pending = [...tasks.values()]; tasks.clear(); pending.forEach(cb => cb()); };
  motion.set(true); frame(); frame(); motion.set(false); frame();
  const before = frames.at(-1)!; motion.set(true);
  assert.equal(frames.at(-1), before, "retargeting must not jump");
  assert.equal(tasks.size, 1, "one timer, not queued animations");
  for (let i = 0; i < 35; i++) frame();
  assert.equal(hides, 0); assert.equal(tasks.size, 0); assert.equal(frames.at(-1), 1);
  motion.set(false); for (let i = 0; i < 35; i++) frame();
  assert.equal(hides, 1); assert.equal(frames.at(-1), 0); assert.equal(tasks.size, 0);
  assert.ok(frames.every(p => p >= 0 && p <= 1));
});
test("reduced motion and hide-all cancel outstanding frames immediately", () => {
  const tasks = new Map<number, () => void>(); let value = -1, hides = 0;
  const motion = new SurfaceMotion(p => { value = p; }, () => hides++, { now: () => 0, schedule: cb => { tasks.set(1, cb); return 1; }, cancel: id => { tasks.delete(id as number); } });
  motion.set(true); motion.set(false, true);
  assert.equal(tasks.size, 0); assert.equal(value, 0); assert.equal(hides, 1);
  motion.set(true, true); assert.equal(value, 1); assert.equal(tasks.size, 0);
  const delayed = advanceSpring({ value: .3, velocity: 10 }, 0, 50);
  assert.ok(Number.isFinite(delayed.value) && Number.isFinite(delayed.velocity));
});
test("material capability and accessibility fallbacks", () => {
  assert.equal(surfaceMaterial("win32", "10.0.22621", false, false), "acrylic");
  for (const [platform, version, reduced, contrast] of [["win32", "10.0.22000", false, false], ["win32", "10.0.19045", false, false], ["linux", "6.1.22621", false, false], ["win32", "10.0.26100", true, false], ["win32", "10.0.26100", false, true]] as const) {
    assert.equal(surfaceMaterial(platform, version, reduced, contrast), "solid");
  }
});
test("system corner forwarding excludes only the four transparent corner areas", () => {
  for (const [width, height] of [[309, 40], [252, 270], [440, 560]]) {
    for (const x of [.5, width - .5]) for (const y of [.5, height - .5]) assert.equal(inSystemCorner(x, y, width, height), true);
    for (const [x, y] of [[8, 0], [0, 8], [width / 2, height / 2], [-1, 0], [width, height]]) assert.equal(inSystemCorner(x, y, width, height), false);
  }
});
test("large Acrylic region covers each row once and excludes the capsule corners", () => {
  for (const [width, height, radius] of [[309, 40, 20], [252, 270, 16], [440, 560, 16], [310, 41, 20]]) {
    const mask = backdropRegion(width, height, radius);
    const coverage = Array.from({ length: height }, () => 0);
    for (const rect of mask) {
      assert.equal(rect.x * 2 + rect.width, width);
      for (let y = rect.y; y < rect.y + rect.height; y++) coverage[y]++;
    }
    assert.ok(coverage.every(n => n === 1));
    assert.ok(mask[0].x > 8); assert.equal(mask[0].x, mask.at(-1)!.x);
    assert.equal(inSystemCorner(1, 1, width, height, radius), true);
    assert.equal(inSystemCorner(width / 2, 1, width, height, radius), false);
  }
});
test("shadow raster leaves the body empty and fades completely within 3 DIP", () => {
  for (const scale of [1, 1.25, 1.4, 1.5, 2]) {
    const w = 309, h = 40, r = 20, bitmap = shadowBitmap(w, h, r, scale);
    let painted = 0;
    for (let y = 0; y < bitmap.height; y++) for (let x = 0; x < bitmap.width; x++) {
      const alpha = bitmap.pixels[(y * bitmap.width + x) * 4 + 3];
      if (!alpha) continue;
      painted++;
      const px = (x + .5) / scale - SHADOW_MARGIN, py = (y + .5) / scale - SHADOW_MARGIN;
      const nearestX = Math.max(r, Math.min(px, w - r));
      const distance = Math.hypot(px - nearestX, py - r) - r;
      assert.ok(distance > 0 && distance < 3);
      assert.ok(alpha <= 38);
    }
    assert.ok(painted > w);
  }
});
