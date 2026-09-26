import staticPreset from './presets/static-accepted24.json';
import motionPreset from './presets/motion-accepted10.json';
import { DEFAULT_MATERIAL, patchMaterial } from './material-settings';
import { DEFAULT_MOTION, patchMotion } from './motion';
// Accepted values are intentionally separate from upstream engineering defaults.
export const ACCEPTED_MATERIAL = Object.freeze(patchMaterial(DEFAULT_MATERIAL, staticPreset.settings));
export const ACCEPTED_MOTION = Object.freeze(patchMotion(DEFAULT_MOTION, motionPreset.settings));
