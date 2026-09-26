import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Snapshot, ViewAction } from "./shared";
import { FeedbackMarkdown } from "./feedback-markdown";
import { UiIcon } from "./ui-icon";
import { formatTime, phaseLabels, primaryAction, recoveryView, type PrimaryIntent } from "./learning-view";

type Props = { state: Snapshot; configured?: boolean; onPrimary: (intent: PrimaryIntent) => void; onView: (view: ViewAction) => void };
export function PrimaryButton({ state, configured, onPrimary }: Omit<Props, "onView">) {
  const action = primaryAction(state, configured);
  return <button className={`primary learning-primary ${state.recording ? "record-action" : ""}`} disabled={action.disabled} onClick={() => onPrimary(action.intent)}>
    <span className="primary-symbol" key={action.intent + String(action.disabled)}><UiIcon name={action.disabled ? "working" : action.intent === "check" ? "stop" : action.intent === "retry" ? "working" : action.intent === "start" ? "play" : "book"} /></span><span>{action.label}</span>
  </button>;
}
export function LearningToolbar({ state, configured = true, onPrimary, onView, nativeDrag = false, feedbackOpen = false, menuOpen = false, notice }: Props & { nativeDrag?: boolean; feedbackOpen?: boolean; menuOpen?: boolean; notice?: string | null }) {
  const hint = notice || state.error || (state.simulated ? "模拟样例 · 不使用麦克风或云服务" : state.source?.name ?? "先配置服务并选择资料");
  return <main className="learning-toolbar" data-phase={state.phase} data-native-drag={nativeDrag} aria-label="学习工具条">
    <button className="toolbar-grip" aria-label="拖动工具条" title="拖动移动工具条；方向键微调" onKeyDown={e => { const action = { ArrowLeft: "move-left", ArrowRight: "move-right", ArrowUp: "move-up", ArrowDown: "move-down" }[e.key] as ViewAction | undefined; if (action) { e.preventDefault(); onView(action); } }}><UiIcon name="grip" /></button>
    <div className="toolbar-status" title={hint}>
      <div className="toolbar-state"><span className={`state-dot ${state.recording ? "recording-dot" : ""}`} /><strong role="status">{!configured && !state.busy && !state.recording ? "请先配置服务" : phaseLabels[state.phase]}</strong>{state.recording && <time aria-label={`录音时长 ${formatTime(state.elapsedMs)}`}>{formatTime(state.elapsedMs)}</time>}</div>
      <button className="toolbar-context" title={hint} onClick={() => onView(state.error || notice ? "toggle-menu" : "panel")}>{notice ? "操作需要处理 · 查看详情" : state.error ? "查看原因与恢复方法" : state.simulated ? "模拟样例 · 无真实调用" : state.source?.name ?? "配置后选择学习资料"}</button>
    </div>
    <PrimaryButton state={state} configured={configured} onPrimary={onPrimary} />
    <button className={`toolbar-feedback ${state.phase === "feedback" ? "is-ready" : ""}`} aria-label={feedbackOpen ? "收起反馈" : "查看反馈"} aria-expanded={feedbackOpen} disabled={!state.feedback} onClick={() => onView("toggle-feedback")} title={feedbackOpen ? "收起并保留反馈" : "查看本轮反馈"}><UiIcon name="feedback" /></button>
    <button className="toolbar-more" aria-label="更多" aria-expanded={menuOpen} onClick={() => onView("toggle-menu")}><UiIcon name="menu" /></button>
  </main>;
}
export function ResultBody({ state }: { state: Snapshot }) {
  const response = state.analysis;
  const verdicts = { affirm: "确认理解", affirm_and_supplement: "确认并补充", partial_correction: "部分纠正", correction: "纠正理解", clarify: "需要澄清" };
  return <>{response?.ok && response.mode === "json" && <dl className="analysis-fields"><dt>主题</dt><dd>{response.result.topic ?? "未识别"}</dd><dt>你的核心理解</dt><dd>{response.result.understanding ?? "未识别"}</dd><dt>判断</dt><dd>{verdicts[response.result.verdict]}</dd><dt>截图依据</dt><dd>{response.result.evidence}</dd></dl>}<FeedbackMarkdown text={state.feedback ?? "本轮还没有反馈。"} /></>;
}
export function FeedbackCard({ state, onPrimary, onView, configured, open = true, direction = "down" }: Props & { open?: boolean; direction?: "up" | "down" }) {
  // A closing card keeps its last rendered result while the authoritative session advances.
  const [retained, setRetained] = useState(state);
  if (state.feedback && retained !== state) setRetained(state);
  const content = state.feedback ? state : retained;
  const article = useRef<HTMLElement>(null);
  const resultId = state.feedback ? `${state.sessionId}:${state.roundId}` : null;
  useLayoutEffect(() => { if (resultId && article.current) article.current.scrollTop = 0; }, [resultId]);
  return <main className="learning-feedback floating-surface" data-open={open} data-direction={direction} inert={!open}>
    <header className="reading-header"><div><h1>本轮反馈</h1><p title={content.source?.name}>{content.simulated ? "模拟内容 · 未调用真实服务" : content.source?.name ?? "学习资料"}</p></div><button className="icon-button" aria-label="收起反馈" onClick={() => onView("close")}><UiIcon name="chevron" /></button></header>
    <article ref={article} className="feedback-body" tabIndex={0} aria-label="本轮反馈正文"><ResultBody state={content} /></article>
    <footer className="reading-footer"><button className="quiet-action" onClick={() => onView("history")}><UiIcon name="history" />历史回顾</button><button className="feedback-evidence" aria-label="查看本轮转写、截图与录音" onClick={() => onView("panel")}>本轮详情</button><PrimaryButton state={state} configured={configured} onPrimary={onPrimary} /></footer>
  </main>;
}
export function MoreMenu({ state, onView, onAction, onHeight, open = true, direction = "down", error }: { state: Snapshot; onView: (view: ViewAction) => void; onAction: (action: "quit") => void; onHeight?: (height: number) => void; open?: boolean; direction?: "up" | "down"; error?: ReactNode }) {
  const content = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!onHeight || !content.current) return;
    const node = content.current;
    // Measure intrinsic content, unaffected by animation transforms or the viewport cap.
    const observer = new ResizeObserver(() => onHeight(node.offsetHeight));
    observer.observe(node);
    return () => observer.disconnect();
  }, [onHeight]);
  return <main className="learning-more floating-surface" data-open={open} data-direction={direction} inert={!open} aria-label="更多学习操作">
    <div ref={content} className="menu-content">
    <header><strong>学习选项</strong><button className="icon-button" aria-label="收起更多" onClick={() => onView("collapse")}><UiIcon name="close" /></button></header>
    {error && <div className="menu-problem" role="alert">{error}<button onClick={() => onView(recoveryView(state))}>查看并处理</button></div>}
    <button disabled={state.busy || state.recording} onClick={() => onView("picker")}><UiIcon name="book" />{state.source ? "更换资料" : "选择资料"}</button>
    <button onClick={() => onView("history")}><UiIcon name="history" />历史回顾</button>
    <button onClick={() => onView("panel")}><UiIcon name="feedback" />本轮详情</button>
    <button onClick={() => onView("settings")}><UiIcon name="settings" />设置</button>
    <div className="menu-divider" />
    <div className="menu-utilities"><button onClick={() => onView("hide")}>隐藏到托盘</button><button onClick={() => onAction("quit")}>退出应用</button></div>
    <p>{state.recording ? "隐藏后继续录音，托盘可结束本轮。" : "只有点击开始才会使用麦克风。"}</p>
    </div>
  </main>;
}
