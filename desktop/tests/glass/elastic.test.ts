import test from 'node:test';
import assert from 'node:assert/strict';
import { ElasticMode } from '../../glass/elastic';

test('free oscillation loses mechanical energy and successive peaks decay', () => {
  const spring = new ElasticMode(); spring.force(1, 0, 1); spring.sample(800); spring.force(0, 800, 1, true);
  let energy = Infinity, lastVelocity = 0; const peaks: number[] = [];
  for (let t = 800; t < 1800; t += 2) {
    const s = spring.sample(t); assert.ok(s.energy <= energy + 1e-8); energy = s.energy;
    if (lastVelocity * s.velocity < 0) peaks.push(Math.abs(s.value)); lastVelocity = s.velocity;
  }
  assert.ok(peaks.length >= 4);
  peaks.forEach((p, i) => { if (i) assert.ok(p < peaks[i - 1] * .5); });
  assert.deepEqual(spring.sample(1800), { value: 0, velocity: 0, energy: 0, active: false });
});
test('reversing force preserves position and velocity; rapid pumping remains bounded', () => {
  const spring = new ElasticMode(); spring.force(1, 0, 1); const before = spring.sample(80);
  spring.force(-1, 80, 1); const after = spring.sample(80);
  assert.equal(before.value, after.value); assert.equal(before.velocity, after.velocity);
  for (let i = 0; i < 350; i++) {
    const t = 100 + i * 7; spring.force(i % 2 ? -1 : 1, t, 1);
    const s = spring.sample(t); assert.ok(Number.isFinite(s.energy) && Math.abs(s.value) <= 1.45 && Math.abs(s.velocity) <= 32);
  }
  spring.force(0, 2600, 1, true); assert.equal(spring.sample(3601).active, false);
});
test('the same elapsed time gives the same motion at different render frequencies', () => {
  const sparse = new ElasticMode(), dense = new ElasticMode();
  sparse.force(1, 0, 1); dense.force(1, 0, 1);
  for (let t = 0; t < 400; t += 1000 / 144) dense.sample(t);
  const a = sparse.sample(400), b = dense.sample(400);
  assert.ok(Math.abs(a.value - b.value) < 1e-10 && Math.abs(a.velocity - b.velocity) < 1e-10);
  dense.cancel(400, 0); assert.deepEqual(dense.sample(400), { value: 0, velocity: 0, energy: 0, active: false });
});
