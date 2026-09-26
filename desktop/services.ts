import "../trusted/node-only";
import { createAsrChannel, type AsrProxyOptions } from "../trusted/asr";
import { analyze, type AnalysisDependencies } from "../trusted/analysis/service";
import { validateInput } from "../trusted/analysis/input";
import { isRecord, errorResponse, type AnalysisInput, type AnalysisResponse, type AnalysisOutputIssue } from "../shared/analysis-contract";
import { AsrClientError } from "../shared/asr-errors";
import type { TranscriptUpdate } from "../shared/transcript";
import type { Configuration } from "./config";
import { readAsrConfiguration } from "../trusted/asr-configuration";

export interface AsrConnection {
  start(): Promise<void>;
  send(bytes: ArrayBuffer): void;
  finish(): Promise<void>;
  cancel(): void;
}
export interface LearningServices {
  readonly simulated: boolean;
  configuration(): Configuration;
  asr(config: Configuration, update: (value: TranscriptUpdate) => void, failure: (error: AsrClientError) => void): AsrConnection;
  validate(value: unknown): Promise<AnalysisInput | null>;
  analyze(input: AnalysisInput, config: Configuration, signal: AbortSignal, issue: (value: AnalysisOutputIssue) => void): Promise<AnalysisResponse>;
}
function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  // Both promises exist before any asynchronous service event, including startup failure.
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export class CloudAsrConnection implements AsrConnection {
  private ready = deferred();
  private ended = deferred();
  private state: "idle" | "starting" | "running" | "finishing" | "ended" = "idle";
  private channel: ReturnType<typeof createAsrChannel>;
  constructor(config: Configuration, update: (value: TranscriptUpdate) => void, failure: (error: AsrClientError) => void, options: Partial<AsrProxyOptions> = {}) {
    const asr = readAsrConfiguration(config);
    this.channel = createAsrChannel({ ...options, provider: config.ASR_PROVIDER, apiKeyProvider: () => asr?.apiKey }, message => {
      if (this.state === "ended" || !isRecord(message)) return;
      if (message.type === "ready") { this.state = "running"; this.ready.resolve(); }
      if (message.type === "transcript" && typeof message.sentenceId === "number" && typeof message.text === "string" && typeof message.final === "boolean") {
        update({ id: message.sentenceId, text: message.text, final: message.final });
      }
      if (message.type === "finished") { this.state = "ended"; this.ended.resolve(); }
      if (message.type === "error") {
        this.state = "ended";
        const codes = ["missing-api-key", "empty-audio", "audio-format", "connection-timeout", "network-interruption", "service-error"];
        const code = codes.includes(String(message.code)) ? message.code as AsrClientError["code"] : "service-error";
        const error = new AsrClientError(code, typeof message.message === "string" ? message.message : "语音转写失败。");
        this.ready.reject(error); this.ended.reject(error); failure(error);
      }
    });
  }
  private control(type: string) { this.channel.accept(Buffer.from(JSON.stringify({ type, format: "pcm", sampleRate: 16000, channels: 1 })), false); }
  start() { if (this.state !== "idle") throw new Error("asr_state"); this.state = "starting"; this.control("start"); return this.ready.promise; }
  send(bytes: ArrayBuffer) {
    if (this.state !== "starting" && this.state !== "running") throw new AsrClientError("network-interruption", "转写已中断，本轮未完成。");
    this.channel.accept(bytes, true);
    if (this.stateEnded()) throw new AsrClientError("connection-timeout", "音频发送失败，本轮转写未完成。");
  }
  private stateEnded() { return this.state === "ended"; }
  finish() {
    if (this.state === "finishing") return this.ended.promise;
    if (this.state !== "running") return Promise.reject(new AsrClientError("network-interruption", "转写连接已结束，请重新录制。"));
    this.state = "finishing"; this.control("finish"); return this.ended.promise;
  }
  cancel() {
    this.state = "ended"; this.channel.cancel();
    const error = new AsrClientError("cancelled", "本轮已取消。"); this.ready.reject(error); this.ended.reject(error);
  }
}
export function createCloudServices(configuration: () => Configuration, dependencies: AnalysisDependencies = {}, asrOptions: Partial<AsrProxyOptions> = {}): LearningServices {
  return {
    simulated: false, configuration,
    asr: (config, update, failure) => new CloudAsrConnection(config, update, failure, asrOptions),
    validate: validateInput,
    analyze: async (input, config, signal, issue) => {
      const response = await analyze(input, signal, { ...dependencies, env: { ...config }, onValidationFailure: issue });
      // Never expose a credential even if a faulty upstream echoes an Authorization value.
      const keys = [config.ANALYSIS_API_KEY, config.ASR_API_KEY, config.DASHSCOPE_API_KEY].filter(Boolean);
      return keys.some(key => JSON.stringify(response).includes(key!.trim())) ? errorResponse("invalid_model_output") : response;
    },
  };
}
