import test from 'node:test';
import assert from 'node:assert/strict';
import { menuPlacementFor, menuGeometry, roundedMenuHit } from '../glass/menu-geometry';
import { desktopGeometry, materialMonitors, prepareSampling, union, type DesktopMonitor } from '../glass/desktop-layout';

test('menu placement uses physical desktop geometry at mixed DPI and negative origins', () => {
  const monitors: DesktopMonitor[] = [
    { id: 'a', name: 'left', scale: 1.25, bounds: { x: -1600, y: 0, width: 1600, height: 900 }, pixels: { x: -2000, y: 0, width: 2000, height: 1125 }, physical: { width: 2000, height: 1125 } },
    { id: 'b', name: 'right', scale: 2, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, pixels: { x: 0, y: 0, width: 3840, height: 2160 }, physical: { width: 3840, height: 2160 } },
  ];
  const base = desktopGeometry({ host: union(monitors.map(m => m.pixels)), monitors, position: { x: -400, y: 40 }, sampling: prepareSampling(monitors) });
  for (const monitor of monitors) {
    const b = { x: monitor.pixels.x + 40, y: 200, width: 252 * monitor.scale, height: 700 * monitor.scale };
    const g = menuGeometry(base, { bounds: b, scale: monitor.scale, direction: 'down' })!;
    assert.equal(g.scale, monitor.scale);
    assert.deepEqual({ x: g.window.x * g.scale, y: g.window.y * g.scale, width: g.window.width * g.scale, height: g.window.height * g.scale }, b);
    assert.ok(materialMonitors(g).some(m => m.id === monitor.id));
  }
  const seam = menuGeometry(base, { bounds: { x: -100, y: 200, width: 315, height: 337.5 }, scale: 1.25, direction: 'down' })!;
  assert.deepEqual(new Set(materialMonitors(seam).map(m => m.id)), new Set(['a', 'b']));
  assert.equal(base.window.height, 52);
});

test('rounded menu hit area excludes transparent corners and preserves interior and edge buttons', () => {
  for (const scale of [1, 1.25, 1.4, 1.5, 2, 3]) {
    const b = { x: -250 * scale, y: 60 * scale, width: 252 * scale, height: 280 * scale };
    assert.equal(roundedMenuHit(b.x, b.y, b, 16 * scale), false);
    assert.equal(roundedMenuHit(b.x + 8 * scale, b.y + 8 * scale, b, 16 * scale), true);
    assert.equal(roundedMenuHit(b.x + 126 * scale, b.y + 200 * scale, b, 16 * scale), true);
    assert.equal(roundedMenuHit(b.x - scale, b.y + 80 * scale, b, 16 * scale), false);
    assert.equal(roundedMenuHit(b.x + b.width + scale, b.y + 80 * scale, b, 16 * scale), false);
  }
});

test('menu tracks every drag anchor and respects physical work area at fractional DPR', () => {
  for (const scale of [1, 1.25, 1.4, 1.5, 2, 3]) {
    const pixels = { x: -1920 * scale, y: -100 * scale, width: 1920 * scale, height: 1080 * scale };
    const workAreaPixels = { ...pixels, height: pixels.height - 48 * scale };
    const monitor: DesktopMonitor = { id: 'm', name: 'm', bounds: pixels, pixels, workAreaPixels, scale, physical: pixels };
    const layout = { host: pixels, monitors: [monitor], position: { x: -1700 * scale, y: 0 } };
    let previous = menuPlacementFor(desktopGeometry(layout), 280);
    for (let i = 1; i <= 30; i++) {
      const g = desktopGeometry(layout, { x: layout.position.x + i * 5 * scale, y: i * 2 * scale });
      const p = menuPlacementFor(g, 280), capture = menuGeometry(g, p)!;
      assert.ok(Math.abs(p.bounds.x - previous.bounds.x - 5 * scale) < .001);
      assert.ok(Math.abs(p.bounds.y - previous.bounds.y - 2 * scale) < .001);
      assert.ok(Math.abs(capture.window.x * capture.scale - p.bounds.x) < .001);
      assert.equal(roundedMenuHit(p.bounds.x + p.bounds.width / 2, p.bounds.y + 20 * scale, p.bounds, 16 * scale), true);
      previous = p;
    }
    const edge = menuPlacementFor(desktopGeometry(layout, { x: -1000 * scale, y: 860 * scale }), 280);
    assert.equal(edge.direction, 'up'); assert.ok(edge.bounds.y + edge.bounds.height <= workAreaPixels.y + workAreaPixels.height);
  }
});
