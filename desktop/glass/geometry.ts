import { SIZE, SAMPLE_PAD, type Geometry } from './contract';
import { unpull } from './deformation';
import type { MotionPose } from './motion';
export function motionDistance(x: number, y: number, pose: MotionPose) {
  const [ux, uy] = unpull(x, y, pose.contact[0], pose.tug, SIZE.height / 2 - pose.shape[3] - pose.elevation * .8);
  const px = (ux - SIZE.width / 2 - pose.shape[2]) / pose.shape[0];
  const py = (SIZE.height / 2 - uy - pose.shape[3] - pose.elevation * .8) / pose.shape[1];
  const gx = (pose.contact[0] - SIZE.width / 2 - pose.shape[2]) / pose.shape[0];
  const gy = (SIZE.height / 2 - pose.contact[1] - pose.shape[3] - pose.elevation * .8) / pose.shape[1];
  const bulge = pose.contact[2] * Math.exp(-((px - gx) ** 2 + (py - gy) ** 2) / 6400);
  return capsuleDistance(px + SIZE.width / 2, py + SIZE.height / 2) - pose.elevation * .6 - pose.inflation - bulge;
}
export function motionHit(x: number, y: number, pose: MotionPose) {
  if (motionDistance(x, y, pose) <= 0) return true;
  // Match the rigid foreground groups, including a grip outside the old core.
  return [[30, 12, 115, 15], [30, 27, 115, 12], [148, 12, 102, 28], [253, 12, 24, 28], [280, 12, 24, 28], [9, 12, 18, 28]].some(([gx, gy, w, h], i) => {
    const cx = gx + w / 2 + pose.offsetsX[i], cy = gy + h / 2 + pose.offsetsY[i];
    const hw = w * pose.scales[i] / 2, hh = h * pose.scales[i] / 2, radius = Math.min(hw, hh);
    const dx = Math.abs(x - cx) - hw + radius, dy = Math.abs(y - cy) - hh + radius;
    return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) <= radius;
  });
}
export function capsuleDistance(x: number, y: number) {
  const px = x - SIZE.width / 2, py = y - SIZE.height / 2;
  const dx = Math.abs(px) - (SIZE.capsuleWidth / 2 - SIZE.radius);
  const dy = Math.abs(py) - (SIZE.capsuleHeight / 2 - SIZE.radius);
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - SIZE.radius;
}
// Electron bounds are DIP, video texture is actual captured pixels. Ratio mapping
// deliberately does not multiply the virtual desktop origin by the monitor DPI.
export function regionUV(g: Geometry, padding = SAMPLE_PAD) {
  return [
    (g.window.x - g.display.x - padding) / g.display.width,
    (g.window.y - g.display.y - padding) / g.display.height,
    (g.window.width + padding * 2) / g.display.width,
    (g.window.height + padding * 2) / g.display.height,
  ];
}
export function contained(window: Geometry['window'], display: Geometry['display']) {
  return window.x >= display.x && window.y >= display.y && window.x + window.width <= display.x + display.width && window.y + window.height <= display.y + display.height;
}
// Screen-space point light above the selected display centre, expressed in the
// same capsule-local DIP coordinates as the shader (positive Y points upward).
// Use the presented position, not the last main-process drag event.
export function screenLightPosition(g: Geometry): [number, number, number] {
  return [
    g.display.x + g.display.width / 2 - (g.window.x + g.window.width / 2),
    g.window.y + g.window.height / 2 - (g.display.y + g.display.height / 2),
    Math.max(80, Math.min(g.display.width, g.display.height) * .18),
  ];
}
export function localGeometry(g: Geometry, outerX: number, outerY: number): Geometry {
  const window = { ...g.window, x: outerX + (g.clientOffset?.x ?? 0), y: outerY + (g.clientOffset?.y ?? 0) };
  return { ...g, window, valid: contained(window, g.display) };
}
export function clampAnchor(point: { x: number; y: number }, host: { width: number; height: number }) {
  return { x: Math.max(0, Math.min(Math.max(0, host.width - SIZE.width), point.x)), y: Math.max(0, Math.min(Math.max(0, host.height - SIZE.height), point.y)) };
}
export function presentedGeometry(g: Geometry, point: { x: number; y: number }, outerX: number, outerY: number) {
  if (!g.fixedHost) return localGeometry(g, outerX, outerY);
  return localGeometry({ ...g, clientOffset: {
    x: (g.clientOffset?.x ?? 0) - (g.anchor?.x ?? 0) + point.x,
    y: (g.clientOffset?.y ?? 0) - (g.anchor?.y ?? 0) + point.y,
  } }, outerX, outerY);
}
export function percentile(values: number[], fraction: number) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}
