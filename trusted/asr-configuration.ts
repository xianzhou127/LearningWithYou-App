import "./node-only";
import { DEFAULT_ASR_PROVIDER, getAsrPreset } from "../shared/asr-providers";
import { validKey, type Environment } from "./analysis/configuration";

export function readAsrConfiguration(env: Environment) {
  // Only absent provider fields migrate to the original service. Unknown ids
  // must never send credentials/audio to an implicit fallback provider.
  const preset = getAsrPreset(Object.hasOwn(env, "ASR_PROVIDER") ? env.ASR_PROVIDER : DEFAULT_ASR_PROVIDER);
  const apiKey = (Object.hasOwn(env, "ASR_API_KEY") ? env.ASR_API_KEY : preset?.id === DEFAULT_ASR_PROVIDER ? env.DASHSCOPE_API_KEY : undefined)?.trim() ?? "";
  if (!preset || !validKey(apiKey)) return null;
  return { preset, apiKey };
}
