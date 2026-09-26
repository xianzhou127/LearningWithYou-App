import { useState } from 'react';
import { ACCEPTED_MOTION } from './presets';
import { MOTION_CONTROLS, type MotionNumber, type MotionSettings } from './motion';

export function MotionTuner({ settings, canPreview, change }: { settings: MotionSettings; canPreview: boolean; change: (patch: Partial<MotionSettings>) => void }) {
  const [message, setMessage] = useState('');
  const preview = (action: 'preview-grip' | 'preview-center' | 'preview-turn' | 'preview-release') => {
    void window.appearance.utility(action).then(() => setMessage(action === 'preview-release' ? '已松手，观察衰减回弹。' : action === 'preview-turn' ? '正在预览一次转向；位置固定，结束后自动松手。' : '保持受力中，可以直接拖动滑块；点击“松手”观察回弹。')).catch(() => setMessage('预览失败，请检查采集状态。'));
  };
  return <>
    <div className="motion-tuning-grid">{(Object.keys(MOTION_CONTROLS) as MotionNumber[]).map(key => {
      const control = MOTION_CONTROLS[key];
      return <label key={key}><span>{control.label}<output>{Number(settings[key].toFixed(2))} {control.unit}</output></span>
        <input aria-label={control.label} type="range" min={control.min} max={control.max} step={control.step} value={settings[key]} onChange={e => change({ [key]: Number(e.target.value) })}/></label>;
    })}</div>
    <div className="row"><button disabled={!canPreview} onClick={() => preview('preview-grip')}>拖柄受力（保持）</button><button disabled={!canPreview} onClick={() => preview('preview-center')}>中心受力（保持）</button><button disabled={!canPreview || settings.stage < 4} onClick={() => preview('preview-turn')}>预览转向一次</button><button disabled={!canPreview} onClick={() => preview('preview-release')}>松手</button></div>
    <p>滑块实时生效，形变连续过渡；保持受力时可直接观察幅度。预览只改变玻璃，不移动胶囊、不触发学习操作。中心预览便于观察从触点向四周的光传播。需开启 C 采集、弹性气泡，且关闭减少动态效果。</p>
    <p>拉长处相应变窄，压缩处变宽，随松手回弹恢复。接触光随局部背景变化：暗处增亮、亮处压暗，中间亮度平滑过渡。</p>
    <div className="row"><button onClick={() => change(ACCEPTED_MOTION)}>恢复候选10验收预设（先预览）</button><button onClick={() => { void window.appearance.saveMotion().then(result => setMessage('已保存动效参数：' + result.path)).catch(() => setMessage('保存失败，当前参数仍然有效。')); }}>保存动效参数</button></div>
    <p role="status">{message || '参数仅在点击保存后写入正式动效配置；保存后下次启动自动加载。不会覆盖材质参数。'}</p>
  </>;
}
