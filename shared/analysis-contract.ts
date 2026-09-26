import { isAnalysisModel, type AnalysisModel } from "./analysis-models";

export const VERDICTS = [
  "affirm",
  "affirm_and_supplement",
  "partial_correction",
  "correction",
  "clarify",
] as const;

export type Verdict = (typeof VERDICTS)[number];
export type AnalysisMode = "json" | "text";
export const MAX_FEEDBACK_BYTES = 256 * 1024;
export type AnalysisInput = {
  start_screenshot: string;
  end_screenshot: string;
  transcript: string;
};
export type AnalysisResult = {
  topic: string | null;
  understanding: string | null;
  verdict: Verdict;
  evidence: string;
  message: string;
};
export const MODEL_OUTPUT_KEYS = ["topic", "understanding", "verdict", "evidence", "message"] as const;
export const MAX_REASONING_CHARACTERS = 24_000;
export type AnalysisDetails = {
  model: AnalysisModel;
  thinking_enabled: boolean | null;
  thinking_budget: number | null;
  reasoning_content: string | null;
  reasoning_tokens: number | null;
};

export const ERROR_COPY = {
  invalid_input: { message: "需要两张完整的 PNG、JPEG 或 WebP 截图（每张不超过3MB），以及1至8000字符的非空转写。请检查本次内容。", retryable: false },
  configuration_error: { message: "分析配置无效，请检查 API Base URL、模型名称和密钥，再使用本次内容重试。", retryable: true },
  model_connection_failed: { message: "无法连接分析服务。请检查地址、网络和证书；本地服务请确认已启动并监听所填端口。具体原因尚不能确定。", retryable: true },
  model_not_found: { message: "服务报告模型不存在或不可用。请核对运行服务中的模型标识、加载状态及权限。", retryable: true },
  model_protocol_error: { message: "接口路径或协议可能不兼容；没有明确错误详情时也需核对模型标识。请填写 API Base URL，并确认支持 POST /chat/completions；不自动跟随重定向。", retryable: true },
  model_capability_unsupported: { message: "服务报告不支持图片或本次请求能力。请使用支持图片输入的模型；结构化模式还需支持 JSON Schema，可改为自然语言后手动重试。截图未被省略。", retryable: true },
  model_access_denied: { message: "分析服务鉴权或访问权限检查失败。请确认密钥、模型权限及账户状态，处理后可使用本次内容重试。", retryable: true },
  model_request_rejected: { message: "模型服务未接受本次分析请求，具体原因尚不能确定。请核对服务文档、模型图片能力及所选反馈格式，处理后可使用本次内容重试。", retryable: true },
  model_timeout: { message: "分析等待超时，可以用本次截图和转写重试。", retryable: true },
  model_rate_limited: { message: "分析请求暂时过于频繁，请稍后重试。", retryable: true },
  model_unavailable: { message: "暂时无法完成分析，请检查网络或稍后重试。", retryable: true },
  invalid_model_output: { message: "这次反馈未通过格式检查，请重试。", retryable: true },
} as const;
export type AnalysisErrorCode = keyof typeof ERROR_COPY;
export const ANALYSIS_ISSUE_HEADER = "X-Analysis-Issue";
// Only fixed diagnostic labels cross the HTTP boundary, never model content.
export const OUTPUT_ERROR_COPY = {
  response_body: "模型回复未能完整读取或解析，请重试。",
  response_too_large: "模型回复超过本次接收上限，请重试。",
  response_structure: "模型返回的回复结构异常，请重试。",
  response_incomplete: "模型回复尚未生成完整便停止了，请重试。",
  unexpected_message: "模型没有返回可用的完整分析文本，请重试。",
  json_parse: "模型分析结果的格式不完整或无法解析，请重试。",
  field_set: "模型分析结果缺少必需字段或包含额外字段，请重试。",
  topic_text: "模型返回的主题摘要格式异常，请重试。",
  understanding_text: "模型返回的理解摘要格式异常，请重试。",
  evidence_text: "模型返回的依据说明格式异常，请重试。",
  verdict: "模型返回了无法识别的反馈类型，请重试。",
  message_type_or_empty: "模型未返回有效的反馈正文，请重试。",
  message_format: "模型正文未满足完整句子或段落格式要求，请重试。",
  reasoning_metadata: "模型返回的思考内容或用量信息格式异常，请重试。",
} as const;
export type AnalysisOutputIssue = keyof typeof OUTPUT_ERROR_COPY;
export function isAnalysisOutputIssue(value: unknown): value is AnalysisOutputIssue {
  return typeof value === "string" && Object.hasOwn(OUTPUT_ERROR_COPY, value);
}
export type AnalysisError = { code: AnalysisErrorCode; message: string; retryable: boolean };
export type AnalysisResponse =
  | { ok: true; mode: "json"; result: AnalysisResult; details: AnalysisDetails }
  | { ok: true; mode: "text"; result: { message: string }; details: AnalysisDetails | null }
  | { ok: false; error: AnalysisError };

export function errorResponse(code: AnalysisErrorCode): AnalysisResponse & { ok: false } {
  return { ok: false, error: { code, ...ERROR_COPY[code] } };
}

