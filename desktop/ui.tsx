import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Action, Diagnostics, Role, Snapshot, SourceChoice, ViewAction, Presentation } from "./shared";
import { ConfigurationPanel } from "./configuration-panel";
import { WindowPreferencesPanel } from "./window-preferences-panel";
import { WindowHeading } from "./window-heading";
import { getFinalTranscript } from "../shared/transcript";
import { LearningToolbar, FeedbackCard, MoreMenu, ResultBody } from "./learning-surfaces";
import type { PrimaryIntent } from "./learning-view";
import { HistoryView, useHistoryStatus } from "./history-view";
import { UiIcon, type IconName } from "./ui-icon";
import "./ui.css";
import "./configuration-panel.css";
import "./learning-surfaces.css";

const api = window.desktop;
const role = new URLSearchParams(location.search).get("role") as Role;
document.documentElement.dataset.role = role;
let current: Snapshot | null = null;
const listeners = new Set<() => void>();
const update = (snapshot: Snapshot) => {
  // An initial invoke response can race a newer push while a hidden renderer loads.
  if (current && snapshot.revision < current.revision) return;
  current = snapshot; listeners.forEach(listener => listener());
};
api.subscribe(update); void api.state().then(update);
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const view = (action: ViewAction) => { void api.view(action).catch(() => undefined); };
let currentPresentation: Presentation = { revision: -1, configured: true, menuOpen: false, feedbackOpen: false, direction: "down", notice: null };
const presentationListeners = new Set<() => void>();
const updatePresentation = (value: Presentation) => { if (value.revision < currentPresentation.revision) return; document.documentElement.dataset.material = value.material ?? "solid"; document.documentElement.dataset.nativeFrame = String(!!value.nativeFrame); currentPresentation = value; presentationListeners.forEach(listener => listener()); };
api.onPresentation(updatePresentation); void api.presentation().then(updatePresentation);
const subscribePresentation = (listener: () => void) => { presentationListeners.add(listener); return () => { presentationListeners.delete(listener); }; };
const time = (ms: number) => `${Math.floor(ms / 60000).toString().padStart(2, "0")}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;
const phaseNames: Record<Snapshot["phase"], string> = { idle: "先选择学习资料", selecting: "正在连接资料", ready: "准备好就开始", connecting: "连接转写", starting: "准备截图与麦克风", recording: "正在录音", stopping: "正在停止与截图", transcribing: "等待最后一句", processing: "正在分析理解", feedback: "反馈已就绪", error: "需要处理", exiting: "正在退出" };
const phaseIcons: Record<Snapshot["phase"], IconName> = { idle: "book", selecting: "working", ready: "play", connecting: "working", starting: "working", recording: "mic", stopping: "working", transcribing: "working", processing: "working", feedback: "check", error: "alert", exiting: "working" };

function Heading({ title }: { title: string }) {
  const presentation = useSyncExternalStore(subscribePresentation, () => currentPresentation);
  return <WindowHeading title={title} maximized={presentation.maximized} onView={view} />;
}
function Status({ state }: { state: Snapshot }) {
  return <div className="session-status" data-phase={state.phase} role="status"><UiIcon name={state.recording ? "mic" : phaseIcons[state.phase]} /><strong>{phaseNames[state.phase]}</strong><span className="clock">{time(state.elapsedMs)}</span></div>;
}
function Controls({ state, act }: { state: Snapshot; act: (action: Action) => void }) {
  const canStart = !!state.source && !state.busy && ["ready", "feedback", "error"].includes(state.phase);
  return <>
    <button className={`primary ${state.phase === "recording" ? "record-action" : ""}`} aria-label={state.phase === "recording" ? "■ 停止录音并检查" : state.artifacts.start ? "● 开始下一段" : "● 开始解释"} disabled={state.phase === "recording" ? state.busy : !canStart} onClick={() => act({ type: state.phase === "recording" ? "check" : "start", revision: state.revision })}><UiIcon name={state.phase === "recording" ? "stop" : "play"} />{state.phase === "recording" ? "停止录音并检查" : state.artifacts.start ? "开始下一段" : "开始解释"}</button>
    {state.retryable && <button disabled={state.busy} onClick={() => act({ type: "retry", revision: state.revision })}>使用本次内容重试</button>}
    <button disabled={state.busy || state.recording} onClick={() => view("picker")}>{state.source ? "更换资料" : "选择资料"}</button>
  </>;
}
function Picker({ state, act }: { state: Snapshot; act: (action: Action) => void }) {
  const [kind, setKind] = useState<"window" | "screen">("window");
  const [choices, setChoices] = useState<SourceChoice[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const currentKind = useRef<"window" | "screen">("window");
  const refresh = useCallback(async (next: "window" | "screen") => {
    if (pending.current) return;
    pending.current = true;
    currentKind.current = next;
    setBusy(true); setKind(next); setError(""); setChoices([]);
    try { setChoices(await api.sources(next)); } catch { setError("来源列表读取失败，请重试。"); } finally { pending.current = false; setBusy(false); }
  }, []);
  useEffect(() => {
    const opened = () => { void refresh(currentKind.current); };
    return api.onPickerOpened(opened);
  }, [refresh]);
  return <main className="panel"><Heading title="选择学习资料 · T14.5" /><div className="panel-content">
    <h1>这次想解释哪份资料？</h1><p className="muted">明确选择后保持同一来源。浏览器资料可先放进独立窗口；这里不会列出 Edge 的每个标签页。</p>
    <div className="picker-tabs"><button className={kind === "window" ? "selected" : ""} disabled={busy || state.busy || state.recording} onClick={() => void refresh("window")}>列出应用窗口</button><button className={kind === "screen" ? "selected" : ""} disabled={busy || state.busy || state.recording} onClick={() => void refresh("screen")}>列出屏幕</button><button disabled={busy || state.busy || state.recording} onClick={() => void refresh(kind)}>刷新列表</button></div>
    {kind === "screen" && <p className="notice">屏幕来源会包含该屏幕的其他可见内容。请先只展示专门准备的测试资料。</p>}
    {kind === "window" && <p className="fine">包括任务栏中已最小化的窗口。最小化窗口需要先恢复，再点击刷新；后台工具窗口不会列出。</p>}
    {busy ? <p role="status">正在读取来源…</p> : <p role="status">{kind === "screen" ? `已连接 ${choices.length} 个屏幕` : `已打开 ${choices.length} 个应用窗口`}</p>}
    {!busy && !choices.length && <p className="empty">当前没有可选来源，请打开资料后刷新列表。</p>}
    {error && <p role="alert" className="error">{error}</p>}
    <div className="source-grid">{choices.map(source => <button className="source-choice" data-source-id={source.id} data-display-id={source.displayId} key={source.id} disabled={!source.available || state.busy || state.recording} onClick={() => act({ type: "select", sourceId: source.id })}>
      {source.thumbnail ? <img src={source.thumbnail} alt="来源预览缩略图" /> : <div className="source-preview">{source.available ? "暂无缩略图，可按名称选择" : "请先恢复窗口"}</div>}<span title={source.name}>{source.name}</span><small>{source.detail}</small>
    </button>)}</div>
    <p className="fine">这些是选择用缩略图；本轮实际截图在明确开始和检查时重新取得。关闭本窗口会取消选择，原会话保留。</p>
  </div></main>;
}
function Settings() {
  return <main className="panel"><Heading title="设置" /><div className="panel-content"><h1>窗口设置</h1><WindowPreferencesPanel /><h2>服务设置</h2><ConfigurationPanel /></div></main>;
}
function Panel({ state, act }: { state: Snapshot; act: (action: Action) => void }) {
  const [technical, setTechnical] = useState<Diagnostics | null>(null);
  const [exportPath, setExportPath] = useState("");
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const refresh = async () => { try { setTechnical(await api.diagnostics()); } catch { setNotice("技术状态暂时无法读取。"); } };
  const doExport = async () => {
    setExporting(true);
    try { setExportPath(await api.exportEvidence() ?? "已取消导出"); } catch { setExportPath("导出失败，请选择可写目录后重试。"); } finally { setExporting(false); }
  };
  const audio = state.artifacts.audio;
  return <main className="panel"><Heading title="本轮详情" /><div className="panel-content">
    <div className="panel-top"><div><p className="eyebrow">LEARNING WITH YOU / T16.0</p><h1>本轮详情</h1><p className="muted">{state.simulated ? "模拟测试，未调用真实服务。" : "录音期间音频发送到已配置的百炼 ASR；检查后两张截图和最终转写发送到本轮配置的分析服务。本地分析搭配云端转写仍需联网。"}已取得的材料自动归档到本机，可从菜单“历史回顾”查看和删除。</p></div><div className="panel-controls"><Status state={state} /><Controls state={state} act={act} /></div></div>
    <div className="source-summary"><span>当前资料</span><strong>{state.source?.name ?? "尚未连接"}</strong><small>会话 {state.sessionId} / 轮次 {state.roundId} · {state.recording ? "麦克风录音中" : "麦克风未录音"}</small></div>
    <div className="evidence-grid">{(["start", "end"] as const).map(key => <section className="evidence" key={key}><h2>{key === "start" ? "01 开始截图" : "02 结束截图"}</h2>{state.artifacts[key] ? <>
      <img src={`./evidence/${key}.jpg?round=${state.roundId}`} alt={key === "start" ? "本轮实际开始截图" : "本轮实际结束截图"} /><p className="fine">{new Date(state.artifacts[key]!.capturedAt).toLocaleTimeString()} · {state.artifacts[key]!.width} × {state.artifacts[key]!.height} · 帧时间 {state.artifacts[key]!.frameTime.toFixed(3)} s</p>
    </> : <div className="empty">{key === "start" ? "开始后取得实际画面" : "检查后取得实际画面"}</div>}</section>)}</div>
    <section className="audio-section"><h2>03 本地录音</h2>{audio ? <><audio key={state.roundId} controls preload="metadata" src={`./evidence/recording.webm?round=${state.roundId}`} /><p>录音墙钟 {time(audio.durationMs)} · {(audio.bytes / 1024).toFixed(1)} KiB · PCM {(audio.pcm.samples / audio.pcm.sampleRate).toFixed(2)} 秒 / {audio.pcm.frames} 帧</p><p className="fine">输入 {audio.pcm.inputSampleRate} Hz → {audio.pcm.sampleRate} Hz；最大 PCM 消息送达间隔 {audio.pcm.maxDeliveryGapMs.toFixed(1)} ms。PCM 数量和计时仅作辅助，仍须回听真实测试声音。</p><details><summary>逐秒声音能量与隐藏区间</summary><pre>{JSON.stringify({ seconds: audio.pcm.seconds, hiddenIntervals: state.hiddenIntervals }, null, 2)}</pre></details></> : <p className="muted">点击开始使用麦克风，点击检查后在这里播放。最长 10 分钟后自动停止检查。</p>}</section>
    <section><h2>04 语音转写 · {state.transcriptComplete ? "最终转写" : state.errorStage === "asr" || state.errorStage === "media" ? "未完成，不用于分析" : "实时更新"}</h2><div className="transcript-final">{getFinalTranscript(state.transcript) || "尚无已确认句子"}</div>{state.transcript.interimSentence && <p className="transcript-interim">临时句：{state.transcript.interimSentence.text}</p>}</section>
    <section><h2>05 完整反馈{state.analysis?.ok ? state.analysis.mode === "text" ? " · 自然语言正文 B" : " · 五字段 A" : ""}</h2><ResultBody state={state} />{state.analysis?.ok && <details><summary>本次模型诊断</summary><pre>{JSON.stringify(state.analysis.details, null, 2)}</pre></details>}</section>
    <section><h2>06 交互与证据</h2><div className="action-row"><button disabled={!state.feedback} onClick={() => view("feedback")}>查看完整反馈</button><button disabled={!state.feedback} onClick={() => { view("feedback-inactive"); setNotice("3 秒后以不激活方式显示卡片，请切到测试资料输入。"); }}>延迟 3 秒不激活展示卡片</button><button onClick={() => view("hide")}>隐藏全部操作窗口</button><button onClick={() => view("restore")}>显示悬浮入口</button><button disabled={exporting || state.recording || state.busy} onClick={() => void doExport()}>{exporting ? "正在导出…" : "导出本轮测试证据…"}</button></div>
      <p className="notice">人工验收：连续三轮解释，其中一轮隐藏后继续，再从托盘恢复并检查。核对最后一句、两张截图和完整反馈。整屏黑块仍是已知暂缓问题。</p>{notice && <p role="status">{notice}</p>}{exportPath && <p className="export-path">{exportPath}</p>}
    </section>
    <section><h2>07 技术状态</h2><p>请求 {state.requestId} · {state.errorStage ?? "无错误"}{state.outputIssue ? ` / ${state.outputIssue}` : ""}</p><pre>{JSON.stringify(state.timings, null, 2)}</pre><button onClick={() => void refresh()}>读取当前环境与资源占用</button>{technical && <pre>{JSON.stringify(technical, null, 2)}</pre>}<p className="fine">窗口排除开关开启不代表真实截图已通过。最小化可能产生空白或旧帧。</p></section>
    <footer><button onClick={() => view("close")}>收起本轮详情</button><button onClick={() => act({ type: "quit", revision: state.revision })}>退出并释放资源</button></footer>
  </div></main>;
}
function App() {
  const presentation = useSyncExternalStore(subscribePresentation, () => currentPresentation);
  useEffect(() => {
    if (!presentation.nativeFrame) return;
    let previous: boolean | undefined;
    const pointer = (event: MouseEvent) => {
      // Native geometry remains authoritative under renderer zoom. Send movement
      // only near corners (and on leaving them), never poll while the app is idle.
      const near = Math.min(event.clientX, innerWidth - event.clientX) < 20 && Math.min(event.clientY, innerHeight - event.clientY) < 20;
      if (near || previous !== near) api.surfacePointer();
      previous = near;
    };
    window.addEventListener("mousemove", pointer);
    api.surfacePointer();
    return () => window.removeEventListener("mousemove", pointer);
  }, [presentation.nativeFrame, presentation.menuOpen, presentation.feedbackOpen]);
  const sending = useRef(false);
  const state = useSyncExternalStore(subscribe, () => current);
  const historyStatus = useHistoryStatus();
  useEffect(() => {
    const pause = () => document.querySelectorAll("audio").forEach(audio => audio.pause());
    const guard = (event: Event) => { if (!current || ["connecting", "starting", "recording", "stopping", "exiting"].includes(current.phase)) (event.target as HTMLAudioElement).pause(); };
    const off = api.onPlaybackStop(pause);
    document.addEventListener("play", guard, true);
    return () => { pause(); off(); document.removeEventListener("play", guard, true); };
  }, []);
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !document.querySelector("dialog[open]")) view(role === "menu" || role === "orb" ? "collapse" : "close"); };
    window.addEventListener("keydown", handleKey); return () => window.removeEventListener("keydown", handleKey);
  }, []);
  if (!state) return <p className="loading">T14.5…</p>;
  const act = (action: Action) => {
    if (sending.current && !["cancel", "end", "quit"].includes(action.type)) return;
    sending.current = true;
    void api.act(action).catch(() => view("operation-failed")).finally(() => { sending.current = false; });
  };
  const onPrimary = (intent: PrimaryIntent) => { if (intent === "settings" || intent === "picker") view(intent); else act({ type: intent, revision: state.revision }); };
  const message = presentation.notice;
  const error = state.error || message;
  const content = role === "history" ? <HistoryView status={historyStatus} maximized={presentation.maximized} />
    : role === "orb" ? <LearningToolbar state={state} configured={presentation.configured} onPrimary={onPrimary} onView={view} nativeDrag feedbackOpen={presentation.feedbackOpen} menuOpen={presentation.menuOpen} notice={historyStatus?.error || message} />
    : role === "menu" ? <MoreMenu state={state} onView={view} onAction={type => act({ type, revision: state.revision })} onHeight={api.menuHeight} open={presentation.menuOpen} direction={presentation.direction} error={historyStatus?.error || error} />
    : role === "feedback" ? <FeedbackCard state={state} configured={presentation.configured} onPrimary={onPrimary} onView={view} open={presentation.feedbackOpen} direction={presentation.direction} />
    : role === "picker" ? <Picker state={state} act={act} />
    : role === "settings" ? <Settings /> : <Panel state={state} act={act} />;
  return <div className="desktop-surface" data-phase={state.phase}>{content}{(historyStatus?.error || (role !== "history" && error)) && !["orb", "menu", "settings"].includes(role) && <div className="error-toast" role="alert"><UiIcon name="alert" /><span>{historyStatus?.error || error}</span><button aria-label="查看问题详情" onClick={() => view(state.errorStage === "configuration" ? "settings" : "panel")}>详情</button></div>}</div>;
}
createRoot(document.getElementById("root")!).render(<App />);
