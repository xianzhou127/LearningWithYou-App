import test from 'node:test';
import assert from 'node:assert/strict';
import { pullCrossScale, pullOffset, pullWeight, unpull } from '../../glass/deformation';
import { motionDistance, motionHit } from '../../glass/geometry';
import { MotionEngine, DEFAULT_MOTION, REST_POSE, patchMotion } from '../../glass/motion';

test('left pull extends the contacted end; the right end stays at its rest boundary', () => {
  const pose = { ...REST_POSE, tug: [-22, 0] as [number, number] };
  assert.ok(motionDistance(-12, 26, pose) < -3);
  assert.ok(motionDistance(-12, 26, REST_POSE) > 10);
  assert.ok(Math.abs(motionDistance(315, 26, pose)) < .001);
  assert.ok(motionDistance(318, 26, pose) > 2.9);
});
test('vertical pull bends across the whole length without an 80-DIP hinge', () => {
  const offsets = [18, 80, 160, 240, 290, 315].map(x => pullOffset(x, 18, [0, 23])[1]);
  for (let i = 1; i < offsets.length; i++) assert.ok(offsets[i] > offsets[i - 1]);
  assert.ok(offsets[2] < -10 && offsets[3] < -3 && offsets[4] < -.3);
  assert.equal(offsets.at(-1), 0);
  for (let x = 20; x < 315; x++) {
    const bend = pullWeight(x + 1, 18) - 2 * pullWeight(x, 18) + pullWeight(x - 1, 18);
    assert.ok(Math.abs(bend) < .00007);
  }
});
test('forward/inverse mappings agree and the maximum mixed force does not fold', () => {
  for (const tug of [[-31.9, 23.925], [4, -23.925], [0, 0]]) {
    let previous = -Infinity;
    for (let x = -15; x <= 335; x++) {
      const [dx, dy] = pullOffset(x, 18, tug);
      const actual = unpull(x + dx, 26 + dy, 18, tug);
      assert.ok(Math.abs(actual[0] - x) < .003 && Math.abs(actual[1] - 26) < .003);
      assert.ok(x + dx > previous); previous = x + dx;
    }
  }
});
test('foreground opens grip gaps on outward pull, remains rigid and bounds inward compression', () => {
  for (const direction of [-1, 1]) {
    const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, pull: 22 }, false, true, 0); m.grab(true, 0);
    let pose = REST_POSE;
    for (let t = 0; t <= 900; t += 16) { m.velocity(direction * 900, -500, t); pose = m.sample(t); }
    const x = pose.offsetsX;
    if (direction < 0) assert.ok(x[0] - x[5] > 2.5 && x[2] - x[5] > 10);
    assert.ok(30 + x[0] - (27 + x[5]) > .8);
    assert.ok(148 + x[2] - (145 + x[0]) > .8);
    assert.ok(253 + x[3] - (250 + x[2]) > .8);
    assert.deepEqual(pose.scales, REST_POSE.scales);
    assert.equal(pose.offsetsY[0], pose.offsetsY[1]);
    const grip = [18 + x[5], 26 + pose.offsetsY[5]];
    assert.ok(motionHit(grip[0], grip[1], pose));
    assert.equal(motionHit(grip[0], grip[1] - 60, pose), false);
    m.grab(false, 920); assert.deepEqual(m.sample(1921), REST_POSE);
  }
});
test('contact light accepts 5x and keeps existing saved values', () => {
  assert.equal(patchMotion(DEFAULT_MOTION, { light: 5 }).light, 5);
  assert.equal(patchMotion(DEFAULT_MOTION, { light: 50 }).light, 5);
  assert.equal(patchMotion(DEFAULT_MOTION, { light: 1.85 }).light, 1.85);
});

test('extension narrows the actual surface and compression widens it about the same centreline', () => {
  const radius = (force: number) => {
    const pose = { ...REST_POSE, tug: [force, 0] as [number, number] };
    const x = 160 + pullOffset(160, 18, pose.tug)[0];
    let inside = 0, outside = 35;
    for (let i = 0; i < 24; i++) {
      const y = (inside + outside) / 2;
      if (motionDistance(x, 26 + y, pose) < 0) inside = y; else outside = y;
    }
    assert.ok(Math.abs(motionDistance(x, 26 - inside, pose)) < .00001);
    return inside;
  };
  const extended = radius(-31.9), compressed = radius(4);
  assert.ok(extended < 17.3 && extended > 17.1);
  assert.ok(compressed > 20.4 && compressed < 20.5);
  assert.ok(radius(-10) > extended && radius(-10) < 20);
  assert.ok(Math.abs(radius(0) - 20) < .00001);
});

test('the deformed silhouette preserves area for allowed left-grip stretch and compression', () => {
  const area = (force: number) => {
    const pose = { ...REST_POSE, tug: [force, 0] as [number, number] };
    let sum = 0;
    for (let x = -40; x <= 355; x += .25) {
      if (motionDistance(x, 26, pose) >= 0) continue;
      let inside = 0, outside = 40;
      for (let i = 0; i < 18; i++) {
        const y = (inside + outside) / 2;
        if (motionDistance(x, 26 + y, pose) < 0) inside = y; else outside = y;
      }
      sum += .5 * inside;
    }
    return sum;
  };
  const original = (309 - 40) * 40 + Math.PI * 20 ** 2;
  for (const force of [-31.9, -12, 4]) assert.ok(Math.abs(area(force) / original - 1) < .00015);
});

test('full-body inverse and transverse limits hold for all contact locations and mixed directions', () => {
  for (const contact of [6, 18, 87, 160, 265, 315]) for (const tug of [[-31.9, 23.925], [31.9, -23.925], [4, 23.925], [0, 0]]) {
    for (let x = -25; x < 350; x += 7) for (const y of [-20, 12, 26, 48, 75]) {
      const [dx, dy] = pullOffset(x, contact, tug), scale = pullCrossScale(x, contact, tug);
      const center = 24.2, mapped = [x + dx, center + (y - center) * scale + dy];
      const inverse = unpull(mapped[0], mapped[1], contact, tug, center);
      assert.ok(Math.abs(inverse[0] - x) < .00001 && Math.abs(inverse[1] - y) < .00001);
      assert.ok(scale >= .78 && scale <= 1.18);
    }
  }
});

test('release couples thickness to the current oscillation and reduced/off return to neutral', () => {
  const engine = new MotionEngine(); engine.configure({ ...DEFAULT_MOTION, pull: 22 }, false, true, 0); engine.grab(true, 0);
  for (let t = 0; t <= 500; t += 10) { engine.velocity(-900, 0, t); engine.sample(t); }
  engine.grab(false, 501);
  const widths = Array.from({ length: 100 }, (_, i) => { const p = engine.sample(501 + i * 10); return pullCrossScale(160, p.contact[0], p.tug); });
  assert.ok(Math.min(...widths) < .92 && Math.max(...widths) > 1.01);
  assert.deepEqual(engine.sample(1600), REST_POSE);
  for (const [enabled, reduced] of [[true, true], [false, false]]) {
    engine.configure({ ...DEFAULT_MOTION, enabled }, reduced, true, 1700);
    engine.grab(true, 1700); engine.velocity(-900, 900, 1700);
    const p = engine.sample(1750); assert.equal(pullCrossScale(160, p.contact[0], p.tug), 1);
  }
});
