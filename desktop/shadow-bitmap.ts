export const SHADOW_MARGIN = 3;

// A static, narrow alpha ring. It contains no desktop pixels or app content.
// Pure black premultiplied BGRA avoids colour fringes on translucent edges.
export function shadowBitmap(width: number, height: number, radius: number, scale: number) {
  const margin = SHADOW_MARGIN, w = Math.ceil((width + margin * 2) * scale), h = Math.ceil((height + margin * 2) * scale);
  const pixels = Buffer.alloc(w * h * 4);
  const r = Math.min(radius, width / 2, height / 2);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = (x + .5) / scale - margin, py = (y + .5) / scale - margin;
    const dx = Math.abs(px - width / 2) - (width / 2 - r), dy = Math.abs(py - height / 2) - (height / 2 - r);
    const distance = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - r;
    if (distance <= 0 || distance >= margin) continue;
    pixels[(y * w + x) * 4 + 3] = Math.round(38 * (1 - distance / margin) ** 2);
  }
  return { pixels, width: w, height: h };
}
