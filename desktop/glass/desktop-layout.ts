import { SAMPLE_PAD, SIZE, type Geometry, type Monitor, type Rect } from './contract';
import type { DisplayAdaptation } from './display-adaptation';

export type DesktopMonitor = Monitor & { pixels: Rect; workAreaPixels?: Rect; adaptation?: DisplayAdaptation; profileHash?: string };
export type SamplingProfiles = Record<string, Record<string, Rect>>;
export type DesktopLayout = { host: Rect; position: { x: number; y: number }; monitors: DesktopMonitor[]; sampling?: SamplingProfiles };
export function prepareSampling(monitors: DesktopMonitor[]): SamplingProfiles {
  return Object.fromEntries(monitors.map(target => [target.id, Object.fromEntries(monitors.map(source => [source.id, { x: source.pixels.x / target.scale, y: source.pixels.y / target.scale, width: source.pixels.width / target.scale, height: source.pixels.height / target.scale }]))]));
}
export const intersection = (a: Rect, b: Rect): Rect | null => {
  const x = Math.max(a.x, b.x), y = Math.max(a.y, b.y), right = Math.min(a.x + a.width, b.x + b.width), bottom = Math.min(a.y + a.height, b.y + b.height);
  return right > x && bottom > y ? { x, y, width: right - x, height: bottom - y } : null;
};
export function union(rects: Rect[]): Rect {
  const x = Math.min(...rects.map(r => r.x)), y = Math.min(...rects.map(r => r.y));
  return { x, y, width: Math.max(...rects.map(r => r.x + r.width)) - x, height: Math.max(...rects.map(r => r.y + r.height)) - y };
}
export function nearestMonitor(point: { x: number; y: number }, monitors: DesktopMonitor[]) {
  return monitors.reduce((best, m) => {
    const distance = (r: Rect) => Math.hypot(Math.max(r.x - point.x, 0, point.x - r.x - r.width), Math.max(r.y - point.y, 0, point.y - r.y - r.height));
    return distance(m.pixels) < distance(best.pixels) ? m : best;
  });
}
export function constrainDesktop(position: { x: number; y: number }, monitors: DesktopMonitor[]) {
  const monitor = nearestMonitor({ x: position.x + 18, y: position.y + 26 }, monitors), s = monitor.scale, r = monitor.pixels;
  const grip = { x: position.x + 18 * s, y: position.y + 26 * s };
  if (monitors.some(m => grip.x >= m.pixels.x && grip.x < m.pixels.x + m.pixels.width && grip.y >= m.pixels.y && grip.y < m.pixels.y + m.pixels.height)) return position;
  // Keep the drag handle reachable. The rest of the capsule may straddle screens.
  return { x: Math.max(r.x - 9 * s, Math.min(r.x + r.width - 27 * s, position.x)), y: Math.max(r.y - 6 * s, Math.min(r.y + r.height - 40 * s, position.y)) };
}
export function desktopGeometry(layout: DesktopLayout, position = layout.position): Geometry {
  const monitor = nearestMonitor({ x: position.x + 18, y: position.y + 26 }, layout.monitors), scale = monitor.scale;
  const rect = (r: Rect) => ({ x: r.x / scale, y: r.y / scale, width: r.width / scale, height: r.height / scale });
  const inverse = monitor.adaptation?.inverseScale ?? 1 / scale;
  return { window: { x: position.x * inverse, y: position.y * inverse, width: SIZE.width, height: SIZE.height }, display: monitor.adaptation?.display ?? rect(monitor.pixels), scale, valid: true,
    fixedHost: true, desktop: { ...layout, position }, activeMonitor: monitor.id };
}
export function materialMonitors(g: Geometry) {
  if (!g.desktop) return [];
  const s = g.scale, plan = g.window.width === SIZE.width && g.window.height === SIZE.height ? g.desktop.monitors.find(m => m.id === g.activeMonitor)?.adaptation?.samplePixels : undefined;
  const sample = { x: g.window.x * s - (plan?.pad ?? SAMPLE_PAD * s), y: g.window.y * s - (plan?.pad ?? SAMPLE_PAD * s), width: plan?.width ?? (g.window.width + SAMPLE_PAD * 2) * s, height: plan?.height ?? (g.window.height + SAMPLE_PAD * 2) * s };
  return g.desktop.monitors.filter(m => intersection(sample, m.pixels)).sort((a, b) => Number(b.id === g.activeMonitor) - Number(a.id === g.activeMonitor));
}
export function displayInGeometry(m: DesktopMonitor, g: Geometry): Rect {
  const cached = g.activeMonitor && g.desktop?.sampling?.[g.activeMonitor]?.[m.id];
  if (cached) return cached;
  return { x: m.pixels.x / g.scale, y: m.pixels.y / g.scale, width: m.pixels.width / g.scale, height: m.pixels.height / g.scale };
}
