import { useEffect, useRef, useState } from "react";
import { DEFAULT_ANALYSIS_MODEL } from "../shared/analysis-models";
import { ASR_PRESETS, DEFAULT_ASR_PROVIDER, getAsrPreset } from "../shared/asr-providers";
import type { AnalysisConfigurationDraft, AnalysisTestRequest, AsrConfigurationDraft, ConnectionTestResult } from "./shared";

export function ConnectionTestNotice({ busy, test, onCancel }: { busy: boolean; test: ConnectionTestResult | null; onCancel(): void }) {
  return <>{busy && <div role="status" aria-atomic="true" className="configuration-test-notice"><p>正在测试文字与图片请求… 每步最多 3 分钟。</p><button type="button" onClick={onCancel}>取消测试</button></div>}
    {test && <div role="status" aria-atomic="true" className="configuration-test-notice"><p>服务可访问：{test.reachable ? "收到 HTTP 响应" : "尚未确认"}；文字请求：{test.text === "passed" ? "成功" : test.text === "failed" ? "失败" : "未完成"}；图片请求：{test.image === "passed" ? "成功" : test.image === "failed" ? "失败" : "未完成"}。</p><p>{test.cancelled ? "已取消测试。" : test.error ?? (test.imageObservation === "matched" ? "测试图辨认匹配；仍需用真实资料和转写验收学习质量。" : "未确认图片理解能力；仅接口成功不代表模型看懂图片。")}</p></div>}</>;
}
export function AddConfigurationDialog({ kind, busy, testing, failure, test, onClose, onSave, onTest, onCancelTest, onEdit }: {
  kind: "analysis" | "asr"; busy: boolean; testing: boolean; failure: string; test: ConnectionTestResult | null;
  onClose(): void; onSave(value: AnalysisConfigurationDraft | AsrConfigurationDraft): void; onTest(value: AnalysisTestRequest): void; onCancelTest(): void; onEdit(): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), key = useRef<HTMLInputElement>(null);
  const [analysis, setAnalysis] = useState<Omit<AnalysisConfigurationDraft, "apiKey">>({ baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1", model: DEFAULT_ANALYSIS_MODEL, mode: "text" });
  const [provider, setProvider] = useState(DEFAULT_ASR_PROVIDER);
  const preset = getAsrPreset(provider)!;
  useEffect(() => {
    const modal = dialog.current, input = key.current;
    modal?.showModal(); input?.focus();
    return () => { if (input) input.value = ""; modal?.close(); };
  }, []);
  const analysisDraft = (): AnalysisConfigurationDraft => ({ ...analysis, apiKey: key.current?.value ?? "" });
  return <dialog ref={dialog} className="configuration-dialog" aria-labelledby="configuration-dialog-title" onCancel={event => { event.preventDefault(); onClose(); }}>
    <div className="configuration-dialog-heading"><h2 id="configuration-dialog-title">{kind === "analysis" ? "添加分析配置" : "添加 ASR 配置"}</h2><button type="button" aria-label="关闭添加配置" disabled={busy && !testing} onClick={onClose}>×</button></div>
    <form onSubmit={event => { event.preventDefault(); onSave(kind === "analysis" ? analysisDraft() : { provider, apiKey: key.current?.value ?? "" }); }}>
      <fieldset disabled={busy} className="configuration-fields">
        {kind === "asr" && <div className="configuration-field"><label htmlFor="config-asr-provider">厂家</label><select id="config-asr-provider" value={provider} onChange={event => {
          const next = getAsrPreset(event.target.value); if (!next || next.id === provider) return;
          if (key.current) key.current.value = ""; setProvider(next.id); onEdit();
        }}>{ASR_PRESETS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select><p className="fine">{preset.description}</p></div>}
        <div className="configuration-field"><label htmlFor="config-new-key">API Key</label><input ref={key} id="config-new-key" type="password" autoComplete="off" spellCheck={false} maxLength={4096} required={kind === "asr"} placeholder={kind === "analysis" ? "无鉴权本地服务可留空" : "填写所选厂家的 Key"} onChange={onEdit} /></div>
        {kind === "analysis" && <>
          <div className="configuration-field"><label htmlFor="config-url">服务地址（API Base URL）</label><input id="config-url" type="text" required maxLength={2048} autoComplete="off" spellCheck={false} value={analysis.baseUrl} onChange={event => { setAnalysis(p => ({ ...p, baseUrl: event.target.value })); onEdit(); }} /><p className="fine">填写到 /v1 或服务的代理路径前缀，程序追加 /chat/completions。</p></div>
          <div className="configuration-field"><label htmlFor="config-model">模型名称</label><input id="config-model" type="text" required maxLength={256} autoComplete="off" spellCheck={false} value={analysis.model} onChange={event => { setAnalysis(p => ({ ...p, model: event.target.value })); onEdit(); }} /><p className="fine">填写服务实际提供的完整模型标识，学习分析需要支持图片。</p></div>
          <details className="fine"><summary>反馈格式与地址示例</summary><div className="configuration-field"><label htmlFor="config-mode">反馈格式</label><select id="config-mode" value={analysis.mode} onChange={event => { setAnalysis(p => ({ ...p, mode: event.target.value as AnalysisConfigurationDraft["mode"] })); onEdit(); }}><option value="text">自然语言（默认）</option><option value="json">结构化五字段</option></select></div><p>结构化模式需要服务支持 JSON Schema。</p><p>Ollama：http://localhost:11434/v1；LM Studio：http://localhost:1234/v1。只兼容 Chat Completions；应用不安装或启动模型。</p></details>
        </>}
        {kind === "asr" && <details className="fine"><summary>查看 ASR 预设信息</summary><p>服务地址：{preset.endpoint}</p><p>模型：{preset.model}</p><p>实时流式转写 · 16 kHz 单声道 PCM</p></details>}
        <p className="fine">密钥加密保存，不回显。新配置不继承其他配置的密钥；保存不开始录音或调用模型。</p>
        <div className="action-row"><button type="submit" className="primary">{busy && !testing ? "正在保存…" : "保存"}</button><button type="button" onClick={onClose}>取消</button>{kind === "analysis" && <button type="button" onClick={() => onTest({ kind: "draft", draft: analysisDraft() })}>{testing ? "正在测试…" : "测试此配置"}</button>}</div>
      </fieldset>
    </form>
    {kind === "analysis" && <p className="fine">测试发送生成的文字和图片，可能计费，不自动保存；每步最多 3 分钟。</p>}
    <ConnectionTestNotice busy={testing} test={test} onCancel={onCancelTest} />
    {failure && <p role="alert" className="error">{failure}</p>}
  </dialog>;
}
