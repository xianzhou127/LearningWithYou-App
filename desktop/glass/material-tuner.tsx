import { useEffect, useRef, useState } from 'react';
import type { Configuration, Telemetry } from './contract';
import { MATERIAL_CONTROLS, MATERIAL_LAYERS, type MaterialSettings, type NumericSetting } from './material-settings';
import { ACCEPTED_MATERIAL } from './presets';

export function MaterialTuner({ config, telemetry }: { config: Configuration; telemetry: Telemetry | null }) {
  const distance = telemetry?.lighting?.distanceModel;
  const draft = config.material;
  const [message, setMessage] = useState('拖动滑块立即更新当前胶囊。悬浮感可先调菲涅尔范围与阴影扩散。');
  const pending = useRef<Partial<MaterialSettings>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const flush = () => {
    if (timer.current) clearTimeout(timer.current); timer.current = null;
    const patch = pending.current; pending.current = {};
    if (Object.keys(patch).length) chain.current = chain.current.then(() => window.appearance.tune(patch)).catch(() => setMessage('参数应用失败，请检查采集状态并重试。'));
    return chain.current;
  };
  const update = (patch: Partial<MaterialSettings>) => {
    Object.assign(pending.current, patch);
    if (!timer.current) timer.current = setTimeout(() => { void flush(); }, 32);
  };
  const save = async () => {
    await flush();
    try { const saved = await window.appearance.saveMaterial(); setMessage(`已保存参数：${saved.path}。下次启动恢复这些数值及自动开启偏好。`); }
    catch { setMessage('保存失败；当前参数仍留在面板中。'); }
  };
  const menuFrost = (enabled: boolean) => {
    void flush();
    chain.current = chain.current.then(() => window.appearance.configure({ menuFrost: enabled })).catch(() => setMessage('菜单磨砂设置应用失败，请重试。'));
  };
  const sliders = (keys: NumericSetting[]) => keys.map(key => {
    const c = MATERIAL_CONTROLS[key];
    const disabled = key === 'lightAngle' ? draft.screenLight : ['distanceEffect', 'lightHeight', 'lightRadius'].includes(key) && !draft.screenLight;
    return <div className="tuner-slider" key={key}>
      <label htmlFor={`range-${key}`}>{c.label}</label>
      <input id={`range-${key}`} type="range" disabled={disabled} min={c.min} max={c.max} step={c.step} value={draft[key]} onChange={e => update({ [key]: Number(e.target.value) })}/>
      <input aria-label={`${c.label}数值`} type="number" disabled={disabled} min={c.min} max={c.max} step={c.step} value={draft[key]} onChange={e => { if (e.target.value !== '' && Number.isFinite(e.target.valueAsNumber)) update({ [key]: Math.max(c.min, Math.min(c.max, e.target.valueAsNumber)) }); }}/>
    </div>;
  });
  return <section id="material-tuning" className="material-tuner">
    <h2>实时调参 · C 材质</h2>
    <p>连续颜色场：文字、时长、图标、状态点、拖柄和按钮细轮廓共同适应各位置的背景；只平滑颜色，不模糊字形、不压暗背景。关闭“连续颜色场”可对照候选19的分组切换。“减少动态效果”取消时间缓动。</p>
    {telemetry?.spatialSupport && <p>前景：{telemetry.spatialSupport.active ? '颜色场运行中' : '关闭'} · 文字 {telemetry.spatialSupport.textRuns} 段／图标 {telemetry.spatialSupport.icons}／圆点 {telemetry.spatialSupport.dots} · 遮罩上传 {telemetry.spatialSupport.maskUploads} 次</p>}
    {telemetry?.readingSupport?.error && <p className="diagnostic-warning">{telemetry.readingSupport.error}</p>}
    <h3>悬浮感 · 边缘反射与外部阴影</h3>
    <p>菲涅尔范围控制向内反光的宽度，硬度让亮边更饱满，强度控制明亮程度；不改变折射位置。阴影扩散让周围背景逐渐变暗，强度控制深浅，方向随现有光源轻微偏移。阴影区域仍可点击下方文档。</p>
    <div className="tuner-grid">{sliders(['fresnelRange', 'fresnelStrength', 'fresnelHardness', 'shadowSpread', 'shadowStrength'])}</div>
    <p>关闭“悬浮轮廓”对照23。菲涅尔需开启“高光”，扩散需开启“阴影”，均在 C 生效。范围与扩散使用 DIP，与参考站参数数值不同；过强可能发白或显得贴边，可随时降低。</p>
    <h3>复杂背景 → 毛玻璃</h3>
    <div className="row"><label><input type="checkbox" checked={config.menuFrost !== false} onChange={e => menuFrost(e.target.checked)}/>菜单始终高度磨砂</label></div>
    <p>默认开启：菜单保持高模糊，文字与图标清晰。关闭后跟随主体材质效果。实时预览，点击“保存材质参数”才保存；不影响主体参数和录音。</p>
    <p>开启“复杂背景自动毛玻璃”后，密集文字和纹理会让主体平滑加深模糊；简单背景恢复已保存的基础强度。轮廓仍保留较清晰的折射，全部文字和图标继续清晰。不会增加染色或局部压暗色块。</p>
    <div className="tuner-grid">{sliders(['frostSigma', 'frostThreshold', 'frostTransitionMs'])}</div>
    <p>区域加权默认优先保护左侧状态文字，其次是主按钮文字／图标；右侧图标权重较低，中间及按钮内空白最低。使用实际内容位置，录音时长和按钮文字变化会同步更新。整块胶囊仍统一模糊。</p>
    <details><summary>复杂度区域权重</summary><div className="tuner-grid">{sliders(['frostWeightStatus', 'frostWeightPrimary', 'frostWeightIcons', 'frostWeightEmpty'])}</div><p>这些是相对权重。关闭“按内容区域加权”可对照22的等权平均；原触发阈值、模糊上限和过渡时间保持。</p></details>
    <p>需开启“模糊”，仅 C 正常视图生效；上限最高 6，低于基础值时不会降低原模糊。变模糊和恢复透明使用相同速度，过渡时间表示完成约 90% 变化；设为 0 或减少动态效果时立即适应。关闭自动毛玻璃可对照候选20。</p>
    {telemetry?.frostSupport && <p>毛玻璃检测：{telemetry.frostSupport.active ? 'GPU 运行中' : '关闭'} · 基础 σ {telemetry.frostSupport.baseSigma.toFixed(1)} / 上限 σ {telemetry.frostSupport.maximumSigma.toFixed(1)} · 检测 {telemetry.frostSupport.samples} 次。当前复杂度和混合强度保留在 GPU，不读回桌面像素。</p>}
    {telemetry?.frostSupport && <p>区域：{telemetry.frostSupport.regional ? '按内容加权' : '等权平均'} · {telemetry.frostSupport.regionSource === 'react' ? '使用当前控件内容位置' : '等待内容布局，使用默认位置'}</p>}
    <p>{draft.screenLight ? '光源固定在所选屏幕中心上方。距离效果为 1 时，用有限尺寸光源和凸面反射计算远近变化；设为 0 可对照版 13。' : '当前使用固定光照方向。135° 时左上／右下为亮瓣，右上／左下为暗瓣。'}关闭“屏幕中心光源”可使用原固定角度，角度数值仍保留。</p>
    <div className="row"><label>查看方式<select aria-label="材质查看方式" value={draft.debugView} onChange={e => update({ debugView: e.target.value as MaterialSettings['debugView'] })}><option value="normal">正常 · 真实桌面背景</option><option value="highlight">诊断 · 仅看高光分布</option><option value="refraction">诊断 · 仅看折射位移</option></select></label><button onClick={() => { update({ ...ACCEPTED_MATERIAL }); menuFrost(true); }}>恢复候选24验收预设（先预览）</button></div>
    {draft.debugView !== 'normal' && <p className="diagnostic-warning">诊断视图的灰度／色彩只表示着色器分布，不能用于真实背景验收。</p>}
    {config.mode !== 'C' && <p className="diagnostic-warning">当前为 {config.mode}，请点击上方“C · 完整材质”观察变化；B 始终使用固定基础模糊。</p>}
    <div className="row tuner-layers">{Object.entries(MATERIAL_LAYERS).map(([key, label]) => <label key={key}><input type="checkbox" checked={draft[key as keyof typeof MATERIAL_LAYERS]} onChange={e => update({ [key]: e.target.checked })}/>{label}</label>)}</div>
    <div className="tuner-grid">{sliders(['distanceEffect', 'lightHeight', 'lightRadius'])}</div>
    <p>光源越低，屏幕中心与边缘的距离差异越明显；光源尺寸影响高光覆盖范围。高光宽度在新模型中调节凸面厚度，集中度调节微表面反射。高光峰值还受角度和背景影响，不保证每个像素都近亮远暗。</p>
    <p>“平凸透镜修正”开启时，顶面沿长短两轴弯曲，背面按平面处理，并限制反射能量；关闭可对照版 14 的亮带与发白问题。“反向高光比例”在此模式控制经过两次透射的底面反射，不再复制第二片凸面。需开启屏幕中心光源，且距离效果大于 0。</p>
    <p>“中心亮度补偿”让靠近屏幕中心时仍保留窄轮廓反光，并修正中间距离强度的亮度混合；主体继续透明。关闭对照版 15。需开启平凸透镜修正，距离效果大于 0；高光强度为 0 时不补光。这是外观补偿，不是新增真实光源。</p>
    {distance && <p>几何诊断：距光源中心 {distance.distance.toFixed(0)} DIP · 光源角半径 {distance.angularRadiusDeg.toFixed(1)}° · 相对能量项 {distance.relativeEnergy.toFixed(3)} · 模型混合 {distance.blend.toFixed(2)}。这些数值不是屏幕亮度或性能测量。</p>}
    <div className="tuner-grid">{sliders(['highlightStrength', 'highlightWidth', 'lightAngle', 'lightBalance', 'oppositeHighlight', 'glareConvergence', 'glareChroma', 'dispersionPx', 'lowerShade', 'contourStrength'])}</div>
    <p>{draft.planoLens && draft.screenLight && draft.distanceEffect > 0 ? '平凸模式中，“迎光／背光差异”用于减弱底面次反射；两侧宽度由曲率和光源角尺寸决定。设为 0 也不强制镜像对称。' : '“迎光／背光差异”越大，迎光侧越强，背光侧越弱；距离效果为 0 时同时调节两侧宽度，差异为 0 可对照对称分布（反向高光比例为 1）。'}仅在“对角双向”开启时生效。高光采用平滑亮度压缩。</p>
    <p>“色散宽度”控制折射彩边；“高光保色”保留亮边色彩；“高光集中度”越高，亮瓣越窄。需要检查轮廓时可选“仅看高光分布”，最终请回到真实背景。</p>
    <details><summary>折射、模糊与染色参数</summary><div className="tuner-grid">{sliders(['refractionPx', 'edgeWidth', 'ior', 'blurSigma', 'tintStrength'])}</div></details>
    <div className="row tuner-actions"><button onClick={() => void save()}>保存材质参数</button><span>GPU 已应用：{telemetry?.appliedMaterialRevision ?? '未绘制'} ／配置：{config.materialRevision}</span></div>
    <p className="tuner-message" role="status">{message}</p>
    <p>仅点击保存才写入正式应用的独立配置文件。诊断视图不作为启动默认值，不保存桌面图像。</p>
  </section>;
}
