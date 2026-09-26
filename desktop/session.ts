import { AsrClientError } from "../shared/asr-errors";
import { readConfiguration } from "../trusted/analysis/configuration";
import { readAsrConfiguration } from "../trusted/asr-configuration";
import { applyTranscriptUpdate, emptyTranscript, getFinalTranscript, type TranscriptUpdate } from "../shared/transcript";
import { ERROR_COPY, OUTPUT_ERROR_COPY, type AnalysisInput } from "../shared/analysis-contract";
import type { LearningServices, AsrConnection } from "./services";
import type { HistoryRound, HistoryStore } from "./history";
import { MAX_ROUND_MS, type ActionResult, type Artifacts, type MediaCommand, type MediaEvent, type MediaValue, type Snapshot, type Source, type PcmPacket } from "./shared";

type CommandInput = MediaCommand extends infer C ? C extends MediaCommand ? Omit<C, "id"> : never : never;
export interface MediaPort { call(command: CommandInput, signal?: AbortSignal): Promise<MediaValue> }
export class DesktopSession {
  private state: Snapshot = { sessionId: 0, roundId: 0, revision: 0, phase: "idle", source: null, recording: false, startedAt: null, elapsedMs: 0, busy: false, feedback: null, error: null, artifacts: { start: null, end: null, audio: null }, hidden: false, hiddenIntervals: [], transcript: structuredClone(emptyTranscript), transcriptComplete: false, analysis: null, requestId: 0, retryable: false, errorStage: null, outputIssue: null, timings: {}, simulated: false };
  private data: Artifacts = {};
  private operation: AbortController | null = null;
  private asr: AsrConnection | null = null;
  private sequence = 0;
  private input: AnalysisInput | null = null;
  private roundConfiguration: ReturnType<LearningServices["configuration"]> | null = null;
  private limitTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();
  private exitPromise: Promise<ActionResult> | null = null;
  private archive: HistoryRound | null = null;
  constructor(private media: MediaPort, private quitApp: () => void, private services: LearningServices, private history?: HistoryStore) { this.state.simulated = services.simulated; }
  snapshot = (): Snapshot => structuredClone({ ...this.state, elapsedMs: this.state.recording && this.state.startedAt ? Date.now() - this.state.startedAt : this.state.elapsedMs });
  artifacts = () => this.data;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private publish(patch: Partial<Snapshot>) { this.state = { ...this.state, ...patch, revision: this.state.revision + 1 }; this.listeners.forEach(f => f()); }
  private begin(phase: Snapshot["phase"]) {
    this.operation?.abort(); this.clearTimer();
    const c = new AbortController(); this.operation = c;
    this.publish({ phase, busy: true, error: null, errorStage: null }); return c;
  }
  private current(c: AbortController) { return this.operation === c && !c.signal.aborted; }
  private clearTimer() { if (this.limitTimer) clearTimeout(this.limitTimer); this.limitTimer = null; }
  private closeServices() { this.asr?.cancel(); this.asr = null; }
  private resetRound() {
    this.archive?.close(); this.archive = null;
    this.closeServices(); this.data = {}; this.input = null; this.roundConfiguration = null; this.sequence = 0;
    this.publish({ roundId: this.state.roundId + 1, feedback: null, analysis: null, retryable: false, outputIssue: null, transcript: structuredClone(emptyTranscript), transcriptComplete: false, timings: {}, startedAt: null, elapsedMs: 0, recording: false, artifacts: { start: null, end: null, audio: null }, hiddenIntervals: [] });
  }
  private command(type: "start" | "finish" | "cancel" | "dispose"): CommandInput { return { type, sessionId: this.state.sessionId, roundId: this.state.roundId }; }
  async select(source: Source): Promise<ActionResult> {
    if (this.history?.clearing) return { ok: false, message: "正在清除历史，请稍后操作。" };
    if (this.state.busy || this.state.recording || this.state.phase === "exiting") return { ok: false, message: "请先结束并检查，待本轮处理完成后再更换资料。" };
    const c = this.begin("selecting"); this.resetRound();
    this.publish({ sessionId: this.state.sessionId + 1, source: null });
    try {
      await this.media.call(this.command("dispose"), c.signal);
      if (!this.current(c)) return { ok: false };
      const result = await this.media.call({ type: "select", source, sessionId: this.state.sessionId, roundId: this.state.roundId }, c.signal);
      if (!this.current(c)) return { ok: false };
      if (result.type !== "selected") throw new Error("source");
      this.publish({ source, phase: "ready", busy: false }); return { ok: true };
    } catch { return this.fail(c, "资料连接失败或已取消。请重新选择可见的窗口或屏幕。", "media", true); }
  }
  async start(revision: number): Promise<ActionResult> {
    if (this.history?.clearing) return { ok: false, message: "正在清除历史，请稍后开始。" };
    if (revision !== this.state.revision || this.state.busy || !this.state.source || !["ready", "feedback", "error"].includes(this.state.phase)) return { ok: false, message: "状态已更新，请查看当前操作。" };
    const c = this.begin("connecting"); this.resetRound();
    const id = { sessionId: this.state.sessionId, roundId: this.state.roundId };
    const roundCurrent = () => id.sessionId === this.state.sessionId && id.roundId === this.state.roundId && this.state.phase !== "exiting";
    let stage: Snapshot["errorStage"] = "asr";
    const connectionStart = Date.now();
    try {
      const config = this.services.configuration();
      if (!this.services.simulated && (!readConfiguration(config) || !readAsrConfiguration(config)?.apiKey)) return this.fail(c, "请先在设置中配置分析服务，并选择 ASR 厂家、填写独立密钥，再开始解释。", "configuration", false);
      this.roundConfiguration = { ...config };
      this.asr = this.services.asr(config, value => { if (roundCurrent()) this.transcript(value); }, error => {
        if (!roundCurrent()) return;
        const failed = this.begin("stopping"); void this.fail(failed, error.message, "asr", false);
      });
      await this.asr.start();
      if (!this.current(c)) return { ok: false };
      this.publish({ phase: "starting", timings: { connectionMs: Date.now() - connectionStart } }); stage = "media";
      const mediaStart = Date.now();
      const result = await this.media.call(this.command("start"), c.signal);
      if (!this.current(c)) return { ok: false };
      if (result.type !== "started") throw new Error("audio");
      this.data.start = result.start;
      this.archive = this.history?.begin(this.state.source!.name, result.startedAt, this.services.simulated) ?? null;
      this.archive?.update({}, { start: result.start });
      const { dataUrl: _dataUrl, ...start } = result.start; void _dataUrl;
      this.publish({ phase: "recording", busy: false, recording: true, startedAt: result.startedAt, timings: { ...this.state.timings, mediaStartMs: Date.now() - mediaStart }, artifacts: { ...this.state.artifacts, start }, hiddenIntervals: this.state.hidden ? [{ start: result.startedAt, end: null }] : [] });
      this.limitTimer = setTimeout(() => { void this.check(this.state.revision); }, MAX_ROUND_MS);
      return { ok: true };
    } catch (error) {
      return this.fail(c, error instanceof AsrClientError ? error.message : error instanceof Error && error.message === "denied" ? "麦克风访问被拒绝。请检查 Windows 麦克风权限后重试。" : "截图或录音启动失败。请检查资料和麦克风。", stage, false);
    }
  }
  private transcript(value: TranscriptUpdate) {
    const transcript = applyTranscriptUpdate(this.state.transcript, value);
    if (transcript === this.state.transcript) return;
    if (JSON.stringify(transcript).length > 256 * 1024 || transcript.finalSentences.length > 10000) {
      const c = this.begin("stopping"); void this.fail(c, "转写超过本轮资源上限，请分成较短段落。", "asr", false); return;
    }
    this.publish({ transcript });
  }
  receivePcm(packet: PcmPacket): boolean {
    if (packet.sessionId !== this.state.sessionId || packet.roundId !== this.state.roundId) return false;
    if (!this.asr || !["starting", "recording", "stopping"].includes(this.state.phase)) return false;
    try {
      if (packet.sequence !== this.sequence) throw new AsrClientError("audio-format", "音频分片顺序异常，本轮转写未完成。");
      this.asr.send(packet.bytes); this.sequence++; return true;
    } catch (error) {
      const c = this.begin("stopping"); void this.fail(c, error instanceof AsrClientError ? error.message : "音频发送失败，本轮转写未完成。", "asr", false); return false;
    }
  }
  async check(revision: number): Promise<ActionResult> {
    if (revision !== this.state.revision || this.state.busy || this.state.phase !== "recording") return { ok: false, message: "本轮尚未开始或正在检查。" };
    const c = this.begin("stopping"); const stopStart = Date.now(); const archive = this.archive;
    let stage: Snapshot["errorStage"] = "media";
    try {
      const result = await this.media.call(this.command("finish"), c.signal);
      if (!this.current(c)) return { ok: false };
      if (result.type !== "finished") throw new Error("audio");
      this.data.end = result.end; this.data.audio = result.audio;
      archive?.update({ stage: "transcribing", durationMs: result.audio.durationMs }, { end: result.end, audio: result.audio });
      if (result.lastSequence !== this.sequence - 1) throw new AsrClientError("audio-format", "最后的音频分片尚未完整交付，本轮未分析。");
      const { dataUrl: _dataUrl, ...end } = result.end; void _dataUrl;
      this.closeHiddenInterval();
      this.publish({ phase: "transcribing", recording: false, elapsedMs: result.audio.durationMs, timings: { ...this.state.timings, stopMs: Date.now() - stopStart }, artifacts: { ...this.state.artifacts, end, audio: { ...result.audio, bytes: result.audio.bytes.byteLength } } });
      stage = "asr"; const transcriptStart = Date.now();
      if (!this.asr) throw new Error("asr");
      await this.asr.finish();
      if (!this.current(c)) return { ok: false };
      this.asr = null;
      if (this.state.transcript.interimSentence?.text) throw new AsrClientError("service-error", "服务结束时仍有未确认的临时句，本轮转写未完成，请重新解释。");
      this.publish({ transcriptComplete: true, timings: { ...this.state.timings, finalTranscriptMs: Date.now() - transcriptStart } });
      archive?.update({ transcript: getFinalTranscript(this.state.transcript), stage: "analyzing" });
      stage = "input";
      const input = await this.services.validate({ start_screenshot: this.data.start?.dataUrl, end_screenshot: this.data.end?.dataUrl, transcript: getFinalTranscript(this.state.transcript) });
      if (!this.current(c)) return { ok: false };
      if (!input) return this.fail(c, ERROR_COPY.invalid_input.message, "input", false);
      this.input = Object.freeze(input);
      return this.runAnalysis(c);
    } catch (error) { return this.fail(c, error instanceof AsrClientError ? error.message : stage === "asr" ? "等待最终转写失败，请重新解释。" : "结束截图或录音读取失败。本轮未分析，请恢复资料后重新开始。", stage, false); }
  }
  private async runAnalysis(c: AbortController): Promise<ActionResult> {
    const input = this.input;
    const archive = this.archive;
    if (!input || !this.current(c)) return { ok: false };
    const config = { ...(this.roundConfiguration ?? this.services.configuration()) };
    const requestId = this.state.requestId + 1; const began = Date.now();
    this.publish({ phase: "processing", requestId, retryable: false, outputIssue: null, error: null, errorStage: null });
    try {
      const response = await this.services.analyze(input, config, c.signal, outputIssue => { if (this.current(c) && this.state.requestId === requestId) this.publish({ outputIssue }); });
      if (!this.current(c) || this.state.requestId !== requestId) return { ok: false };
      this.publish({ analysis: response, timings: { ...this.state.timings, analysisMs: Date.now() - began } });
      if (!response.ok) {
        const error = response.error.code === "configuration_error" ? "分析配置无效。请在设置中修改并保存，再使用本次内容重试。" : this.state.outputIssue ? OUTPUT_ERROR_COPY[this.state.outputIssue] : response.error.message;
        archive?.update({ stage: "failed", reason: "分析失败，未获得反馈。可在当前学习轮次重试。" }); archive?.settle();
        this.publish({ phase: "error", busy: false, retryable: response.error.retryable, errorStage: "analysis", error }); return { ok: false, message: error };
      }
      const feedback = response.mode === "text" ? { mode: "text" as const, message: response.result.message } : { mode: "json" as const, message: response.result.message, fields: { topic: response.result.topic, understanding: response.result.understanding, verdict: response.result.verdict, evidence: response.result.evidence } };
      archive?.update({ stage: "complete", reason: null, feedback }); archive?.settle();
      this.publish({ phase: "feedback", busy: false, feedback: response.result.message }); return { ok: true };
    } catch {
      if (!this.current(c)) return { ok: false };
      archive?.update({ stage: "failed", reason: "分析请求失败，未获得反馈。" }); archive?.settle();
      this.publish({ phase: "error", busy: false, retryable: true, errorStage: "analysis", error: "分析请求失败，可使用本次内容重试。", timings: { ...this.state.timings, analysisMs: Date.now() - began } }); return { ok: false };
    }
  }
  async retry(revision: number) {
    if (this.history?.clearing) return { ok: false, message: "正在清除历史，请稍后重试。" };
    if (revision !== this.state.revision || this.state.busy || !this.state.retryable || !this.input) return { ok: false };
    // Deleted records never return. Current analysis retry remains available without recreating history.
    if (this.archive?.retry()) this.archive.update({ stage: "analyzing", reason: null });
    else if (this.archive) { this.archive.close(); this.archive = null; }
    this.roundConfiguration = { ...this.services.configuration() };
    return this.runAnalysis(this.begin("processing"));
  }
  async cancel(all = false): Promise<ActionResult> {
    if (this.state.phase === "exiting") return { ok: false };
    const c = this.begin("stopping"); this.resetRound();
    if (all) this.publish({ sessionId: this.state.sessionId + 1, source: null });
    try { await this.media.call(this.command(all ? "dispose" : "cancel"), c.signal); }
    catch { if (this.current(c)) this.publish({ source: null, error: "清理失败，请重新选择资料。" }); }
    if (this.current(c)) this.publish({ phase: this.state.source ? "ready" : "idle", busy: false });
    return { ok: true };
  }
  private async fail(c: AbortController, error: string, errorStage: Snapshot["errorStage"], dropSource: boolean): Promise<ActionResult> {
    if (!this.current(c)) return { ok: false };
    this.archive?.update({ stage: "failed", reason: errorStage === "asr" ? "最终转写未完成，临时文字未存为最终转写；未获得反馈。" : errorStage === "input" ? "已取得的材料未满足分析条件，未获得反馈。" : "媒体中断，仅保留已可靠取得的材料；未获得反馈。" }); this.archive?.settle();
    this.closeServices(); this.clearTimer(); this.input = null;
    this.publish({ roundId: this.state.roundId + 1, retryable: false, transcriptComplete: errorStage === "input" && this.state.transcriptComplete }); this.closeHiddenInterval();
    try { await this.media.call(this.command(dropSource ? "dispose" : "cancel"), c.signal); } catch { dropSource = true; }
    if (this.current(c)) this.publish({ phase: "error", recording: false, busy: false, source: dropSource ? null : this.state.source, error, errorStage });
    return { ok: false, message: error };
  }
  handleMediaEvent(event: MediaEvent) {
    if (event.sessionId !== this.state.sessionId || this.state.phase === "exiting") return;
    if (event.kind !== "source-ended" && event.roundId !== this.state.roundId) return;
    if (event.kind === "recording-stopped") {
      this.closeHiddenInterval(); this.publish({ recording: false, elapsedMs: this.state.startedAt ? Date.now() - this.state.startedAt : 0 }); return;
    }
    const c = this.begin("stopping");
    void this.fail(c, event.kind === "source-ended" ? "资料来源已结束。录音已停止，请重新选择。" : event.kind === "pcm-error" ? "音频发送拥塞或中断，本轮转写未完成，请重新解释。" : "麦克风或采集发生中断。请检查设备后重新开始。", event.kind === "pcm-error" ? "asr" : "media", event.kind === "source-ended");
  }
  hostFailed() { this.handleMediaEvent({ sessionId: this.state.sessionId, roundId: this.state.roundId, kind: "source-ended" }); }
  setHidden(hidden: boolean) {
    if (this.state.hidden === hidden) return;
    if (this.state.recording) { if (hidden) this.state.hiddenIntervals.push({ start: Date.now(), end: null }); else this.closeHiddenInterval(); }
    this.publish({ hidden });
  }
  private closeHiddenInterval() { const last = this.state.hiddenIntervals.at(-1); if (last && last.end === null) last.end = Date.now(); }
  quit(): Promise<ActionResult> {
    if (this.exitPromise) return this.exitPromise;
    const c = this.begin("exiting"); this.archive?.close(); this.closeServices();
    this.exitPromise = this.media.call(this.command("dispose"), c.signal).catch(() => undefined).then(() => {
      return this.history?.flush() ?? true;
    }).then(saved => {
      if (!saved) {
        this.exitPromise = null;
        this.publish({ recording: false, source: null, busy: false, phase: this.state.feedback ? "feedback" : "error" });
        return { ok: false, message: "历史保存失败，已暂停退出并保留当前内容。请修复磁盘空间或权限后再次退出。" };
      }
      this.resetRound(); this.publish({ recording: false, source: null, busy: false }); this.quitApp(); return { ok: true };
    }); return this.exitPromise;
  }
}
