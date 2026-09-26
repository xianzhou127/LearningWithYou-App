// Local shader controls only. This object never enters the learning session.
export const MATERIAL_CONTROLS = {
  highlightStrength: { label: '高光强度', min: 0, max: 3, step: .02, initial: .62 },
  highlightWidth: { label: '高光宽度（DIP）', min: .25, max: 6, step: .05, initial: 1.25 },
  lightAngle: { label: '固定光照方向（°，90 为上方）', min: 0, max: 360, step: 1, initial: 123 },
  oppositeHighlight: { label: '反向高光比例', min: 0, max: 1.2, step: .02, initial: 1 },
  lightBalance: { label: '迎光／背光差异', min: 0, max: 1, step: .02, initial: .65 },
  distanceEffect: { label: '距离效果强度（0 对照旧版）', min: 0, max: 1, step: .02, initial: 1 },
  lightHeight: { label: '光源高度（屏幕短边倍数）', min: .12, max: 1.2, step: .01, initial: .45 },
  lightRadius: { label: '光源半径（高度倍数）', min: .05, max: .65, step: .01, initial: .28 },
  glareConvergence: { label: '高光集中度', min: .35, max: 4, step: .05, initial: 2 },
  glareChroma: { label: '高光保色', min: 0, max: 1, step: .02, initial: .4 },
  fresnelStrength: { label: '菲涅尔反射强度', min: 0, max: 1, step: .01, initial: .14 },
  fresnelRange: { label: '菲涅尔反射范围（向内 DIP）', min: 1, max: 16, step: .25, initial: 10 },
  fresnelHardness: { label: '菲涅尔反射硬度', min: 0, max: 1, step: .02, initial: .25 },
  lowerShade: { label: '暗瓣强度（单向时为下缘）', min: 0, max: .5, step: .005, initial: .065 },
  contourStrength: { label: '外侧细暗边', min: 0, max: .6, step: .01, initial: .18 },
  shadowStrength: { label: '阴影强度', min: 0, max: .4, step: .01, initial: .08 },
  shadowSpread: { label: '阴影扩散 σ（向外 DIP）', min: .5, max: 10, step: .25, initial: 4 },
  refractionPx: { label: '最大折射位移（DIP）', min: 0, max: 8, step: .1, initial: 6 },
  dispersionPx: { label: '折射色散宽度（DIP）', min: 0, max: 1.5, step: .05, initial: .65 },
  edgeWidth: { label: '折射边缘宽度（DIP）', min: 2, max: 16, step: .25, initial: 10 },
  ior: { label: '折射率', min: 1, max: 1.65, step: .01, initial: 1.42 },
  blurSigma: { label: '模糊强度 σ（DIP）', min: .5, max: 3, step: .1, initial: 2.5 },
  frostSigma: { label: '复杂背景模糊上限 σ（DIP）', min: .5, max: 6, step: .1, initial: 3 },
  frostThreshold: { label: '复杂度触发阈值（越低越容易变毛玻璃）', min: .05, max: .6, step: .01, initial: .12 },
  frostTransitionMs: { label: '毛玻璃过渡时间（毫秒，越小越快）', min: 0, max: 1500, step: 50, initial: 400 },
  frostWeightStatus: { label: '左侧状态文字权重', min: 0, max: 2, step: .05, initial: 1 },
  frostWeightPrimary: { label: '主按钮文字／图标权重', min: 0, max: 2, step: .05, initial: .7 },
  frostWeightIcons: { label: '右侧图标与拖柄权重', min: 0, max: 2, step: .05, initial: .35 },
  frostWeightEmpty: { label: '空白区域权重', min: 0, max: 2, step: .05, initial: .05 },
  tintStrength: { label: '染色强度', min: 0, max: 1.5, step: .05, initial: 1 },
} as const;
export type NumericSetting = keyof typeof MATERIAL_CONTROLS;
export const MATERIAL_LAYERS = { elevation: '悬浮轮廓（关闭对照23）', regionalFrost: '按内容区域加权（关闭对照22）', adaptiveFrost: '复杂背景自动毛玻璃（关闭对照20）', adaptiveText: '文字自动明暗', spatialText: '连续颜色场＋全部字形遮罩（关闭对照19）', screenLight: '屏幕中心光源', planoLens: '平凸透镜修正', centerBalance: '中心亮度补偿', highlight: '高光', dualLight: '对角双向', dispersion: '色散', refraction: '折射', blur: '模糊', tint: '染色', shade: '暗瓣', contour: '细暗边', shadow: '阴影' } as const;
export type LayerSetting = keyof typeof MATERIAL_LAYERS;
export type MaterialSettings = Record<NumericSetting, number> & Record<LayerSetting, boolean> & { debugView: 'normal' | 'highlight' | 'refraction' };
export const DEFAULT_MATERIAL: MaterialSettings = {
  ...Object.fromEntries(Object.entries(MATERIAL_CONTROLS).map(([key, c]) => [key, c.initial])),
  ...Object.fromEntries(Object.keys(MATERIAL_LAYERS).map(key => [key, true])), debugView: 'normal',
} as MaterialSettings;

// Only finite whitelisted shader values can be changed or written.
// Maximum refraction 8 + spectral spread 1.5 + blur support 12 < ROI pad 24.
export function patchMaterial(current: MaterialSettings, patch: unknown): MaterialSettings {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('参数应为对象');
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    // Candidate 17 saved files remain loadable; dimming is retired, not applied.
    if (key === 'readabilityStrength' && typeof value === 'number' && Number.isFinite(value)) continue;
    if (Object.hasOwn(MATERIAL_CONTROLS, key)) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('参数必须为有限数值');
      const control = MATERIAL_CONTROLS[key as NumericSetting];
      next[key as NumericSetting] = Math.max(control.min, Math.min(control.max, value));
    } else if (Object.hasOwn(MATERIAL_LAYERS, key)) {
      if (typeof value !== 'boolean') throw new Error('图层开关应为布尔值');
      next[key as LayerSetting] = value;
    } else if (key === 'debugView' && (value === 'normal' || value === 'highlight' || value === 'refraction')) next.debugView = value;
    else throw new Error('未知材质参数');
  }
  return next;
}
