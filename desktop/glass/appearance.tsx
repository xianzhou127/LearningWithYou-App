import { useEffect, useState } from 'react';
import type { AppearancePatch, AppearanceState } from './api';
import type { Telemetry } from './contract';
import { MaterialTuner } from './material-tuner';
import { MotionTuner } from './motion-tuner';

export function Appearance() {
  const [config, setConfig] = useState<AppearanceState | null>(null);
  const [telemetry, setTelemetry] = useState<Telemetry | null>(null), [error, setError] = useState('');
  const [systemReduced, setSystemReduced] = useState(matchMedia('(prefers-reduced-motion: reduce)').matches);
  useEffect(() => {
    document.body.className = 'control';
    const receive = (v: AppearanceState) => { setConfig(old => old && old.revision > v.revision ? old : v); };
    const off = window.appearance.onConfig(receive), offT = window.appearance.onTelemetry(setTelemetry);
    void window.appearance.config().then(receive); void window.appearance.telemetry().then(setTelemetry);
    const reduced = matchMedia('(prefers-reduced-motion: reduce)'), onReduced = () => setSystemReduced(reduced.matches);
    reduced.addEventListener('change', onReduced);
    return () => { off(); offT(); reduced.removeEventListener('change', onReduced); };
  }, []);
  const change = (value: AppearancePatch) => { setError(''); void window.appearance.configure(value).catch(() => setError('参数或采集操作失败，请检查显示器和胶囊可见状态后重试。')); };
  return <main className="control-page">
    <header><span className="eyebrow">T15 · 主胶囊</span><h1>外观调参</h1><p>滑块即时预览。材质与动效分别保存；关闭本窗口后胶囊和学习继续运行。</p></header>
    <section><h2>背景材质</h2><p>自动适配胶囊所在屏幕，无需选择显示器；拖到另一屏即可继续使用。背景仅供本机显示，学习资料仍由“选择资料”管理。</p>
      <div className="row"><button disabled={!config?.visible} onClick={() => change({ enabled: true, mode: 'C' })}>开启液态玻璃</button><button onClick={() => change({ enabled: false })}>关闭材质</button>
        <label><input type="checkbox" checked={config?.startupEnabled !== false} onChange={e => change({ startupEnabled: e.target.checked })}/>启动时自动开启（随材质保存）</label>
        <label>采集目标<select value={config?.fps ?? 30} onChange={e => change({ fps: Number(e.target.value) as 30 | 60 })}><option value="30">30 fps</option><option value="60">60 fps</option></select></label></div>
      <p role="status">{config?.failure || telemetry?.status || '尚未开启材质，当前为普通胶囊。'}{config && !config.visible ? ' · 请先从托盘恢复胶囊。' : ''}</p>
      <p>启动时准备所有屏幕，切屏直接复用已有配置和画面。隐藏时释放材质，恢复后自动继续。采集失败时可在此重新开启。</p>
      {config?.displayCache && <p>屏幕配置：复用 {config.displayCache.reused} 屏，更新 {config.displayCache.computed} 屏。{config.displayCache.warning}</p>}
      <details><summary>材质对照</summary><div className="row">{(['A', 'B', 'C'] as const).map(mode => <button className={config?.mode === mode ? 'selected' : ''} key={mode} onClick={() => change({ mode })}>{mode === 'A' ? '无材质' : mode === 'B' ? '基础模糊' : '完整材质'}</button>)}</div><p>采集目标与渲染频率分别管理；文字适应和拖动可能在两帧采集之间重绘。</p></details>
    </section>
    {config && <>
      <section><h2>当前预览与已保存</h2>{(['material', 'motion'] as const).map(kind => <div key={kind}><strong>{kind === 'material' ? '材质' : '动效'}：{config.saved[kind].dirty ? '当前预览尚未保存' : config.saved[kind].savedAt ? '当前预览与已保存一致' : '当前为验收预设，尚未正式保存'}</strong><p>启动来源：{config.saved[kind].source} · 保存时间：{config.saved[kind].savedAt ? new Date(config.saved[kind].savedAt!).toLocaleString() : '无'}</p>{config.saved[kind].warning && <p role="alert">{config.saved[kind].warning}</p>}<button onClick={() => { void window.appearance.importSettings(kind).catch(() => setError('导入失败：文件格式或参数无效，原文件与正式保存值均保留。')); }}>只读导入{kind === 'material' ? '材质' : '动效'}参数到预览…</button></div>)}</section>
      <section id="motion-tuning"><h2>交互动效</h2><div className="row">
        <label><input type="checkbox" checked={config.motion.enabled} onChange={e => change({ motion: { enabled: e.target.checked } })}/>动效总开关</label>
        <label><input type="checkbox" checked={config.motion.liquid} onChange={e => change({ motion: { liquid: e.target.checked } })}/>弹性气泡</label>
        <label><input type="checkbox" checked={config.reduced} onChange={e => change({ reduced: e.target.checked })}/>减少动态效果（随动效保存）</label>
        <label>阶段<select value={config.motion.stage} onChange={e => change({ motion: { stage: Number(e.target.value) as 1 | 2 | 3 | 4 } })}><option value="1">1 · 按钮</option><option value="2">2 · 抓起与松手</option><option value="3">3 · 会话提示</option><option value="4">4 · 焦点与拖动</option></select></label></div>
        {systemReduced && <p>系统已启用减少动态效果。</p>}
        <MotionTuner settings={config.motion} change={motion => change({ motion })} canPreview={!!telemetry?.liveTracks && config.enabled && config.visible && config.mode === 'C' && config.motion.enabled && config.motion.liquid && config.motion.stage >= 2 && !config.reduced && !systemReduced}/>
      </section>
      <MaterialTuner config={config} telemetry={telemetry}/>
    </>}
    {error && <p role="alert">{error}</p>}
    <footer>恢复验收预设仅改变当前预览；点击对应保存按钮后才覆盖正式值。启动时按保存的自动开启偏好运行。</footer>
  </main>;
}
