import type { AnalysisMode, AnalysisResponse, AnalysisOutputIssue } from "../shared/analysis-contract";
import type { TranscriptState } from "../shared/transcript";
import type { AsrProviderId } from "../shared/asr-providers";
import type { HistoryDetail, HistoryPage, HistoryStatus } from "./history-types";
export const APP_ORIGIN = "learning://app";
export const MAX_PCM_PACKET_BYTES = 16 * 1024;
export const MAX_PCM_QUEUE_BYTES = 1024 * 1024;
export type PcmPacket = { sessionId: number; roundId: number; sequence: number; bytes: ArrayBuffer };
export type ConfigurationError = "encryption_unavailable" | "decryption_failed" | "invalid_configuration" | "invalid_base_url" | "full_endpoint" | "invalid_model" | "key_binding_required" | "unsupported_asr_provider" | "missing_asr_key" | "profile_not_found" | "profile_limit" | "read_failed" | "save_failed";
export type AnalysisProfile = { id: string; baseUrl: string; model: string; mode: AnalysisMode; hasKey: boolean };
export type AsrProfile = { id: string; provider: AsrProviderId; hasKey: boolean };
export type ConfigurationStatus = { ready: boolean; analysisReady: boolean; asrReady: boolean; hasAnalysisKey: boolean; hasAsrKey: boolean; baseUrl: string | null; model: string | null; mode: AnalysisMode | null; asrProvider: AsrProviderId | null; analysisProfiles: AnalysisProfile[]; asrProfiles: AsrProfile[]; selectedAnalysisId: string | null; selectedAsrId: string | null; error: ConfigurationError | null };
export const MAX_CONFIGURATION_PROFILES = 32;
// Every new entry binds its own write-only key. Empty analysis keys mean no auth.
export type AnalysisConfigurationDraft = { apiKey: string; baseUrl: string; model: string; mode: AnalysisMode };
export type AsrConfigurationDraft = { provider: AsrProviderId; apiKey: string };
export type ConfigurationPayload = AnalysisConfigurationDraft | AsrConfigurationDraft | { id: string };
export type ConfigurationMutation = "add-analysis" | "add-asr" | "select-analysis" | "select-asr" | "delete-analysis" | "delete-asr";
export type ConfigurationAction = "status" | "import" | "clear" | ConfigurationMutation;
export type AnalysisTestRequest = { kind: "draft"; draft: AnalysisConfigurationDraft } | { kind: "saved"; id: string };
export type ConnectionTestResult = { reachable: boolean; text: "pending" | "passed" | "failed"; image: "pending" | "passed" | "failed"; imageObservation: "matched" | "unconfirmed" | null; cancelled: boolean; error: string | null };
// contentProtection is configurable for other windows; capsule/menu stay excluded.
export type WindowPreferencesStatus = { contentProtection: boolean; error: "read_failed" | "save_failed" | "apply_failed" | null };
export const MAX_ROUND_MS = 10 * 60 * 1000;
export type Role = "orb" | "menu" | "feedback" | "panel" | "settings" | "picker" | "media" | "history" | "appearance";
export type Phase = "idle" | "selecting" | "ready" | "connecting" | "starting" | "recording" | "stopping" | "transcribing" | "processing" | "feedback" | "error" | "exiting";
export type Source = { id: string; name: string; kind: "window" | "screen"; displayId?: string };
export type SourceChoice = Source & { thumbnail: string; available: boolean; detail: string };
export type Shot = { dataUrl: string; width: number; height: number; capturedAt: number; frameTime: number };
export type PcmStats = {
  sampleRate: number; inputSampleRate: number; samples: number; frames: number;
  maxDeliveryGapMs: number; seconds: { second: number; samples: number; rms: number }[];
};
export type Recording = { bytes: ArrayBuffer; mime: string; durationMs: number; pcm: PcmStats };
export type Artifacts = { start?: Shot; end?: Shot; audio?: Recording };
export type Snapshot = {
  transcript: TranscriptState; transcriptComplete: boolean; analysis: AnalysisResponse | null;
  requestId: number; retryable: boolean; errorStage: "configuration" | "media" | "asr" | "input" | "analysis" | null;
  outputIssue: AnalysisOutputIssue | null; simulated: boolean;
  timings: { connectionMs?: number; mediaStartMs?: number; stopMs?: number; finalTranscriptMs?: number; analysisMs?: number };
  sessionId: number; roundId: number; revision: number; phase: Phase; source: Source | null;
  recording: boolean; startedAt: number | null; elapsedMs: number; busy: boolean;
  feedback: string | null; error: string | null; artifacts: {
    start: Omit<Shot, "dataUrl"> | null; end: Omit<Shot, "dataUrl"> | null;
    audio: { bytes: number; mime: string; durationMs: number; pcm: PcmStats } | null;
  }; hidden: boolean; hiddenIntervals: { start: number; end: number | null }[];
};
export type Action =
  | { type: "select"; sourceId: string }
  | { type: "start" | "check" | "retry" | "cancel" | "end" | "quit"; revision: number };
