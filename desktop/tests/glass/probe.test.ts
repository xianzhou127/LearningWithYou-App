import test from 'node:test';
import assert from 'node:assert/strict';
import { capsuleDistance, clampAnchor, contained, localGeometry, presentedGeometry, regionUV, screenLightPosition } from '../../glass/geometry';
import { makeSimulation } from './simulated';
import { primaryAction } from '../../learning-view';
import { allowCapturePermission } from '../../glass/permission';
import { FrameScheduler } from '../../glass/frame-scheduler';
import { DEFAULT_MATERIAL, patchMaterial } from '../../glass/material-settings';
import { distanceLight } from '../../glass/distance-light';
import { ELEVATION_PAD } from '../../glass/elevation';

test('elevation controls preserve saved values and confine the maximum exterior support', () => {
  const old = { fresnelStrength: .28, shadowStrength: .24, blurSigma: .5, frostSigma: 6, frostWeightStatus: .9, edgeWidth: 7, tintStrength: 0 };
  const migrated = patchMaterial(DEFAULT_MATERIAL, old);
  for (const [key, value] of Object.entries(old)) assert.equal(migrated[key as keyof typeof migrated], value);
  const capped = patchMaterial(migrated, { shadowSpread: 100, fresnelRange: 100, fresnelHardness: 100 });
  assert.ok(capped.shadowSpread * 3 + 2.5 < ELEVATION_PAD + 6);
  assert.ok(capped.fresnelRange < 20); assert.equal(capped.fresnelHardness, 1);
  assert.equal(patchMaterial(capped, { elevation: false }).elevation, false);
});

test('material IPC rejects non-finite and unknown data and confines sampling to padded ROI', () => {
  const next = patchMaterial(DEFAULT_MATERIAL, { refractionPx: 100, dispersionPx: 100, blurSigma: -1, highlight: false, debugView: 'highlight' });
  assert.equal(next.refractionPx, 8); assert.equal(next.blurSigma, .5);
  assert.equal(next.dispersionPx, 1.5);
  assert.ok(next.refractionPx + next.dispersionPx + 12 < 24); assert.equal(next.highlight, false);
  assert.equal(DEFAULT_MATERIAL.highlight, true);
  const frost = patchMaterial(DEFAULT_MATERIAL, { frostSigma: 50, frostThreshold: -1, blurSigma: .8, tintStrength: 0 });
  assert.equal(frost.frostSigma, 6); assert.equal(frost.frostThreshold, .05);
  assert.equal(frost.blurSigma, .8); assert.equal(frost.tintStrength, 0);
  assert.equal(patchMaterial(frost, { adaptiveFrost: false }).adaptiveFrost, false);
  assert.equal(patchMaterial(DEFAULT_MATERIAL, { lightBalance: 100 }).lightBalance, 1);
  assert.equal(patchMaterial(DEFAULT_MATERIAL, { lightBalance: -100 }).lightBalance, 0);
  for (const value of [NaN, Infinity, '3']) assert.throws(() => patchMaterial(DEFAULT_MATERIAL, { highlightStrength: value }));
  for (const value of [{ monitorId: 'other' }, { highlight: 1 }, { debugView: 'fake' }, { constructor: {} }]) assert.throws(() => patchMaterial(DEFAULT_MATERIAL, value));
  assert.deepEqual(patchMaterial(DEFAULT_MATERIAL, JSON.parse(JSON.stringify(DEFAULT_MATERIAL))), DEFAULT_MATERIAL);
});

