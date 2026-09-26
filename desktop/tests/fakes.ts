import { DEMO_FEEDBACK } from "../demo";
import type { LearningServices } from "../services";
import type { AnalysisInput } from "../../shared/analysis-contract";
export function simulatedServices(delay = 0): LearningServices {
  return {
    simulated: true, configuration: () => ({}),
    asr: (_config, update) => ({ start: async () => {}, send: () => {}, finish: async () => { update({ id: 1, text: "模拟转写。", final: true }); }, cancel: () => {} }),
    validate: async input => input as AnalysisInput,
    analyze: async () => { await new Promise(resolve => setTimeout(resolve, delay)); return { ok: true, mode: "text", result: { message: DEMO_FEEDBACK }, details: null }; },
  };
}
