import { SAMPLE_PAD, SIZE, type Rect } from './contract';
import { ELEVATION_PAD } from './elevation';

// Bump this when the geometry/output contract changes. Material sliders do not
// belong here: the user's optical and motion settings remain independent.
export const ADAPTATION_VERSION = 1;
export type DisplayIdentity = { id: string; device: string; label: string; bounds: Rect; pixels: Rect; scale: number; rotation: number; refreshHz: number; colorDepth: number; depthPerComponent: number; colorSpace: string; internal: boolean };
export type DisplayAdaptation = { inverseScale: number; display: Rect; roiPixels: { width: number; height: number }; contentPixels: Rect; outputPixels: { width: number; height: number }; samplePixels: { pad: number; width: number; height: number } };
export const adaptationContract = { version: ADAPTATION_VERSION, size: SIZE, samplePad: SAMPLE_PAD, elevationPad: ELEVATION_PAD };
export function computeAdaptation(input: DisplayIdentity): DisplayAdaptation {
  const s = input.scale, r = input.pixels, pad = Math.ceil(ELEVATION_PAD * s);
  const width = Math.round(SIZE.width * s), height = Math.round(SIZE.height * s);
  return { inverseScale: 1 / s, display: { x: r.x / s, y: r.y / s, width: r.width / s, height: r.height / s },
    roiPixels: { width: Math.round((SIZE.width + SAMPLE_PAD * 2) * s), height: Math.round((SIZE.height + SAMPLE_PAD * 2) * s) },
    contentPixels: { x: pad, y: pad, width, height }, outputPixels: { width: width + pad * 2, height: height + pad * 2 },
    samplePixels: { pad: SAMPLE_PAD * s, width: (SIZE.width + SAMPLE_PAD * 2) * s, height: (SIZE.height + SAMPLE_PAD * 2) * s } };
}