test('version 10 saved controls migrate without losing operator values or disabling added optics', () => {
  // Older files do not contain the new controls. They keep the user's exact
  // brightness/blur/geometry values and acquire only the new default fields.
  const saved = { highlightStrength: 2.22, highlightWidth: 2.45, lightAngle: 135, lowerShade: .5, contourStrength: .15, shadowStrength: .2, refractionPx: 6, blurSigma: 2.5, tintStrength: 1, highlight: true, refraction: true, debugView: 'normal' };
  const migrated = patchMaterial(DEFAULT_MATERIAL, JSON.parse(JSON.stringify(saved)));
  for (const [key, value] of Object.entries(saved)) assert.equal(migrated[key as keyof typeof migrated], value);
  assert.equal(migrated.dualLight, true); assert.equal(migrated.dispersion, true);
  assert.equal(migrated.oppositeHighlight, 1); assert.equal(migrated.dispersionPx, .65);
  assert.equal(migrated.lightBalance, .65); assert.equal(migrated.screenLight, true);
  assert.equal(migrated.planoLens, true);
  assert.equal(migrated.centerBalance, true);
  assert.equal(migrated.adaptiveText, true);
  assert.equal(migrated.distanceEffect, 1); assert.equal(migrated.lightHeight, .45); assert.equal(migrated.lightRadius, .28);
  const compared = patchMaterial(migrated, { dualLight: false, dispersion: false });
  assert.equal(compared.highlightStrength, 2.22); assert.equal(compared.refractionPx, 6);
});

test('video and input requests share one commit; latest input wins and stop cancels pending work', () => {
  let scheduled: FrameRequestCallback | null = null, nextId = 0, input = 0;
  const frames: number[] = [];
  const scheduler = new FrameScheduler(() => {
    frames.push(input);
    // Input preparation marks geometry dirty inside this same frame.
    scheduler.schedule();
  }, callback => { assert.equal(scheduled, null); scheduled = callback; return ++nextId; }, () => { scheduled = null; });
  scheduler.schedule(); input = 10; scheduler.schedule(); input = 20; scheduler.schedule();
  assert.equal(nextId, 1);
  const callback = scheduled! as FrameRequestCallback; scheduled = null; callback(100);
  assert.deepEqual(frames, [20]); assert.equal(scheduled, null);
  scheduler.schedule(); scheduler.stop(); assert.equal(scheduled, null); assert.equal(frames.length, 1);
  scheduler.schedule(); assert.equal(nextId, 3);
});
test('144 Hz callbacks paced at 60 Hz retain phase and never replay a backlog after a stall', () => {
  let pending: FrameRequestCallback | null = null, frames = 0;
  const scheduler = new FrameScheduler(() => { frames++; }, callback => { pending = callback; return 1; }, () => { pending = null; });
  scheduler.setLimit(60);
  for (let tick = 0; tick < 720; tick++) {
    scheduler.schedule(); const callback = pending! as FrameRequestCallback; pending = null; callback(tick * 1000 / 144);
  }
  assert.ok(frames >= 299 && frames <= 301, String(frames));
  const prior = frames;
  scheduler.schedule(); const callback = pending! as FrameRequestCallback; pending = null; callback(7000);
  assert.equal(frames, prior + 1); assert.equal(pending, null);
  scheduler.stop(); scheduler.setLimit(0); scheduler.schedule(); const resumed = pending! as FrameRequestCallback; pending = null; resumed(7001);
  assert.equal(frames, prior + 2);
});
test('display bootstrap permission rejects microphone, camera, other windows and disabled capture', () => {
  assert.equal(allowCapturePermission(true, true, 'media', []), true);
  assert.equal(allowCapturePermission(true, true, 'media', ['audio']), false);
  assert.equal(allowCapturePermission(true, true, 'media', ['video']), false);
  assert.equal(allowCapturePermission(true, true, 'media'), false);
  assert.equal(allowCapturePermission(false, true, 'media', []), false);
  assert.equal(allowCapturePermission(true, false, 'display-capture'), false);
});
test('physical pixel mapping preserves monitor origin and actual video ratio', () => {
  const g = { window: { x: 1500, y: 100, width: 321, height: 52 }, display: { x: 1372, y: 0, width: 1544, height: 1029 }, scale: 1.4, valid: true };
  const uv = regionUV(g, 16);
  assert.equal(uv[0] * 2160, (1500 - 1372 - 16) / 1544 * 2160);
  assert.equal(uv[1] * 1440, 84 / 1029 * 1440);
  assert.equal(regionUV({ ...g, display: { ...g.display, x: -1544 }, window: { ...g.window, x: -1000 } })[0], 480 / 1544);
});