export type ViewAction = "hover-enter" | "hover-leave" | "toggle-menu" | "toggle-feedback" | "operation-failed" | "move-left" | "move-right" | "move-up" | "move-down" | "collapse" | "feedback" | "feedback-inactive" | "panel" | "settings" | "picker" | "history" | "hide" | "restore" | "close" | "minimize" | "toggle-maximize";
export type Presentation = { menu?: import("./glass/menu-geometry").MenuPlacement; revision: number; menuOpen: boolean; feedbackOpen: boolean; direction: "up" | "down"; configured: boolean; notice: string | null; material?: "acrylic" | "solid"; nativeFrame?: boolean; maximized?: boolean };
export type MediaCommand = { id: number; sessionId: number; roundId: number } & (
  | { type: "select"; source: Source }
  | { type: "start" | "finish" | "cancel" | "dispose" }
);
export type MediaValue = { type: "selected" } | { type: "started"; start: Shot; startedAt: number }
  | { type: "finished"; end: Shot; audio: Recording; lastSequence: number } | { type: "cleared" };
export type MediaReply = { id: number; value?: MediaValue; error?: "denied" | "source" | "audio" | "timeout" | "cancelled" };
export type MediaEvent = { sessionId: number; roundId: number; kind: "source-ended" | "microphone-ended" | "media-error" | "recording-stopped" | "pcm-error" };
export type ActionResult = { ok: boolean; message?: string };
export type Diagnostics = {
  platform: string; osVersion: string; electron: string; chrome: string; packaged: boolean;
  startupMs: number; displays: { width: number; height: number; scaleFactor: number }[];
  windows: { role: Role; bounds: { x: number; y: number; width: number; height: number }; visible: boolean; contentProtected: boolean; backgroundThrottling: boolean }[];
  resources: { processes: number; workingSetMB: number; privateMB: number; cpuPercent: number };
  blockedNetworkRequests: number; adapter: "cloud" | "simulated";
};
export interface DesktopApi {
  surfacePointer(): void;
  menuHeight(height: number): void;
  presentation(): Promise<Presentation>;
  onPresentation(callback: (state: Presentation) => void): () => void;
  historyStatus(): Promise<HistoryStatus>;
  onHistoryChanged(callback: () => void): () => void;
  onPlaybackStop(callback: () => void): () => void;
  historyList(offset: number): Promise<HistoryPage>;
  historyDetail(id: string): Promise<HistoryDetail>;
  historyDelete(id: string): Promise<ActionResult>;
  historyClear(): Promise<ActionResult>;
  state(): Promise<Snapshot>;
  subscribe(callback: (snapshot: Snapshot) => void): () => void;
  act(action: Action): Promise<ActionResult>;
  view(action: ViewAction): Promise<void>;
  sources(kind: "window" | "screen"): Promise<SourceChoice[]>;
  onPickerOpened(callback: () => void): () => void;
  onMenuOpened(callback: () => void): () => void;
  diagnostics(): Promise<Diagnostics>;
  exportEvidence(): Promise<string | null>;
  configuration(action: ConfigurationAction, payload?: ConfigurationPayload): Promise<ConfigurationStatus>;
  testAnalysis(action: "start" | "cancel", request?: AnalysisTestRequest): Promise<ConnectionTestResult | null>;
  windowPreferences(contentProtection?: boolean): Promise<WindowPreferencesStatus>;
  onSettingsVisibility(callback: (visible: boolean) => void): () => void;
}
export interface MediaApi {
  onCommand(callback: (command: MediaCommand) => void): () => void;
  reply(reply: MediaReply): void;
  event(event: MediaEvent): void;
  ready(): void;
  pcm(packet: PcmPacket): Promise<boolean>;
}
declare global { interface Window { desktop: DesktopApi; mediaHost: MediaApi } }
