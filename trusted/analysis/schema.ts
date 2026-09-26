import "../node-only";
import {
  VERDICTS, hasExactKeys, isFeedbackMessage, isOutputText, isRecord, isVerdict,
  type AnalysisOutputIssue, type AnalysisResult,
} from "../../shared/analysis-contract";

export const ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    topic: { type: ["string", "null"], description: "主题摘要。" },
    understanding: { type: ["string", "null"], description: "用户理解摘要。" },
    verdict: { type: "string", enum: VERDICTS, description: "总体判断。" },
    evidence: { type: "string", description: "截图依据或缺失信息的摘要。" },
    message: { type: "string", minLength: 1, description: "面向用户的完整学习反馈。" },
  },
  required: ["topic", "understanding", "verdict", "evidence", "message"],
  additionalProperties: false,
} as const;

export function validateModelOutput(raw: string, onFailure?: (issue: AnalysisOutputIssue) => void): AnalysisResult | null {
  const fail = (issue: AnalysisOutputIssue) => { onFailure?.(issue); return null; };
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return fail("json_parse"); }
  if (!isRecord(value) || !hasExactKeys(value, ANALYSIS_SCHEMA.required)) return fail("field_set");
  if (!(value.topic === null || isOutputText(value.topic))) return fail("topic_text");
  if (!(value.understanding === null || isOutputText(value.understanding))) return fail("understanding_text");
  if (!isOutputText(value.evidence)) return fail("evidence_text");
  if (!isVerdict(value.verdict)) return fail("verdict");
  if (typeof value.message !== "string" || !value.message.trim()) return fail("message_type_or_empty");
  if (!isFeedbackMessage(value.message)) return fail("message_format");
  // The user explicitly enabled full-result viewing; all five fields remain validated.
  return {
    topic: value.topic, understanding: value.understanding, verdict: value.verdict,
    evidence: value.evidence, message: value.message,
  };
}