test('screen light uses the presented DIP position, upward shader Y, and is finite at screen centre', () => {
  const display = { x: 1372, y: 0, width: 1544, height: 1029 };
  const window = { x: 1983.5, y: 488.5, width: 321, height: 52 };
  const centre = { display, window, scale: 1.4, valid: true };
  const point = screenLightPosition(centre);
  assert.deepEqual(point.slice(0, 2), [0, 0]); assert.ok(point[2] > 0);
  const upperLeft = { ...centre, window: { ...window, x: window.x - 200, y: window.y - 100 } };
  assert.deepEqual(screenLightPosition(upperLeft).slice(0, 2), [200, -100]);
  const lowerRight = { ...centre, window: { ...window, x: window.x + 200, y: window.y + 100 } };
  assert.deepEqual(screenLightPosition(lowerRight).slice(0, 2), [-200, 100]);
  const translated = { ...upperLeft, scale: 2, display: { ...display, x: display.x - 4000, y: 700 }, window: { ...upperLeft.window, x: upperLeft.window.x - 4000, y: upperLeft.window.y + 700 } };
  assert.deepEqual(screenLightPosition(translated), screenLightPosition(upperLeft));
});
test('SDF hit test excludes transparent corners and shadow but includes actual buttons', () => {
  assert.ok(capsuleDistance(160, 26) < 0);
  assert.ok(capsuleDistance(5, 26) > 0);
  assert.ok(capsuleDistance(8, 8) > 0);
  assert.ok(capsuleDistance(210, 26) < 0);
  assert.equal(capsuleDistance(160, 6), 0);
  assert.equal(contained({ x: -1, y: 0, width: 321, height: 52 }, { x: 0, y: 0, width: 1920, height: 1080 }), false);
});

test('finite source has no centre singularity and energy/angular size decrease along a screen ray', () => {
  const centre = { display: { x: 1372, y: 0, width: 1544, height: 1029 }, window: { x: 1983.5, y: 488.5, width: 321, height: 52 }, scale: 1.4, valid: true };
  const values = [0, 100, 300, 600].map(dx => distanceLight({ ...centre, window: { ...centre.window, x: centre.window.x + dx } }, DEFAULT_MATERIAL));
  assert.equal(values[0].relativeEnergy, 1);
  for (let i = 1; i < values.length; i++) {
    assert.ok(values[i].relativeEnergy < values[i - 1].relativeEnergy);
    assert.ok(values[i].angularRadiusDeg < values[i - 1].angularRadiusDeg);
  }
  const rotated = distanceLight({ ...centre, window: { ...centre.window, y: centre.window.y + 300 } }, DEFAULT_MATERIAL);
  assert.equal(rotated.relativeEnergy, values[2].relativeEnergy);
  assert.equal(rotated.angularRadiusDeg, values[2].angularRadiusDeg);
  for (const value of Object.values(values[0])) assert.ok(Number.isFinite(value));
  assert.equal(distanceLight(centre, { ...DEFAULT_MATERIAL, screenLight: false }).blend, 0);
  assert.equal(distanceLight(centre, { ...DEFAULT_MATERIAL, distanceEffect: 0 }).blend, 0);
});

