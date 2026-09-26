import type { Snapshot, ViewAction } from "./shared";

export type PrimaryIntent = "start" | "check" | "retry" | "settings" | "picker";
export const phaseLabels: Record<Snapshot["phase"], string> = {
  idle: "选择学习资料", selecting: "正在连接资料", ready: "准备好就开始",
  connecting: "正在连接转写", starting: "准备截图与录音", recording: "录音中",
  stopping: "正在结束本轮", transcribing: "确认最后一句", processing: "正在分析理解",
  feedback: "反馈已就绪", error: "本轮需要处理", exiting: "正在退出",
};
export const formatTime = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;
// One mapping for the real toolbar, feedback footer and the explicitly simulated sample.
export function primaryAction(state: Snapshot, configured = true): { label: string; intent: PrimaryIntent; disabled: boolean } {
  if (state.busy || state.phase === "exiting") return { label: state.phase === "connecting" || state.phase === "starting" ? "正在准备" : "处理中", intent: "start", disabled: true };
  if (state.phase === "recording") return { label: "结束并检查", intent: "check", disabled: false };
  if (state.retryable) return { label: "重试本次分析", intent: "retry", disabled: false };
  if (!configured) return { label: "配置服务", intent: "settings", disabled: false };
  if (!state.source) return { label: "选择资料", intent: "picker", disabled: false };
  return { label: state.phase === "feedback" ? "开始下一轮" : state.phase === "error" ? "重新开始本轮" : "开始", intent: "start", disabled: !["ready", "feedback", "error"].includes(state.phase) };
}
export function recoveryView(state: Snapshot): ViewAction {
  return state.errorStage === "configuration" ? "settings" : !state.source && state.errorStage === "media" ? "picker" : "panel";
}
