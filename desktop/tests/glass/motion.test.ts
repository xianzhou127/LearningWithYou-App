import test from 'node:test';
import assert from 'node:assert/strict';
import { MotionEngine, DEFAULT_MOTION, REST_POSE, patchMotion } from '../../glass/motion';
import { makeSimulation } from './simulated';
import { SAMPLE_PAD } from '../../glass/contract';
import { ELEVATION_PAD } from '../../glass/elevation';
import { FrameScheduler } from '../../glass/frame-scheduler';

// Keep the original strength-1 reference checks as well as the user-selected
// strength-5 production default and the explicit maximum-bound cases below.
const UNIT_MOTION = { ...DEFAULT_MOTION, strength: 1, liquid: false };
function unitEngine() { const engine = new MotionEngine(); engine.configure(UNIT_MOTION, false, true, 0); return engine; }

test('candidate8 retains strength 5 and bubble defaults', () => {
  assert.equal(DEFAULT_MOTION.strength, 5); assert.equal(DEFAULT_MOTION.liquid, true);
  const m = new MotionEngine(); m.press(2, true, 0); assert.equal(m.sample(60).scales[2], .85);
});

test('release flush commits the newest anchor/background once without waiting for a paced RAF', () => {
  let queued: FrameRequestCallback | null = null, latest = 0;
  const anchors: number[] = [];
  const frames = new FrameScheduler(() => anchors.push(latest), cb => { queued = cb; return 1; }, () => { queued = null; });
  frames.setLimit(60); frames.schedule(); latest = 90; frames.flush(3);
  assert.deepEqual(anchors, [90]); assert.equal(queued, null);
  frames.stop(); assert.deepEqual(anchors, [90]);
});

test('press interrupts from current value, reaches endpoints without queues or overshoot', () => {
  const m = unitEngine(); m.press(2, true, 0);
  assert.equal(m.sample(60).scales[2], .97);
  m.press(2, false, 60); const middle = m.sample(100).scales[2];
  m.press(2, true, 100); assert.equal(m.sample(100).scales[2], middle);
  for (let i = 0; i < 30; i++) { m.press(2, !!(i % 2), 120 + i * 7); assert.ok(m.sample(120 + i * 7).scales[2] >= .97); }
  m.cancel(400); assert.deepEqual(m.sample(650), REST_POSE);
});
test('focus/grab combine with limits, low-speed deformation returns to exact static geometry', () => {
  const m = unitEngine(); m.setFocus(true, 0); m.grab(true, 0); m.velocity(9000, 3000, 10);
  const p = m.sample(65); assert.ok(p.gain <= .16); assert.ok(p.shape[0] > 1);
  assert.ok(Math.max(...p.shape.slice(0, 2)) <= 1.01);
  // Maximum SDF expansion + refraction/dispersion + blur stay in the existing ROI.
  assert.ok(154.5 * .01 + .18 + .6 + 8 + 1.5 + 12 < SAMPLE_PAD);
  assert.ok(20 * .01 + .18 + .6 + .8 + 8 + 1.5 + 12 < SAMPLE_PAD);
  assert.ok((154.5 + 10 * 3 + 2.5 + .6) * .01 + .18 + .6 + 10 * 3 + 2.5 < ELEVATION_PAD + 6);
  m.sample(100); assert.deepEqual(m.sample(201).shape, [1, 1, 0, 0]);
  m.grab(false, 210); m.setFocus(false, 210); assert.deepEqual(m.sample(470), REST_POSE);
});

test('ordinary drag speed produces measurable outline strain; held grip changes elevation without moving anchor', () => {
  const m = unitEngine(); m.grab(true, 0); m.velocity(300, 0, 180);
  const held = m.sample(230);
  assert.equal(held.elevation, 1);
  assert.ok(held.shape[0] >= 1.005 && held.shape[0] <= 1.01);
  assert.deepEqual(held.scales, REST_POSE.scales);
  assert.deepEqual(held.offsetsY, REST_POSE.offsetsY);
  assert.equal(m.events.grab, 1); m.grab(false, 250); assert.equal(m.events.release, 1);
  assert.deepEqual(m.sample(501), REST_POSE);
});

