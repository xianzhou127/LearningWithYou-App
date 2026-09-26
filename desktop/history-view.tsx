import { useCallback, useEffect, useRef, useState } from "react";
import { FeedbackMarkdown } from "./feedback-markdown";
import { WindowHeading } from "./window-heading";
import { historyStageNames, type HistoryDetail, type HistoryPage, type HistoryStatus } from "./history-types";

const api = window.desktop;
const clock = (ms: number | null) => ms === null ? "时长未取得" : `${Math.floor(ms / 60000)}:${Math.floor(ms / 1000 % 60).toString().padStart(2, "0")}`;
export function useHistoryStatus() {
  const [status, setStatus] = useState<HistoryStatus | null>(null);
  useEffect(() => {
    let request = 0, alive = true;
    const refresh = () => { const id = ++request; void api.historyStatus().then(value => { if (alive && request === id) setStatus(value); }).catch(() => { if (alive && request === id) setStatus(null); }); };
    refresh(); const off = api.onHistoryChanged(refresh);
    return () => { alive = false; off(); };
  }, []);
  return status;
}
function Recording({ id, durationMs }: { id: string; durationMs: number | null }) {
  const ref = useRef<HTMLAudioElement>(null);
  const [position, setPosition] = useState(0), [duration, setDuration] = useState((durationMs ?? 0) / 1000), [error, setError] = useState(false);
  useEffect(() => { const audio = ref.current; return () => { audio?.pause(); }; }, []);
  return <><audio ref={ref} controls preload="metadata" src={`./history/${id}/audio`} onError={() => setError(true)}
    onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) setDuration(event.currentTarget.duration); }}
    onTimeUpdate={event => setPosition(event.currentTarget.currentTime)} />
    {error ? <p className="error" role="alert">录音无法读取或解码，请刷新查看附件状态。</p> : <label className="seek">录音进度 {clock(position * 1000)} / {clock(duration * 1000)}<input aria-label="录音进度" type="range" min={0} max={Math.max(duration, position, 0.1)} step="0.1" value={position} onChange={event => { const t = Number(event.target.value); if (ref.current) ref.current.currentTime = t; setPosition(t); }} /></label>}
  </>;
}
function Details({ detail, blocked }: { detail: HistoryDetail; blocked: boolean }) {
  const [zoom, setZoom] = useState<"start" | "end" | null>(null);
  const [badImages, setBadImages] = useState<Set<string>>(new Set());
  const { record, summary, available, issues } = detail;
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (zoom) dialog.current?.showModal(); else dialog.current?.close(); }, [zoom]);
  if (!record) return <p className="notice" role="alert">{summary.issue}</p>;
  const fields = record.feedback?.mode === "json" ? record.feedback.fields : null;
  const verdicts = { affirm: "确认理解", affirm_and_supplement: "确认并补充", partial_correction: "部分纠正", correction: "纠正理解", clarify: "需要澄清" };
  return <article className="history-detail">
    <h1>{record.sourceName}</h1><p className="muted">{new Date(record.createdAt).toLocaleString()} · {clock(record.durationMs)} · {historyStageNames[record.stage]}{record.simulated ? " · 模拟测试" : ""}</p>
    {record.reason && <p className="notice">{record.reason}</p>}{issues.map(issue => <p className="error" role="alert" key={issue}>{issue}</p>)}
    <div className="evidence-grid">{(["start", "end"] as const).map(key => <section className="evidence" key={key}><h2>{key === "start" ? "开始截图" : "结束截图"}</h2>
      {available[key] && !badImages.has(key) ? <button className="image-button" aria-label={`放大${key === "start" ? "开始" : "结束"}截图`} onClick={() => setZoom(key)}><img src={`./history/${record.id}/${key}`} alt={key === "start" ? "历史开始截图" : "历史结束截图"} onError={() => setBadImages(old => new Set([...old, key]))} /><span>点击放大</span></button> : <p className="empty">{record.attachments[key] ? "附件缺失、损坏或无法显示" : "本轮未取得这张截图"}</p>}
    </section>)}</div>
    <section><h2>原始录音</h2>{blocked ? <p className="notice">准备麦克风或录音期间暂停历史播放。停止录音后可手动播放。</p> : available.audio ? <Recording key={record.id} id={record.id} durationMs={record.durationMs} /> : <p className="empty">{record.attachments.audio ? "录音附件缺失或损坏" : "未取得完整录音；中断前未完成的录音无法恢复"}</p>}</section>
    <section><h2>最终转写</h2><div className="transcript-final">{record.transcript === null ? "最终转写未完成或未取得，临时文字不作为最终转写保存。" : record.transcript || "最终转写为空。"}</div></section>
    <section><h2>AI 反馈{record.feedback ? record.feedback.mode === "text" ? " · 自然语言正文 B" : " · 五字段 A" : ""}</h2>
      {fields && <dl className="analysis-fields"><dt>主题</dt><dd>{fields.topic ?? "未识别"}</dd><dt>你的核心理解</dt><dd>{fields.understanding ?? "未识别"}</dd><dt>判断</dt><dd>{verdicts[fields.verdict]}</dd><dt>截图依据</dt><dd>{fields.evidence}</dd></dl>}
      {record.feedback ? <FeedbackMarkdown text={record.feedback.message} /> : <p className="empty">未获得反馈 · {historyStageNames[record.stage]}</p>}
    </section>
    <dialog ref={dialog} className="image-dialog" onCancel={event => { event.preventDefault(); setZoom(null); }}><button autoFocus onClick={() => setZoom(null)}>关闭放大图</button>{zoom && <img src={`./history/${record.id}/${zoom}`} alt={zoom === "start" ? "放大的开始截图" : "放大的结束截图"} />}</dialog>
  </article>;
}
export function HistoryView({ status, maximized = false }: { status: HistoryStatus | null; maximized?: boolean }) {
  const [page, setPage] = useState<HistoryPage | null>(null), [offset, setOffset] = useState(0), [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<HistoryDetail | null>(null), [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [refreshKey, setRefreshKey] = useState(0), [working, setWorking] = useState(false);
  const refresh = useCallback(() => setRefreshKey(n => n + 1), []);
  useEffect(() => {
    let alive = true;
    void api.historyList(offset).then(value => { if (alive) { if (!value.items.length && offset) setOffset(0); setPage(value); setError(""); } }).catch(() => { if (alive) setError("历史列表加载失败，请检查数据目录后重试。"); });
    return () => { alive = false; };
  }, [offset, status?.revision, refreshKey]);
  useEffect(() => {
    let alive = true;
    if (!selected) return;
    void api.historyDetail(selected).then(value => { if (alive) setDetail(value); }).catch(() => { if (alive) { setDetail(null); setError("这条记录读取失败，请刷新列表后重试。"); } });
    return () => { alive = false; };
  }, [selected, status?.revision, refreshKey]);
  const remove = async (all: boolean) => {
    setWorking(true); setNotice("");
    // Stop playback before files are removed, including a potentially locked Windows media handle.
    document.querySelectorAll("audio").forEach(audio => { audio.pause(); audio.removeAttribute("src"); audio.load(); });
    try {
      const result = all ? await api.historyClear() : await api.historyDelete(selected!);
      setNotice(result.message ?? (result.ok ? "记录已删除。" : "删除未完成。"));
      if (result.ok && !all) { setSelected(null); setDetail(null); }
      if (all) { setSelected(null); setDetail(null); }
    } catch { setNotice("删除未完成，请刷新并重试。"); }
    finally { setWorking(false); refresh(); }
  };
  const shown = detail?.summary.id === selected ? detail : null;
  const locked = shown?.summary.locked || status?.clearing || working;
  return <main className="panel"><WindowHeading title="历史回顾 · 本机保存" maximized={maximized} closeLabel="收起历史回顾" onView={action => { void api.view(action).catch(() => undefined); }} />
    <div className="history-toolbar"><div><strong>每一轮，留在本机。</strong><p className="fine">仅查看与播放，不会调用转写或模型；不改变当前学习资料。</p></div><div className="action-row"><button onClick={refresh}>刷新</button><button disabled={!page?.total || !status || !!status.clearBlockedReason || working} onClick={() => void remove(true)}>全部清除…</button></div></div>
    {status?.clearBlockedReason && <p className="history-notice">{status.clearBlockedReason}</p>}{!status && <p className="history-notice error">历史状态暂不可读，请稍后重试。</p>}
    {error && <p className="history-notice error" role="alert">{error}</p>}{notice && <p className="history-notice" role="status">{notice}</p>}
    <div className="history-layout"><aside className="history-list" aria-label="历史轮次">
      <p className="fine">{page ? `共 ${page.total} 条 · 按创建时间倒序` : "正在加载历史…"}</p>
      {page?.total === 0 && <p className="empty">还没有历史记录。启用 T12 后取得的材料会自动保存。</p>}
      {page?.items.map(item => <button key={item.id} className={`history-item ${item.id === selected ? "selected" : ""}`} onClick={() => { setSelected(item.id); setNotice(""); }}><time>{item.createdAt ? new Date(item.createdAt).toLocaleString() : "时间不可读"}</time><strong>{item.sourceName}</strong><span>{clock(item.durationMs)} · {item.corrupt ? "记录损坏／删除未完成" : historyStageNames[item.stage]}</span>{item.issue && <small className="error">{item.issue}</small>}{item.locked && <small>正在写入或等待结果 · 暂不可删除</small>}{item.simulated && <small>模拟测试</small>}</button>)}
      {!!page?.total && <div className="action-row"><button disabled={!offset} onClick={() => setOffset(n => Math.max(0, n - 30))}>上一页</button><button disabled={page.nextOffset === null} onClick={() => setOffset(page.nextOffset!)}>下一页</button></div>}
    </aside><div className="history-reading">{selected ? <><div className="history-delete"><button disabled={!shown || !!locked} onClick={() => void remove(false)}>删除这条记录</button>{locked && <span className="fine">正在写入、等待结果或执行删除，暂不可删除。</span>}</div>{shown ? <Details key={selected} detail={shown} blocked={!status || status.playbackBlocked} /> : <p className="empty">正在读取这条记录…</p>}</> : <p className="empty">选择一条记录，回顾截图、声音和理解。</p>}</div></div>
  </main>;
}
