import assert from 'node:assert/strict';
import test from 'node:test';
import { constrainDesktop, desktopGeometry, displayInGeometry, materialMonitors, union, type DesktopMonitor } from '../glass/desktop-layout';
import { regionUV } from '../glass/geometry';
import { decodeSettings } from '../glass/settings-store';
import { ACCEPTED_MATERIAL } from '../glass/presets';
const display = (id: string, x: number, y: number, width: number, height: number, scale: number): DesktopMonitor => ({ id, name: id, scale, pixels: { x, y, width, height }, bounds: { x: x / scale, y: y / scale, width: width / scale, height: height / scale }, physical: { width, height } });
test('automatic startup migrates old material files without replacing optical values; opt-out survives decode', () => {
  const raw = { schema: 1, application: 'LearningWithYou', kind: 'material', settings: { ...ACCEPTED_MATERIAL, blurSigma: .9 } };
  assert.equal((decodeSettings('material', raw).settings as typeof ACCEPTED_MATERIAL).blurSigma, .9);
  assert.equal((decodeSettings('material', raw) as { startupEnabled: boolean }).startupEnabled, true);
  assert.equal((decodeSettings('material', { ...raw, startupEnabled: false }) as { startupEnabled: boolean }).startupEnabled, false);
  assert.throws(() => decodeSettings('material', { ...raw, startupEnabled: 'true' }));
});
test('physical desktop layout supports negative origins, portrait and heterogeneous scale without multiplying origins', () => {
  const monitors = [display('left', -1080, -300, 1080, 1920, 1.5), display('main', 0, 0, 2560, 1440, 2)];
  const host = union(monitors.map(d => d.pixels));
  assert.deepEqual(host, { x: -1080, y: -300, width: 3640, height: 1920 });
  for (const [position, id, scale] of [[{ x: -600, y: 200 }, 'left', 1.5], [{ x: 500, y: 200 }, 'main', 2]] as const) {
    const g = desktopGeometry({ host, position, monitors });
    assert.equal(g.activeMonitor, id); assert.equal(g.scale, scale);
    const uv = regionUV(g, 0), m = monitors.find(m => m.id === id)!;
    assert.ok(Math.abs(uv[0] - (position.x - m.pixels.x) / m.pixels.width) < 1e-12);
    assert.equal(g.window.width * scale, 321 * scale);
  }
});
test('a cross-screen capsule samples intersecting sources; screens outside the ROI are not drawn', () => {
  const monitors = [display('a', -1920, 0, 1920, 1080, 1), display('b', 0, 0, 3840, 2160, 2), display('above', 0, -2160, 3840, 2160, 2)];
  const layout = { host: union(monitors.map(m => m.pixels)), position: { x: -180, y: 200 }, monitors };
  const g = desktopGeometry(layout);
  assert.deepEqual(materialMonitors(g).map(m => m.id), ['a', 'b']);
  assert.deepEqual(displayInGeometry(monitors[1], g), monitors[1].pixels);
  const next = desktopGeometry(layout, { x: 800, y: 400 });
  assert.deepEqual(materialMonitors(next).map(m => m.id), ['b']);
  assert.equal(displayInGeometry(monitors[1], next).width, 1920);
  assert.deepEqual(constrainDesktop({ x: -180, y: 200 }, monitors), { x: -180, y: 200 });
});
test('display removal and gaps keep the grip on a remaining display', () => {
  const monitors = [display('a', 500, 200, 1600, 900, 1.25)];
  const p = constrainDesktop({ x: -8000, y: 6000 }, monitors);
  assert.ok(p.x + 18 * 1.25 >= 500 && p.y + 26 * 1.25 < 1100);
});