test('focused strength-5 grip uses the full rise and fall without an early clamp, and reverses continuously', () => {
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, liquid: false, strength: 5 }, false, true, 0);
  m.setFocus(true, 0); assert.equal(m.sample(140).elevation, 2.25);
  m.grab(true, 200);
  assert.equal(m.sample(200).elevation, 2.25);
  assert.ok(Math.abs(m.sample(310).elevation - 3.625) < 1e-12); // Halfway through the 220ms rise.
  assert.ok(m.sample(400).elevation < 5); // Prior sum+clamp stopped rising early.
  assert.equal(m.sample(420).elevation, 5);
  m.grab(false, 500); assert.ok(Math.abs(m.sample(625).elevation - 3.625) < 1e-12);
  assert.equal(m.sample(750).elevation, 2.25); // 250ms fall to focused baseline.
  m.grab(true, 800); const partial = m.sample(880).elevation;
  m.grab(false, 880); assert.equal(m.sample(880).elevation, partial);
  const falling = m.sample(930).elevation; m.grab(true, 930);
  assert.equal(m.sample(930).elevation, falling);
  m.cancel(1000); m.setFocus(false, 1000); assert.deepEqual(m.sample(1251), REST_POSE);
});
test('focus/grab/state/feedback have separate finite presentation channels', () => {
  const m = unitEngine(); m.setFocus(true, 0);
  assert.equal(m.sample(140).elevation, .45);
  m.setFocus(false, 150); assert.deepEqual(m.sample(371), REST_POSE);
  m.snapshot({ phase: 'recording', sessionId: 1, roundId: 1, feedback: null }, 400);
  const entering = m.sample(490); assert.ok(entering.offsetsY[0] < -.5); assert.equal(entering.offsetsY[2], 0);
  m.snapshot({ phase: 'processing', sessionId: 1, roundId: 1, feedback: null }, 490);
  assert.equal(m.sample(490).offsetsY[0], entering.offsetsY[0]);
  assert.deepEqual(m.sample(680), REST_POSE);
  m.snapshot({ phase: 'feedback', sessionId: 1, roundId: 1, feedback: 'simulated' }, 700);
  const feedback = m.sample(880); assert.equal(feedback.scales[3], 1.06); assert.equal(feedback.offsetsY[3], -1.6);
  assert.deepEqual(m.sample(1061), REST_POSE);
});
test('reduced effects keep immediate press/focus, remove deformation, pulse and extra scheduling', () => {
  const m = unitEngine(); m.configure(UNIT_MOTION, true, true, 0);
  m.press(2, true, 1); m.grab(true, 1); m.setFocus(true, 1); m.velocity(900, 300, 2);
  m.snapshot({ phase: 'feedback', sessionId: 1, roundId: 1, feedback: 'mock' }, 2);
  const p = m.sample(2); assert.equal(p.scales[2], .97); assert.equal(p.scales[3], 1);
  assert.equal(p.gain, .1); assert.equal(p.active, false); assert.deepEqual(p.shape, [1, 1, 0, 0]);
  m.cancel(3); assert.equal(m.sample(3).scales[2], 1);
});
test('hidden/off/failed capture clear tracks; feedback never replays on show/refocus', () => {
  const m = new MotionEngine(); m.press(2, true, 0); m.grab(true, 0);
  m.configure(DEFAULT_MOTION, false, false, 20);
  const feedback = { phase: 'feedback' as const, sessionId: 1, roundId: 1, feedback: 'mock' };
  m.snapshot(feedback, 30); assert.deepEqual(m.sample(30), REST_POSE);
  m.configure(DEFAULT_MOTION, false, true, 40); m.snapshot(feedback, 40); assert.equal(m.notifications, 0);
  m.press(2, true, 50); m.availability(false); assert.deepEqual(m.sample(70), REST_POSE);
  m.configure({ ...DEFAULT_MOTION, enabled: false }, false, true, 80); m.press(2, true, 90); assert.deepEqual(m.sample(100), REST_POSE);
});
test('controls are finite and bounded; stage comparison does not affect business state', () => {
  assert.deepEqual(patchMotion(DEFAULT_MOTION, { strength: 400, duration: 0, stage: 2 }), { ...DEFAULT_MOTION, strength: 5, duration: .75, stage: 2 });
  for (const patch of [{ strength: NaN }, { duration: Infinity }, { stage: 5 }, { enabled: 1 }, { material: {} }]) assert.throws(() => patchMotion(DEFAULT_MOTION, patch));
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, stage: 1 }, false, true, 0);
  m.setFocus(true, 0); m.grab(true, 0); m.velocity(5000, 0, 1); assert.deepEqual(m.sample(150), REST_POSE);
});
test('strength 5 amplifies every motion channel and still cancels, settles and respects reduced motion', () => {
  const m = new MotionEngine(), settings = patchMotion(DEFAULT_MOTION, { strength: 5, liquid: false });
  m.configure(settings, false, true, 0); m.setFocus(true, 0); m.grab(true, 0); m.press(2, true, 0);
  m.velocity(1000, 0, 180); const p = m.sample(230);
  assert.equal(p.elevation, 5); assert.equal(p.gain, .8); assert.equal(p.shape[0], 1.05);
  assert.equal(p.scales[2], .85); assert.ok(Math.abs(p.localLight[0] - .35) < 1e-12);
  // Refraction is inward. Only up to 1.5 DIP spectral offset can point outward;
  // expanded contour + outer blur taps remain within the original sample ROI.
  assert.ok((154.5 + 3) * 1.05 + .9 - 160.5 + 1.5 + 12 < SAMPLE_PAD);
  assert.ok((20 + 3) * 1.05 + 4 + .9 - 26 + 1.5 + 12 < SAMPLE_PAD);
  assert.ok((154.5 + 3 + 2.5 + 30) * 1.05 + .9 - 154.5 < ELEVATION_PAD + 6);
  assert.ok((20 + 3 + 11.5 + 30) * 1.05 + .9 + 4 - 20 < ELEVATION_PAD + 6);
  m.cancel(240); m.setFocus(false, 240); assert.deepEqual(m.sample(491), REST_POSE);
  m.snapshot({ phase: 'recording', sessionId: 1, roundId: 1, feedback: null }, 500);
  assert.equal(m.sample(500).offsetsY[0], -7.5); assert.equal(m.sample(500).offsetsY[2], 0);
  m.snapshot({ phase: 'feedback', sessionId: 1, roundId: 1, feedback: 'mock' }, 700);
  assert.equal(m.sample(880).scales[3], 1.3); assert.equal(m.sample(880).offsetsY[3], -7);
  assert.deepEqual(m.sample(1061), REST_POSE);
  m.configure(settings, true, true, 1100); m.press(2, true, 1101); m.grab(true, 1101); m.velocity(1000, 0, 1101);
  const reduced = m.sample(1101); assert.deepEqual(reduced.shape, REST_POSE.shape); assert.equal(reduced.elevation, 0); assert.equal(reduced.active, false);
  m.configure(settings, false, false, 1102); assert.deepEqual(m.sample(1102), REST_POSE);
});
test('bubble grows at the grip; its light has energy and regrab redirects without a jump', () => {
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, 0);
  m.contactPoint(12, 18, 0); m.grab(true, 0);
  const early = m.sample(80), later = m.sample(160);
  assert.deepEqual(early.contact.slice(0, 2), [12, 18]); assert.ok(early.contact[2] > .3 && early.contact[2] < later.contact[2]);
  assert.ok(later.ripple[0] > early.ripple[0]); assert.ok(later.energy > 0 && later.ripple[1] > 0);
  m.grab(false, 160); const released = m.sample(180);
  m.contactPoint(24, 30, 180); m.grab(true, 180); const interrupted = m.sample(180);
  assert.deepEqual(interrupted.contact, released.contact); assert.deepEqual(interrupted.ripple, released.ripple);
  assert.equal(interrupted.elevation, released.elevation);
  m.cancel(200); assert.deepEqual(m.sample(701), REST_POSE);
});
test('contact-driven pull retains momentum on reversal without scaling text or moving the real anchor', () => {
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, 0); m.grab(true, 0);
  m.velocity(1000, 0, 250); const right = m.sample(300); assert.ok(right.tug[0] > 0 && right.tug[0] <= 17.4);
  m.velocity(-1000, 0, 300); assert.deepEqual(m.sample(300).tug, right.tug);
  const continuing = m.sample(310); assert.ok(continuing.tug[0] > right.tug[0]);
  m.velocity(-1000, 0, 450); const left = m.sample(500); assert.ok(left.tug[0] < 0);
  assert.deepEqual(left.scales, REST_POSE.scales); assert.deepEqual(left.offsetsY, REST_POSE.offsetsY);
  assert.deepEqual(left.shape, REST_POSE.shape);
  m.velocity(0, 0, 501); m.grab(false, 502); assert.deepEqual(m.sample(1503), REST_POSE);
});
test('released bubble oscillates several times with energy loss; cancellation does not bounce', () => {
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, 0); m.grab(true, 0); m.sample(800);
  m.grab(false, 800); const samples = Array.from({ length: 999 }, (_, i) => m.sample(801 + i).inflation);
  const signs = samples.filter(x => x !== 0).map(Math.sign);
  assert.ok(signs.filter((v, i) => i > 0 && v !== signs[i - 1]).length >= 4);
  assert.ok(Math.min(...samples) < -3 && Math.min(...samples) >= -4.5);
  assert.deepEqual(m.sample(1801), REST_POSE);
  m.grab(true, 1900); m.sample(2700); m.cancel(2700);
  for (let t = 2700; t <= 3200; t++) assert.ok(m.sample(t).inflation >= 0);
  assert.deepEqual(m.sample(3201), REST_POSE);
});
test('maximum tuning ranges fit the expanded desktop sampling ROI', () => {
  // Radius + maximum lift + global/local inflation + vertical remote pull +
  // spectral offset + outer Gaussian taps; inward refraction does not add here.
  assert.ok((20 + 2.25 * .6 + 14 * 1.4 + 1.4) * 1.18 + 2.25 * .8 + 22 * 1.45 * .75 + 1.5 + 12 < 26 + SAMPLE_PAD);
  assert.ok(154.5 + 2.25 * .6 + 14 * 1.4 + 1.4 + 22 * 1.45 + 1.5 + 12 < 160.5 + SAMPLE_PAD);
  const m = new MotionEngine(); m.grab(true, 0);
  for (let t = 10; t < 1500; t += 10) {
    m.velocity(t % 20 ? 10000 : -10000, 10000, t);
    const p = m.sample(t);
    assert.ok(Math.abs(p.contact[2]) <= 1.4 && Math.abs(p.tug[0]) <= 17.4 && Math.abs(p.tug[1]) <= 13.05);
  }
  m.grab(false, 1500); assert.deepEqual(m.sample(2501), REST_POSE);
});
test('duration changes the bubble clock without changing the held size or light energy', () => {
  const poses = [.75, 1.25].map(duration => {
    const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, duration }, false, true, 0); m.grab(true, 0);
    return m.sample(801 * duration);
  });
  assert.deepEqual(poses[0], poses[1]); assert.equal(poses[0].energy, 1); assert.equal(poses[0].active, false);
});
test('feedback arc converges once and liquid-off/reduced/hidden removes every new channel', () => {
  const m = new MotionEngine(); m.configure({ ...DEFAULT_MOTION, strength: 5 }, false, true, 0);
  const s = { phase: 'feedback' as const, sessionId: 3, roundId: 4, feedback: 'mock' }; m.snapshot(s, 0);
  const a = m.sample(90), b = m.sample(180); assert.ok(a.feedbackRing[0] > b.feedbackRing[0]); assert.equal(b.feedbackRing[1], .5);
  m.snapshot(s, 180); assert.deepEqual(m.sample(180).feedbackRing, b.feedbackRing); assert.equal(m.notifications, 1);
  for (const [liquid, reduced, visible] of [[false, false, true], [true, true, true], [true, false, false]]) {
    m.configure({ ...DEFAULT_MOTION, liquid, strength: 5 }, reduced, visible, 400);
    m.contactPoint(10, 14, 400); m.grab(true, 400); m.velocity(1000, 0, 450);
    const pose = m.sample(500); assert.deepEqual(pose.contact, REST_POSE.contact); assert.deepEqual(pose.tug, [0, 0]);
    assert.deepEqual(pose.ripple, [0, 0]); assert.deepEqual(pose.feedbackRing, [0, 0]);
    assert.equal(pose.energy, 0);
  }
  m.availability(false); assert.deepEqual(m.sample(800), REST_POSE);
});
test('real Snapshot four states: rapid Action is unique and feedback pulse is once per round', async () => {
  const { session, counts } = makeSimulation(() => {}, 20), m = unitEngine();
  let now = 0; const phases = new Set<string>();
  const off = session.subscribe(() => { phases.add(session.snapshot().phase); m.snapshot(session.snapshot(), now); });
  await session.select({ id: 'simulation', kind: 'window', name: 'simulation' });
  for (let round = 0; round < 3; round++) {
    const revision = session.snapshot().revision;
    const starts = await Promise.all(Array.from({ length: 10 }, () => session.start(revision)));
    assert.equal(starts.filter(r => r.ok).length, 1);
    now += 200; assert.equal(m.sample(now).active, false);
    const rec = session.snapshot(); const processing = session.check(rec.revision);
    assert.equal((await session.check(rec.revision)).ok, false);
    await processing; assert.equal(m.notifications, round + 1);
    assert.equal(m.sample(now + 180).scales[3], 1.06);
    now += 400; m.snapshot(session.snapshot(), now); assert.equal(m.sample(now).scales[3], 1);
    m.setFocus(true, now); m.snapshot(session.snapshot(), now); assert.equal(m.notifications, round + 1);
    m.setFocus(false, now); now += 250;
  }
  assert.ok(['ready', 'recording', 'processing', 'feedback'].every(p => phases.has(p)));
  assert.deepEqual([counts.start, counts.finish, counts.analyze], [3, 3, 3]); off(); await session.quit();
});
test('cancel during processing prevents late Snapshot animation, no future replay', async () => {
  const { session } = makeSimulation(() => {}, 35), m = new MotionEngine();
  const off = session.subscribe(() => m.snapshot(session.snapshot(), 0));
  await session.select({ id: 'simulation', kind: 'window', name: 'simulation' });
  await session.start(session.snapshot().revision); const pending = session.check(session.snapshot().revision);
  await session.cancel(); await pending;
  assert.equal(session.snapshot().feedback, null); assert.equal(m.notifications, 0); assert.deepEqual(m.sample(1000), REST_POSE);
  off(); await session.quit();
});
