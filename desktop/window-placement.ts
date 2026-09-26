export type Rect = { x: number; y: number; width: number; height: number };
export const TOOLBAR = { width: 309, height: 40 };
export function constrain(rect: Rect, area: Rect): Rect {
  const width = Math.min(rect.width, area.width), height = Math.min(rect.height, area.height);
  return { x: Math.round(Math.max(area.x, Math.min(rect.x, area.x + area.width - width))), y: Math.round(Math.max(area.y, Math.min(rect.y, area.y + area.height - height))), width, height };
}
export function adjacentBounds(anchor: Rect, area: Rect, size: { width: number; height: number }) {
  // Leave a small physical rounding allowance for fractional Windows display scale.
  const safeArea = { x: area.x + 2, y: area.y + 2, width: area.width - 4, height: area.height - 4 };
  const below = safeArea.y + safeArea.height - anchor.y - anchor.height - 8;
  const above = anchor.y - safeArea.y - 8;
  const direction = below >= size.height || below >= above ? "down" : "up";
  const height = Math.min(size.height, Math.max(1, direction === "down" ? below : above));
  const bounds = constrain({ x: anchor.x + anchor.width - size.width, y: direction === "down" ? anchor.y + anchor.height + 8 : anchor.y - height - 8, width: size.width, height }, safeArea);
  return { bounds, direction } as const;
}
// Native regions are binary masks, not antialiased outlines. Keep them outside
// the CSS curve (including fractional-DPI coverage); Chromium paints the edge.
// Far transparent corners still pass pointer events through to the document.
export function roundedRegion(width: number, height: number, radius: number) {
  const r = Math.min(Math.ceil(radius), Math.floor(height / 2), Math.floor(width / 2));
  const rects: Rect[] = [{ x: 0, y: r, width, height: height - 2 * r }];
  for (let y = 0; y < r; y++) {
    const inset = Math.max(0, Math.floor(r - Math.sqrt(r * r - (r - y - 1) ** 2)) - 2);
    rects.push({ x: inset, y, width: width - inset * 2, height: 1 }, { x: inset, y: height - y - 1, width: width - inset * 2, height: 1 });
  }
  return rects.filter(rect => rect.height > 0);
}

// Acrylic fills the HWND region, so unlike the transparent fallback its mask
// must not extend beyond the visible curve. Sample each DIP row at its centre.
export function backdropRegion(width: number, height: number, radius: number) {
  const r = Math.min(radius, width / 2, height / 2), rows: Rect[] = [];
  for (let y = 0; y < height; y++) {
    const dy = Math.max(0, r - Math.min(y + .5, height - y - .5));
    const x = Math.max(0, Math.ceil(r - Math.sqrt(r * r - dy * dy) - .5));
    const previous = rows.at(-1);
    if (previous && previous.x === x) previous.height++;
    else rows.push({ x, y, width: width - x * 2, height: 1 });
  }
  return rows;
}

export function inSystemCorner(x: number, y: number, width: number, height: number, radius = 8) {
  if (x < 0 || y < 0 || x >= width || y >= height) return false;
  const r = Math.min(radius, width / 2, height / 2);
  const dx = Math.max(0, r - Math.min(x, width - x));
  const dy = Math.max(0, r - Math.min(y, height - y));
  return dx * dx + dy * dy > r * r;
}
