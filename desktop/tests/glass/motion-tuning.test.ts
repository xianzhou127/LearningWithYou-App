import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionEngine, DEFAULT_MOTION, MOTION_CONTROLS, patchMotion, REST_POSE } from '../../glass/motion';
import { MotionPreview } from '../../glass/motion-preview';
import { ElasticMode } from '../../glass/elastic';

test('every live parameter rejects nonfinite input and clamps both endpoints', () => {
  for (const [key, range] of Object.entries(MOTION_CONTROLS)) {
    assert.throws(() => patchMotion(DEFAULT_MOTION, { [key]: NaN }));
    assert.throws(() => patchMotion(DEFAULT_MOTION, { [key]: Infinity }));
    assert.equal(patchMotion(DEFAULT_MOTION, { [key]: -1000 })[key as keyof typeof MOTION_CONTROLS], range.min);
    assert.equal(patchMotion(DEFAULT_MOTION, { [key]: 1000 })[key as keyof typeof MOTION_CONTROLS], range.max);
  }
});
test('live amplitude and wave tuning preserve current pose, held force and notification identity', () => {
  const m = new MotionEngine(); m.configure(DEFAULT_MOTION, false, true, 0); m.grab(true, 0);
  const before = m.sample(100);
  m.configure({ ...DEFAULT_MOTION, bulge: 14, pull: 22, light: 2, waveWidth: 72, waveMs: 900, waveRadius: 360 }, false, true, 100);
  const after = m.sample(100);
  assert.equal(after.inflation, before.inflation); assert.deepEqual(after.ripple, before.ripple); assert.deepEqual(after.lightField, before.lightField);
  assert.equal(m.events.grab, 1); assert.equal(m.events.release, 0);
  assert.equal(m.sample(1000).inflation, 14); assert.equal(m.sample(1000).active, false);
  m.grab(false, 1100); assert.deepEqual(m.sample(2101), REST_POSE);
});
test('retuning a moving spring preserves displacement and velocity; lower damping settles finitely', () => {
  const s = new ElasticMode(); s.force(1, 0, 1); s.sample(800); s.force(0, 800, 1);
  const before = s.sample(920); s.retune(920, 1.25, .18); const after = s.sample(920);
  assert.equal(after.value, before.value); assert.equal(after.velocity, before.velocity);
  assert.equal(s.sample(4000).active, false); assert.equal(s.sample(4000).value, 0);
});
test('preview holds for tuning, turns once, releases and never changes foreground or an Action', () => {
  const m = new MotionEngine(), preview = new MotionPreview(m);
  preview.start('preview-center', 0); preview.step(800); const held = m.sample(800);
  assert.equal(held.inflation, 8); assert.equal(held.active, false); assert.deepEqual(held.contact, [160, 26, 1]);
  assert.deepEqual(held.scales, REST_POSE.scales); assert.deepEqual(held.offsetsY, REST_POSE.offsetsY);
  preview.start('preview-turn', 900);
  for (let t = 900; t < 2000; t += 16) { assert.equal(preview.step(t), true); m.sample(t); }
  assert.equal(preview.step(2000), false); assert.deepEqual(m.sample(3101), REST_POSE);
  preview.start('preview-turn', 3200); m.configure(DEFAULT_MOTION, false, false, 3210);
  assert.equal(preview.step(3210), false); assert.deepEqual(m.sample(3210), REST_POSE);
});
test('reduced mode removes preview, and live controls do not schedule animation', () => {
  const m = new MotionEngine(), p = new MotionPreview(m); m.configure(DEFAULT_MOTION, true, true, 0);
  p.start('preview-turn', 1); assert.equal(p.step(2), false); assert.deepEqual(m.sample(2), REST_POSE);
  m.configure({ ...DEFAULT_MOTION, strength: 2, bulge: 14 }, true, true, 3); assert.equal(m.sample(3).active, false);
});