test('bounded source radius never intersects the maximum 12 DIP glass cap, even on small displays', () => {
  const settings = patchMaterial(DEFAULT_MATERIAL, { lightHeight: -20, lightRadius: 10, distanceEffect: 10 });
  assert.equal(settings.lightHeight, .12); assert.equal(settings.lightRadius, .65); assert.equal(settings.distanceEffect, 1);
  const light = distanceLight({ display: { x: -4000, y: -2000, width: 321, height: 52 }, window: { x: -4000, y: -2000, width: 321, height: 52 }, scale: 2, valid: true }, settings);
  assert.equal(light.height, 80); assert.ok(light.height - light.radius > 12);
});
test('position-only redraw uses current origin even when main IPC position is stale', () => {
  const g = { window: { x: 1400, y: 200, width: 321, height: 52 }, display: { x: 1372, y: 0, width: 1544, height: 1029 }, scale: 1.4, valid: true, clientOffset: { x: 2, y: 3 } };
  const updated = localGeometry(g, 1800, 250);
  assert.equal(updated.window.x, 1802); assert.equal(updated.window.y, 253);
  assert.equal(regionUV(updated)[0], (1802 - 1372 - 64) / 1544);
  assert.equal(localGeometry(g, 1350, 0).valid, false);
});
test('fixed host uses the visible local placement, not the last IPC anchor, at monitor edges', () => {
  const g = { window: { x: 1872, y: 100, width: 321, height: 52 }, display: { x: 1372, y: 0, width: 1544, height: 1029 }, scale: 1.4, valid: true, fixedHost: true, anchor: { x: 500, y: 100 }, clientOffset: { x: 500, y: 100 } };
  const host = { width: 1544, height: 1029 };
  for (const point of [{ x: -30, y: -30 }, { x: 2000, y: 2000 }, { x: 130.25, y: 370.5 }]) {
    const anchor = clampAnchor(point, host);
    const frame = presentedGeometry(g, anchor, 1372, 0);
    assert.equal(frame.valid, true);
    assert.equal(frame.window.x - g.display.x, anchor.x);
    assert.equal(frame.window.y - g.display.y, anchor.y);
    assert.equal(regionUV(frame)[0], (anchor.x - 64) / 1544);
  }
  assert.deepEqual(clampAnchor({ x: 2000, y: 2000 }, host), { x: 1223, y: 977 });
  assert.deepEqual(clampAnchor({ x: -1, y: -1 }, host), { x: 0, y: 0 });
});
test('real DesktopSession / toolbar mapping handles four states and duplicate clicks', async () => {
  const { session, counts } = makeSimulation(() => {}, 10);
  await session.select({ id: 'test', kind: 'window', name: 'simulated' });
  assert.equal(session.snapshot().simulated, true);
  for (let round = 0; round < 4; round++) {
    const ready = session.snapshot(); assert.equal(primaryAction(ready).intent, 'start');
    const results = await Promise.all(Array.from({ length: 8 }, () => session.start(ready.revision)));
    assert.equal(results.filter(r => r.ok).length, 1);
    assert.equal(session.snapshot().phase, 'recording'); assert.equal(primaryAction(session.snapshot()).intent, 'check');
    let processingDisabled = false;
    const off = session.subscribe(() => { if (session.snapshot().phase === 'processing') processingDisabled = primaryAction(session.snapshot()).disabled; });
    const rec = session.snapshot(); const pending = session.check(rec.revision);
    assert.equal((await session.check(rec.revision)).ok, false);
    await pending; off(); assert.equal(processingDisabled, true); assert.equal(session.snapshot().phase, 'feedback');
  }
  assert.deepEqual([counts.start, counts.finish, counts.analyze], [4, 4, 4]);
  await session.quit();
});
test('interrupted simulation does not publish late feedback; hiding preserves one session', async () => {
  const { session } = makeSimulation(() => {}, 30);
  await session.select({ id: 'test', kind: 'window', name: 'simulated' }); await session.start(session.snapshot().revision);
  session.setHidden(true); assert.equal(session.snapshot().recording, true);
  let cancelled: Promise<unknown> | null = null;
  let armed = true;
  const off = session.subscribe(() => { if (armed && session.snapshot().phase === 'processing') { armed = false; cancelled = session.cancel(); } });
  const checking = session.check(session.snapshot().revision);
  await checking; await cancelled; off();
  assert.equal(session.snapshot().phase, 'ready'); assert.equal(session.snapshot().feedback, null);
  assert.equal(session.snapshot().source?.id, 'test'); await session.quit();
});
