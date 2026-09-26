import "../node-only";
import { DEFAULT_ANALYSIS_MODEL, isAnalysisModel } from "../../shared/analysis-models";
import type { AnalysisMode } from "../../shared/analysis-contract";

export type Environment = Record<string, string | undefined>;
export type ConfigurationIssue = "invalid_configuration" | "invalid_base_url" | "full_endpoint" | "invalid_model" | "key_binding_required";
export const validKey = (value: unknown): value is string => typeof value === "string" && value.length <= 4096 && !/[^\x21-\x7e]/.test(value);

// Explicit HTTP endpoints (including LAN hostnames) are allowed in the trusted
// process. Browser network permissions and certificate validation stay unchanged.
export function parseBaseUrl(value: unknown): { baseUrl: string; endpoint: string } | { error: ConfigurationIssue } {
  if (typeof value !== "string" || !value.trim() || value.length > 2048 || /[\u0000-\u0020\u007f\\]/u.test(value.trim())) return { error: "invalid_base_url" };
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password || url.search || url.hash) return { error: "invalid_base_url" };
    const pathname = url.pathname.replace(/\/+$/, "");
    if (/\/(?:chat\/completions|responses|completions)$/i.test(decodeURIComponent(pathname))) return { error: "full_endpoint" };
    const baseUrl = `${url.origin}${pathname}`;
    if (baseUrl.length > 2048) return { error: "invalid_base_url" };
    return { baseUrl, endpoint: `${baseUrl}/chat/completions` };
  } catch { return { error: "invalid_base_url" }; }
}

// Exact service boundary, never inferred from a model name. Preserve the old
// Bailian request knobs only on its documented compatible endpoint.
export function isBailianBase(baseUrl: string) {
  const url = new URL(baseUrl);
  return url.protocol === "https:" && !url.port && url.pathname === "/compatible-mode/v1" &&
    (["dashscope.aliyuncs.com", "dashscope-intl.aliyuncs.com", "dashscope-us.aliyuncs.com"].includes(url.hostname) ||
      /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.(cn-beijing|ap-southeast-1|ap-northeast-1)\.maas\.aliyuncs\.com$/.test(url.hostname));
}
export function readConfiguration(env: Environment) {
  // A partial generic config must never fall back to a legacy provider/key.
  const generic = ["ANALYSIS_BASE_URL", "ANALYSIS_MODEL", "ANALYSIS_API_KEY"].some(key => Object.hasOwn(env, key));
  const url = parseBaseUrl(generic ? env.ANALYSIS_BASE_URL : env.QWEN_BASE_URL);
  const model = (generic ? env.ANALYSIS_MODEL : env.QWEN_MODEL || DEFAULT_ANALYSIS_MODEL)?.trim();
  const apiKey = (generic ? env.ANALYSIS_API_KEY : env.DASHSCOPE_API_KEY)?.trim() ?? "";
  const mode = env.ANALYSIS_OUTPUT_MODE?.trim() || "text";
  if ("error" in url || !isAnalysisModel(model) || !validKey(apiKey) || (mode !== "json" && mode !== "text")) return null;
  // Old variable names were a Bailian configuration; preserve that binding.
  if (!generic && (!apiKey || !isBailianBase(url.baseUrl))) return null;
  return { ...url, model, apiKey, mode: mode as AnalysisMode, adapter: isBailianBase(url.baseUrl) ? "bailian" as const : "compatible" as const };
}
export function readAsrKey(env: Environment): string {
  const key = (Object.hasOwn(env, "ASR_API_KEY") ? env.ASR_API_KEY : env.DASHSCOPE_API_KEY)?.trim() ?? "";
  return validKey(key) ? key : "";
}
