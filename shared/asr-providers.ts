// Public, non-secret presets. Add a provider only alongside its trusted adapter
// and protocol tests; changing an existing id's destination requires migration.
export const ASR_PRESETS = [
  {
    id: "bailian",
    label: "阿里云百炼（北京）",
    protocol: "bailian-streaming-v1",
    endpoint: "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
    model: "qwen-audio-3.0-asr-flash-streaming",
    description: "实时转写，使用北京地域的百炼 API Key。地址、模型与音频格式已预设，只需填写密钥。",
  },
] as const;
export type AsrPreset = typeof ASR_PRESETS[number];
export type AsrProviderId = AsrPreset["id"];
export const DEFAULT_ASR_PROVIDER: AsrProviderId = "bailian";
export function getAsrPreset(value: unknown): AsrPreset | null {
  return ASR_PRESETS.find(preset => preset.id === value) ?? null;
}
