import type { AnalysisResult } from "../shared/analysis-contract";

export type HistoryStage = "recording" | "transcribing" | "analyzing" | "complete" | "failed" | "interrupted";
export type HistoryFeedback = { mode: "text"; message: string } | { mode: "json"; message: string; fields: Omit<AnalysisResult, "message"> };
export type Attachment = "start" | "end" | "audio";
export type HistoryRecord = {
  version: 1; id: string; createdAt: number; updatedAt: number; sourceName: string;
  durationMs: number | null; stage: HistoryStage; reason: string | null; simulated: boolean;
  attachments: Record<Attachment, { bytes: number } | null>;
  transcript: string | null; feedback: HistoryFeedback | null;
};
export type HistorySummary = Pick<HistoryRecord, "id" | "createdAt" | "sourceName" | "durationMs" | "stage" | "simulated"> & {
  corrupt: boolean; deleting: boolean; locked: boolean; issue: string | null;
};
export type HistoryDetail = { summary: HistorySummary; record: HistoryRecord | null; available: Record<Attachment, boolean>; issues: string[] };
export type HistoryPage = { items: HistorySummary[]; total: number; nextOffset: number | null };
export type HistoryStatus = { revision: number; saving: number; clearing: boolean; error: string | null; playbackBlocked: boolean; clearBlockedReason: string | null };
export const historyStageNames: Record<HistoryStage, string> = {
  recording: "正在录音 · 材料未齐", transcribing: "等待最终转写", analyzing: "等待反馈",
  complete: "已获得反馈", failed: "未获得反馈", interrupted: "已中断 · 未获得反馈",
};