export function outputErrorResponse(issue: unknown): AnalysisResponse & { ok: false } {
  const response = errorResponse("invalid_model_output");
  return isAnalysisOutputIssue(issue)
    ? { ...response, error: { ...response.error, message: OUTPUT_ERROR_COPY[issue] } }
    : response;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

// Array.from counts Unicode code points, not UTF-16 code units.
export function codePointLength(value: string) {
  return Array.from(value).length;
}

export function boundedText(value: unknown, min: number, max: number): value is string {
  if (typeof value !== "string") return false;
  const points = Array.from(value);
  return points.length >= min && points.length <= max &&
    points.every((point) => !/^[\uD800-\uDFFF]$/u.test(point));
}

// Summary brevity is a prompt instruction, not a reason to discard a complete reply.
// The server enforces a byte limit for the whole upstream response.
export function isOutputText(value: unknown): value is string {
  return boundedText(value, 0, Infinity);
}

export function isVerdict(value: unknown): value is Verdict {
  return VERDICTS.some((verdict) => verdict === value);
}

export function isFeedbackMessage(value: unknown): value is string {
  // No editorial length/sentence cap. Transport has a separate byte limit.
  if (!boundedText(value, 1, Infinity) || !value.trim()) return false;
  // Reject a response that stops mid-clause, even if finish_reason is stop.
  if (!/[。！？.!?][\u201d\u2019\u300d\u300f\u0022\u0027]*$/u.test(value.trimEnd())) return false;
  // Permit paragraph breaks and tabs, while keeping control characters and markup out.
  return !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|```|(?:^|\n)\s*(?:[#*>-]|\d+[.)、])|置信度|评分/u.test(value);
}

// B validates transport-safe text only. Punctuation and literary form are not
// evidence of truncation; only the upstream completion status determines that.
export function isNaturalFeedback(value: unknown): value is string {
  return boundedText(value, 1, MAX_FEEDBACK_BYTES) && Boolean(value.trim()) &&
    new TextEncoder().encode(value).byteLength <= MAX_FEEDBACK_BYTES;
}

// Optional diagnostics cannot veto B's final body. Keep only known, valid fields.
export function optionalAnalysisDetails(value: unknown): AnalysisDetails | null {
  if (!isRecord(value)) return null;
  const candidate = {
    model: value.model, thinking_enabled: typeof value.thinking_enabled === "boolean" ? value.thinking_enabled : null,
    thinking_budget: typeof value.thinking_budget === "number" && Number.isSafeInteger(value.thinking_budget) && value.thinking_budget >= 0 && value.thinking_budget <= 262144 ? value.thinking_budget : null,
    reasoning_content: boundedText(value.reasoning_content, 0, MAX_REASONING_CHARACTERS) ? value.reasoning_content : null,
    reasoning_tokens: typeof value.reasoning_tokens === "number" && Number.isSafeInteger(value.reasoning_tokens) &&
      value.reasoning_tokens >= 0 ? value.reasoning_tokens : null,
  };
  return isAnalysisDetails(candidate) ? candidate : null;
}

export function isAnalysisResult(value: unknown): value is AnalysisResult {
  return isRecord(value) && hasExactKeys(value, MODEL_OUTPUT_KEYS) &&
    (value.topic === null || isOutputText(value.topic)) &&
    (value.understanding === null || isOutputText(value.understanding)) &&
    isVerdict(value.verdict) && isOutputText(value.evidence) && isFeedbackMessage(value.message);
}

export function isAnalysisDetails(value: unknown): value is AnalysisDetails {
  return isRecord(value) && hasExactKeys(value, [
    "model", "thinking_enabled", "thinking_budget", "reasoning_content", "reasoning_tokens",
  ]) && isAnalysisModel(value.model) && (value.thinking_enabled === null || typeof value.thinking_enabled === "boolean") &&
    (value.thinking_budget === null || (typeof value.thinking_budget === "number" && Number.isSafeInteger(value.thinking_budget) &&
    value.thinking_budget >= 0 && value.thinking_budget <= 262144)) &&
    (value.reasoning_content === null || boundedText(value.reasoning_content, 0, MAX_REASONING_CHARACTERS)) &&
    (value.reasoning_tokens === null || (typeof value.reasoning_tokens === "number" &&
      Number.isSafeInteger(value.reasoning_tokens) && value.reasoning_tokens >= 0));
}

// Full results are session-only. Reject unexpected payloads; error copy stays local and fixed.
export function parseAnalysisResponse(value: unknown): AnalysisResponse {
  if (isRecord(value) && value.ok === true && value.mode === "text" &&
      isRecord(value.result) && hasExactKeys(value.result, ["message"]) && isNaturalFeedback(value.result.message)) {
    return { ok: true, mode: "text", result: { message: value.result.message }, details: optionalAnalysisDetails(value.details) };
  }
  if (isRecord(value) && value.ok === true && value.mode === "json" && hasExactKeys(value, ["ok", "mode", "result", "details"]) &&
      isAnalysisResult(value.result) && isAnalysisDetails(value.details)) {
    return { ok: true, mode: "json", result: value.result, details: value.details };
  }
  if (isRecord(value) && value.ok === false && hasExactKeys(value, ["ok", "error"]) &&
      isRecord(value.error) && hasExactKeys(value.error, ["code", "message", "retryable"]) &&
      typeof value.error.code === "string" && Object.hasOwn(ERROR_COPY, value.error.code)) {
    return errorResponse(value.error.code as AnalysisErrorCode);
  }
  return errorResponse("invalid_model_output");
}
