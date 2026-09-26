import { SIZE, type Geometry, type Rect } from './contract';
import { desktopGeometry } from './desktop-layout';
import { adjacentBounds } from '../window-placement';

export type MenuPlacement = { bounds: Rect; scale: number; direction: 'up' | 'down' };
// Main-process committed hits and renderer-local drag presentation share this
// calculation. Work areas are inventory metadata, never queried per pointer.
export function menuPlacementFor(base: Geometry, height: number): MenuPlacement {
  const monitor = base.desktop!.monitors.find(m => m.id === base.activeMonitor)!;
  const scale = base.scale, area = monitor.workAreaPixels ?? monitor.pixels;
  const placement = adjacentBounds({ x: base.window.x + SIZE.inset, y: base.window.y + SIZE.inset, width: SIZE.capsuleWidth, height: SIZE.capsuleHeight },
    { x: area.x / scale, y: area.y / scale, width: area.width / scale, height: area.height / scale }, { width: 252, height });
  const b = placement.bounds;
  return { bounds: { x: b.x * scale, y: b.y * scale, width: b.width * scale, height: b.height * scale }, scale, direction: placement.direction };
}
export function menuGeometry(base: Geometry, placement: MenuPlacement): Geometry | null {
  if (!base.desktop) return null;
  const b = placement.bounds, g = desktopGeometry(base.desktop, b);
  // The placement and capture use the same physical rectangle, including DPR.
  return { ...g, window: { x: b.x / g.scale, y: b.y / g.scale, width: b.width / g.scale, height: b.height / g.scale } };
}
export function roundedMenuHit(x: number, y: number, bounds: Rect, radius: number) {
  const r = Math.min(radius, bounds.width / 2, bounds.height / 2);
  const qx = Math.abs(x - bounds.x - bounds.width / 2) - bounds.width / 2 + r;
  const qy = Math.abs(y - bounds.y - bounds.height / 2) - bounds.height / 2 + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) <= r;
}
