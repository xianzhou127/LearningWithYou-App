// Historical examples for comparison scripts, never a selection whitelist.
export const ANALYSIS_MODELS = [
  "qwen3.8-max",
  "qwen3.8-27b",
  "qwen3.7-flash-2026-07-15",
  "qwen3.8-max-0902",
  "qwen3.8-flash",
] as const;

export type AnalysisModel = string;
export const DEFAULT_ANALYSIS_MODEL: AnalysisModel = "qwen3.8-max";

export function isAnalysisModel(value: unknown): value is AnalysisModel {
  return typeof value === "string" && value.length > 0 && value.length <= 256 &&
    value === value.trim() && !/[\u0000-\u001f\u007f-\u009f\uD800-\uDFFF]/u.test(value);
}
