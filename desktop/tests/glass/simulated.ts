import { DesktopSession, type MediaPort } from '../../session';
import type { LearningServices } from '../../services';
import type { AnalysisInput } from '../../../shared/analysis-contract';
import type { Shot } from '../../shared';
export function makeSimulation(quit: () => void, delayMs = 1500) {
  let began = 0;
  const counts = { start: 0, finish: 0, analyze: 0, cleared: 0 };
  // Only synthetic marker data is provided to the existing controller. There is
  // no screen/microphone implementation, HistoryStore, configuration or cloud import.
  const shot = (): Shot => ({ dataUrl: 'simulation-only', width: 1, height: 1, capturedAt: Date.now(), frameTime: 0 });
  const media: MediaPort = { async call(command) {
    switch (command.type) {
      case 'select': return { type: 'selected' };
      case 'start': counts.start++; began = Date.now(); return { type: 'started', start: shot(), startedAt: began };
      case 'finish': counts.finish++; return { type: 'finished', end: shot(), lastSequence: -1, audio: { bytes: new ArrayBuffer(0), mime: 'simulation', durationMs: Date.now() - began, pcm: { sampleRate: 16000, inputSampleRate: 16000, samples: 0, frames: 0, maxDeliveryGapMs: 0, seconds: [] } } };
      default: counts.cleared++; return { type: 'cleared' };
    }
  } };
  const services: LearningServices = {
    simulated: true, configuration: () => ({}),
    asr: (_config, update) => ({ start: async () => {}, send: () => {}, finish: async () => { update({ id: 1, text: '这是明确标记的模拟解释。', final: true }); }, cancel: () => {} }),
    validate: async value => value as AnalysisInput,
    analyze: async (_input, _config, signal) => {
      counts.analyze++;
      await new Promise<void>((resolve, reject) => {
        const onAbort = () => { clearTimeout(timer); reject(new Error('cancelled')); };
        const timer = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, delayMs);
        if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
      });
      return { ok: true, mode: 'text', result: { message: '模拟反馈已就绪。真实 DesktopSession 完成了本轮状态流转；没有使用麦克风、ASR、模型或历史存储。' }, details: null };
    },
  };
  return { session: new DesktopSession(media, quit, services), counts };
}
