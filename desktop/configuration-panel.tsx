import { useCallback, useEffect, useRef, useState } from "react";
import { getAsrPreset } from "../shared/asr-providers";
import type { ConfigurationStatus, DesktopApi, ConnectionTestResult, ConfigurationAction, ConfigurationPayload, AnalysisTestRequest } from "./shared";
import { CONFIGURATION_ERROR_COPY } from "./configuration-copy";
import { AddConfigurationDialog, ConnectionTestNotice } from "./configuration-dialog";

export function ConfigurationPanel({ api = window.desktop }: { api?: Pick<DesktopApi, "configuration" | "onSettingsVisibility" | "testAnalysis"> }) {
  const [config, setConfig] = useState<ConfigurationStatus | null>(null);
  const [modal, setModal] = useState<"analysis" | "asr" | null>(null);
  const [busy, setBusy] = useState<ConfigurationAction | "test" | null>("status");
  const [notice, setNotice] = useState(""), [failure, setFailure] = useState("");
  const [testFailure, setTestFailure] = useState("");
  const [test, setTest] = useState<ConnectionTestResult | null>(null);
  const testFeedback = useRef<HTMLDivElement>(null);
  const pending = useRef(false), generation = useRef(0);
  const analysisAdd = useRef<HTMLButtonElement>(null), asrAdd = useRef<HTMLButtonElement>(null), opener = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    // Restore after React removes the dialog and re-enables the opener. Native
    // close restoration alone runs too late on unmount / while save is busy.
    if (!modal && !busy) { opener.current?.focus(); opener.current = null; }
  }, [modal, busy]);
  useEffect(() => {
    // Keep feedback beside the triggering button and inside the settings
    // viewport, including when its scroll position was near the ASR section.
    if (!modal && (busy === "test" || test || testFailure)) testFeedback.current?.scrollIntoView({ block: "nearest" });
  }, [modal, busy, test, testFailure]);
  const run = useCallback(async (action: ConfigurationAction, payload?: ConfigurationPayload) => {
    if (pending.current) return;
    const id = ++generation.current;
    pending.current = true; setBusy(action); setNotice(""); setFailure(""); setTestFailure(""); setTest(null);
    try {
      const next = await api.configuration(action, payload);
      if (id !== generation.current) return;
      setConfig(next);
      if (next.error) setFailure(CONFIGURATION_ERROR_COPY[next.error]);
      else if (action.startsWith("add-")) { setModal(null); setNotice("已加密保存并选中新配置。下一轮及主动重试使用所选配置。"); }
      else if (action.startsWith("delete-")) setNotice("已删除所选配置。可选择其他已保存配置，或添加新配置；已开始的本轮不变。");
      else if (action.startsWith("select-")) setNotice("已保存选择。下一轮及主动重试使用所选配置；已开始的本轮不变。");
      else if (action === "import") setNotice("导入操作结束。有效配置会加入列表并选中，已有配置保留。");
    } catch { if (id === generation.current) setFailure("配置操作未完成，请重试。"); }
    finally { if (id === generation.current) { pending.current = false; setBusy(null); } }
  }, [api]);
  useEffect(() => {
    const epoch = generation;
    const id = ++epoch.current; pending.current = true;
    void api.configuration("status").then(next => {
      if (id !== epoch.current) return;
      setConfig(next); if (next.error) setFailure(CONFIGURATION_ERROR_COPY[next.error]);
    }).catch(() => { if (id === epoch.current) setFailure("配置读取失败，请重新打开设置。"); })
      .finally(() => { if (id === epoch.current) { pending.current = false; setBusy(null); } });
    const unsubscribe = api.onSettingsVisibility(() => {
      ++generation.current; pending.current = false; setModal(null); setTest(null);
      void api.testAnalysis("cancel").catch(() => undefined); void run("status");
    });
    return () => { unsubscribe(); ++epoch.current; void api.testAnalysis("cancel").catch(() => undefined); };
  }, [api, run]);
  const testConnection = async (request: AnalysisTestRequest) => {
    if (pending.current) return;
    const id = ++generation.current; pending.current = true; setBusy("test"); setTest(null); setFailure(""); setTestFailure(""); setNotice("");
    try {
      const result = await api.testAnalysis("start", request);
      if (id === generation.current) {
        if (result) setTest(result);
        else setTestFailure("连接测试未返回结果，请重试。");
      }
    }
    catch { if (id === generation.current) setTestFailure("连接测试未完成，请稍后重试。"); }
    finally { if (id === generation.current) { pending.current = false; setBusy(null); } }
  };
  const cancelTest = () => { void api.testAnalysis("cancel").catch(() => undefined); };
  const closeModal = () => {
    if (busy && busy !== "test") return;
    if (busy === "test") cancelTest();
    ++generation.current; pending.current = false; setBusy(null); setModal(null); setTest(null); setFailure(""); setTestFailure("");
  };
  const openModal = (kind: "analysis" | "asr") => { opener.current = kind === "analysis" ? analysisAdd.current : asrAdd.current; setFailure(""); setTestFailure(""); setNotice(""); setTest(null); setModal(kind); };
  const analysis = config?.analysisProfiles ?? [], asr = config?.asrProfiles ?? [];
  return <section className="configuration">
    <p className="configuration-state">{busy === "status" ? "正在读取配置…" : `分析${config?.analysisReady ? "已配置" : "未选择"} · 转写${config?.asrReady ? "已配置" : "未选择"}`}</p>
    <section className="configuration-profile" aria-label="分析模型配置">
      <div className="configuration-field"><label htmlFor="config-analysis-list">分析模型配置</label>
        <div className="configuration-picker"><select id="config-analysis-list" disabled={busy !== null || !analysis.length} value={config?.selectedAnalysisId ?? ""} onChange={event => void run("select-analysis", { id: event.target.value })}>
          <option value="" disabled>{analysis.length ? "请选择配置" : "暂无已保存配置"}</option>
          {analysis.map(profile => <option key={profile.id} value={profile.id}>{profile.model} · {profile.baseUrl}</option>)}
        </select><button ref={analysisAdd} type="button" aria-label="添加分析配置" disabled={busy !== null} onClick={() => openModal("analysis")}>添加</button><button type="button" aria-label="删除选中的分析配置" disabled={busy !== null || !config?.selectedAnalysisId} onClick={() => void run("delete-analysis", { id: config!.selectedAnalysisId! })}>删除</button></div>
      </div>
      {config?.selectedAnalysisId && <p className="fine configuration-profile-info">{config.baseUrl} · {config.hasAnalysisKey ? "密钥已保存" : "无鉴权"} · {config.mode === "json" ? "结构化反馈" : "自然语言反馈"}</p>}
      <div ref={testFeedback} className="configuration-test">
        <button type="button" disabled={busy !== null || !config?.selectedAnalysisId} onClick={() => void testConnection({ kind: "saved", id: config!.selectedAnalysisId! })}>{busy === "test" && !modal ? "正在测试…" : "测试分析连接"}</button>
        {!modal && <><ConnectionTestNotice busy={busy === "test"} test={test} onCancel={cancelTest} />{testFailure && <p role="alert" className="error">{testFailure}</p>}</>}
      </div>
    </section>
    <section className="configuration-profile" aria-label="ASR 配置">
      <div className="configuration-field"><label htmlFor="config-asr-list">语音转写配置（ASR）</label>
        <div className="configuration-picker"><select id="config-asr-list" disabled={busy !== null || !asr.length} value={config?.selectedAsrId ?? ""} onChange={event => void run("select-asr", { id: event.target.value })}>
          <option value="" disabled>{asr.length ? "请选择配置" : "暂无已保存配置"}</option>
          {asr.map((profile, index) => <option key={profile.id} value={profile.id}>{getAsrPreset(profile.provider)?.label} · 配置 {index + 1}</option>)}
        </select><button ref={asrAdd} type="button" aria-label="添加 ASR 配置" disabled={busy !== null} onClick={() => openModal("asr")}>添加</button><button type="button" aria-label="删除选中的 ASR 配置" disabled={busy !== null || !config?.selectedAsrId} onClick={() => void run("delete-asr", { id: config!.selectedAsrId! })}>删除</button></div>
      </div>
      <p className="fine">厂家预设地址、模型与协议，添加时只需选择厂家并填写 Key。当前支持百炼（北京）。</p>
    </section>
    <p className="fine">选择后自动保存；新添加的配置自动选中。分析和 ASR 独立选择，已开始的本轮不变。本地分析搭配云端转写仍需联网。</p>
    {!modal && <>{failure && <p role="alert" className="error">{failure}</p>}{notice && <p role="status" className="configuration-notice">{notice}</p>}</>}
    <p className="fine">连接测试只发送少量生成的文字和图片，可能产生服务费用；不录音、不截桌面、不读取历史，每步最多 3 分钟。测试通过仍需真实资料验收。</p>
    <div className="action-row configuration-utilities"><button disabled={busy !== null} onClick={() => void run("import")}>导入配置…</button></div>
    {modal && <AddConfigurationDialog kind={modal} busy={busy !== null} testing={busy === "test"} failure={failure || testFailure} test={test} onCancelTest={cancelTest} onClose={closeModal}
      onEdit={() => { setFailure(""); setTestFailure(""); setTest(null); }}
      onSave={payload => void run(modal === "analysis" ? "add-analysis" : "add-asr", payload)} onTest={request => void testConnection(request)} />}
  </section>;
}
