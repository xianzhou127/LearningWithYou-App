import "../trusted/node-only";
import { open, mkdir, rename, unlink, copyFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord } from "../shared/analysis-contract";
import { isAnalysisModel } from "../shared/analysis-models";
import { parseBaseUrl, readConfiguration, validKey } from "../trusted/analysis/configuration";
import { readAsrConfiguration } from "../trusted/asr-configuration";
import { DEFAULT_ASR_PROVIDER, getAsrPreset } from "../shared/asr-providers";
import { MAX_CONFIGURATION_PROFILES, type AnalysisConfigurationDraft, type ConfigurationError, type ConfigurationStatus, type ConfigurationMutation } from "./shared";

export type Configuration = Record<string, string | undefined>;
const fields = ["DASHSCOPE_API_KEY", "QWEN_BASE_URL", "QWEN_MODEL", "ANALYSIS_OUTPUT_MODE", "ANALYSIS_API_KEY", "ANALYSIS_BASE_URL", "ANALYSIS_MODEL", "ASR_API_KEY", "ASR_PROVIDER"] as const;
const MAX_CONFIG_BYTES = 64 * 1024;

function normalize(env: Configuration): Configuration | null {
  const analysis = readConfiguration(env);
  const asr = readAsrConfiguration(env);
  if (!analysis || !asr) return null;
  return { ANALYSIS_BASE_URL: analysis.baseUrl, ANALYSIS_MODEL: analysis.model, ANALYSIS_API_KEY: analysis.apiKey,
    ANALYSIS_OUTPUT_MODE: analysis.mode, ASR_PROVIDER: asr.preset.id, ASR_API_KEY: asr.apiKey };
}
export function parseConfiguration(text: string): Configuration | null {
  if (Buffer.byteLength(text) > MAX_CONFIG_BYTES) return null;
  const result: Configuration = {};
  for (const line of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || !fields.includes(match[1] as typeof fields[number])) continue;
    if (Object.hasOwn(result, match[1])) return null;
    let value = match[2];
    if (value.startsWith('"') || value.startsWith("'")) {
      const quoted = /^(["'])(.*?)\1\s*(?:#.*)?$/.exec(value);
      if (!quoted) return null;
      value = quoted[2];
    } else value = value.replace(/\s+#.*$/, "").trim();
    result[match[1]] = value;
  }
  return normalize(result);
}
export interface Encryption {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
const MAX_STORE_BYTES = 512 * 1024;
type AnalysisEntry = AnalysisConfigurationDraft & { id: string; protocol: "openai-chat-completions" };
type AsrEntry = { id: string; provider: import("../shared/asr-providers").AsrProviderId; protocol: string; apiKey: string };
type ProfileData = { schema: 3; analysis: AnalysisEntry[]; asr: AsrEntry[]; selectedAnalysisId: string | null; selectedAsrId: string | null };
const emptyData = (): ProfileData => ({ schema: 3, analysis: [], asr: [], selectedAnalysisId: null, selectedAsrId: null });
const validId = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/.test(value);
function exactFields(value: unknown, limits: Record<string, number>): value is Record<string, string> {
  return isRecord(value) && Object.keys(value).length === Object.keys(limits).length && Object.entries(limits).every(([key, limit]) =>
    Object.hasOwn(value, key) && typeof value[key] === "string" && value[key].length <= limit && !/[\u0000-\u001f\u007f-\u009f]/u.test(value[key]));
}
function analysisDraft(value: unknown): { draft: AnalysisConfigurationDraft } | { error: ConfigurationError } {
  if (!exactFields(value, { apiKey: 4096, baseUrl: 2048, model: 256, mode: 8 }) || !validKey(value.apiKey.trim()) || !["text", "json"].includes(value.mode)) return { error: "invalid_configuration" };
  const url = parseBaseUrl(value.baseUrl);
  if ("error" in url) return url;
  if (!isAnalysisModel(value.model.trim())) return { error: "invalid_model" };
  return { draft: { apiKey: value.apiKey.trim(), baseUrl: url.baseUrl, model: value.model.trim(), mode: value.mode as AnalysisConfigurationDraft["mode"] } };
}
function analysisEnvironment(entry: AnalysisEntry): Configuration {
  return { ANALYSIS_API_KEY: entry.apiKey, ANALYSIS_BASE_URL: entry.baseUrl, ANALYSIS_MODEL: entry.model, ANALYSIS_OUTPUT_MODE: entry.mode };
}
function fromEnvironment(env: Configuration | null): ProfileData {
  const data = emptyData();
  if (!env) return data;
  const analysis = readConfiguration(env), asr = readAsrConfiguration(env);
  if (!analysis || !asr) throw new Error("config");
  const entry: AnalysisEntry = { id: randomUUID(), protocol: "openai-chat-completions", apiKey: analysis.apiKey, baseUrl: analysis.baseUrl, model: analysis.model, mode: analysis.mode };
  data.analysis.push(entry); data.selectedAnalysisId = entry.id;
  if (asr.apiKey) {
    const id = randomUUID(); data.asr.push({ id, provider: asr.preset.id, protocol: asr.preset.protocol, apiKey: asr.apiKey }); data.selectedAsrId = id;
  }
  return data;
}
async function boundedFile(file: string, limit = MAX_CONFIG_BYTES) {
  const handle = await open(file, "r");
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > limit) throw new Error("size");
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > limit) throw new Error("size");
    return buffer.subarray(0, bytesRead);
  } finally { await handle.close(); }
}
function decodeV2(value: unknown): Configuration | null {
  if (!isRecord(value) || value.schema !== 2 || !isRecord(value.asr) || !validKey(value.asr.apiKey)) throw new Error("config");
  const preset = getAsrPreset(Object.hasOwn(value.asr, "provider") ? value.asr.provider : DEFAULT_ASR_PROVIDER);
  if (!preset || value.asr.protocol !== preset.protocol) throw new Error("config");
  if (value.analysis === null && value.asr.apiKey === "") return null;
  const a = value.analysis;
  if (!isRecord(a) || a.protocol !== "openai-chat-completions" || [a.baseUrl, a.model, a.apiKey, a.mode].some(v => typeof v !== "string")) throw new Error("config");
  const env = normalize({ ANALYSIS_BASE_URL: a.baseUrl as string, ANALYSIS_MODEL: a.model as string, ANALYSIS_API_KEY: a.apiKey as string,
    ANALYSIS_OUTPUT_MODE: a.mode as string, ASR_PROVIDER: preset.id, ASR_API_KEY: value.asr.apiKey });
  if (!env) throw new Error("config");
  return env;
}
function decodeV3(value: unknown): ProfileData {
  if (!isRecord(value) || value.schema !== 3 || !Array.isArray(value.analysis) || !Array.isArray(value.asr) ||
      value.analysis.length > MAX_CONFIGURATION_PROFILES || value.asr.length > MAX_CONFIGURATION_PROFILES) throw new Error("config");
  const data = emptyData();
  const ids = new Set<string>();
  for (const item of value.analysis) {
    if (!isRecord(item) || !validId(item.id) || ids.has(item.id) || item.protocol !== "openai-chat-completions") throw new Error("config");
    const parsed = analysisDraft({ apiKey: item.apiKey, baseUrl: item.baseUrl, model: item.model, mode: item.mode });
    if ("error" in parsed) throw new Error("config");
    ids.add(item.id); data.analysis.push({ ...parsed.draft, id: item.id, protocol: "openai-chat-completions" });
  }
  for (const item of value.asr) {
    if (!isRecord(item) || !validId(item.id) || ids.has(item.id) || !validKey(item.apiKey) || !item.apiKey) throw new Error("config");
    const preset = getAsrPreset(item.provider);
    if (!preset || preset.protocol !== item.protocol) throw new Error("config");
    ids.add(item.id); data.asr.push({ id: item.id, provider: preset.id, protocol: preset.protocol, apiKey: item.apiKey });
  }
  if (value.selectedAnalysisId !== null && (!validId(value.selectedAnalysisId) || !data.analysis.some(p => p.id === value.selectedAnalysisId))) throw new Error("config");
  if (value.selectedAsrId !== null && (!validId(value.selectedAsrId) || !data.asr.some(p => p.id === value.selectedAsrId))) throw new Error("config");
  data.selectedAnalysisId = value.selectedAnalysisId as string | null; data.selectedAsrId = value.selectedAsrId as string | null;
  return data;
}
export class ConfigurationStore {
  private data = emptyData();
  private error: ConfigurationError | null = null;
  constructor(private directory: string, private encryption: Encryption) {}
  private file(version = 3) { return path.join(this.directory, `configuration.v${version}.encrypted`); }
  status(): ConfigurationStatus {
    const analysis = this.data.analysis.find(p => p.id === this.data.selectedAnalysisId);
    const asr = this.data.asr.find(p => p.id === this.data.selectedAsrId);
    return { ready: !!analysis && !!asr, analysisReady: !!analysis, asrReady: !!asr, hasAnalysisKey: !!analysis?.apiKey, hasAsrKey: !!asr?.apiKey,
      baseUrl: analysis?.baseUrl ?? null, model: analysis?.model ?? null, mode: analysis?.mode ?? null, asrProvider: asr?.provider ?? null,
      analysisProfiles: this.data.analysis.map(p => ({ id: p.id, baseUrl: p.baseUrl, model: p.model, mode: p.mode, hasKey: !!p.apiKey })),
      asrProfiles: this.data.asr.map(p => ({ id: p.id, provider: p.provider, hasKey: !!p.apiKey })),
      selectedAnalysisId: this.data.selectedAnalysisId, selectedAsrId: this.data.selectedAsrId, error: this.error };
  }
  snapshot(): Configuration {
    const analysis = this.data.analysis.find(p => p.id === this.data.selectedAnalysisId);
    const asr = this.data.asr.find(p => p.id === this.data.selectedAsrId);
    return { ...(analysis ? analysisEnvironment(analysis) : {}), ...(asr ? { ASR_PROVIDER: asr.provider, ASR_API_KEY: asr.apiKey } : {}) };
  }
  async load() {
    this.data = emptyData(); this.error = null;
    if (!this.encryption.isEncryptionAvailable()) { this.error = "encryption_unavailable"; return; }
    for (const version of [3, 2, 1]) {
      let bytes: Buffer;
      try { bytes = await boundedFile(this.file(version), version === 3 ? MAX_STORE_BYTES : MAX_CONFIG_BYTES); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        this.error = "decryption_failed"; return;
      }
      try {
        const value: unknown = JSON.parse(this.encryption.decryptString(bytes));
        if (version === 3) { this.data = decodeV3(value); return; }
        let env: Configuration | null;
        if (version === 2) env = decodeV2(value);
        else {
          if (!isRecord(value) || Object.hasOwn(value, "schema")) throw new Error("config");
          const legacy: Configuration = {};
          for (const key of fields.slice(0, 4)) {
            if (value[key] !== undefined && typeof value[key] !== "string") throw new Error("config");
            legacy[key] = value[key] as string | undefined;
          }
          env = normalize(legacy); if (!env) throw new Error("config");
        }
        await this.persist(fromEnvironment(env)); // Source v1/v2 bytes never change.
      } catch { this.error = "decryption_failed"; }
      return; // Corrupt/empty higher versions never resurrect older credentials.
    }
  }
  private reject(error: ConfigurationError) { this.error = error; return this.status(); }
  async mutate(action: ConfigurationMutation, value: unknown) {
    const candidate = structuredClone(this.data);
    if (action === "add-analysis") {
      const parsed = analysisDraft(value); if ("error" in parsed) return this.reject(parsed.error);
      if (candidate.analysis.length >= MAX_CONFIGURATION_PROFILES) return this.reject("profile_limit");
      const id = randomUUID(); candidate.analysis.push({ ...parsed.draft, id, protocol: "openai-chat-completions" }); candidate.selectedAnalysisId = id;
    } else if (action === "add-asr") {
      if (!exactFields(value, { provider: 64, apiKey: 4096 })) return this.reject("invalid_configuration");
      const preset = getAsrPreset(value.provider); if (!preset) return this.reject("unsupported_asr_provider");
      if (!value.apiKey.trim()) return this.reject("missing_asr_key");
      if (!validKey(value.apiKey.trim())) return this.reject("invalid_configuration");
      if (candidate.asr.length >= MAX_CONFIGURATION_PROFILES) return this.reject("profile_limit");
      const id = randomUUID(); candidate.asr.push({ id, provider: preset.id, protocol: preset.protocol, apiKey: value.apiKey.trim() }); candidate.selectedAsrId = id;
    } else {
      if (!exactFields(value, { id: 36 }) || !validId(value.id)) return this.reject("invalid_configuration");
      const analysis = action === "select-analysis" || action === "delete-analysis";
      const profiles = analysis ? candidate.analysis : candidate.asr;
      if (!profiles.some(p => p.id === value.id)) return this.reject("profile_not_found");
      if (action === "select-analysis") candidate.selectedAnalysisId = value.id;
      else if (action === "select-asr") candidate.selectedAsrId = value.id;
      else if (action === "delete-analysis") {
        candidate.analysis = candidate.analysis.filter(p => p.id !== value.id);
        if (candidate.selectedAnalysisId === value.id) candidate.selectedAnalysisId = null;
      } else if (action === "delete-asr") {
        candidate.asr = candidate.asr.filter(p => p.id !== value.id);
        if (candidate.selectedAsrId === value.id) candidate.selectedAsrId = null;
      } else return this.reject("invalid_configuration");
    }
    return this.persist(candidate);
  }
  // Saved tests resolve the key in the main process. Draft tests bind only the
  // newly typed key, including empty = no authentication; never reuse a profile.
  resolveAnalysisTest(value: unknown): { config: Configuration } | { error: ConfigurationError } {
    if (!isRecord(value) || Object.keys(value).length !== 2) return { error: "invalid_configuration" };
    if (value.kind === "saved" && validId(value.id)) {
      const entry = this.data.analysis.find(p => p.id === value.id);
      return entry ? { config: analysisEnvironment(entry) } : { error: "profile_not_found" };
    }
    if (value.kind === "draft") {
      const parsed = analysisDraft(value.draft); if ("error" in parsed) return parsed;
      return { config: analysisEnvironment({ ...parsed.draft, id: "", protocol: "openai-chat-completions" }) };
    }
    return { error: "invalid_configuration" };
  }
  async importFile(file: string) {
    if (!this.encryption.isEncryptionAvailable()) return this.reject("encryption_unavailable");
    let env: Configuration | null;
    try { env = parseConfiguration((await boundedFile(file)).toString("utf8")); }
    catch { return this.reject("read_failed"); }
    if (!env) return this.reject("invalid_configuration");
    const imported = fromEnvironment(env), candidate = structuredClone(this.data);
    const analysis = imported.analysis[0];
    const existing = candidate.analysis.find(p => p.baseUrl === analysis.baseUrl && p.model === analysis.model && p.mode === analysis.mode && p.apiKey === analysis.apiKey);
    if (!existing) candidate.analysis.push(analysis);
    candidate.selectedAnalysisId = existing?.id ?? analysis.id;
    const asr = imported.asr[0];
    if (asr) {
      const existingAsr = candidate.asr.find(p => p.provider === asr.provider && p.apiKey === asr.apiKey);
      if (!existingAsr) candidate.asr.push(asr);
      candidate.selectedAsrId = existingAsr?.id ?? asr.id;
    }
    if (candidate.analysis.length > MAX_CONFIGURATION_PROFILES || candidate.asr.length > MAX_CONFIGURATION_PROFILES) return this.reject("profile_limit");
    return this.persist(candidate);
  }
  private async persist(candidate: ProfileData) {
    if (!this.encryption.isEncryptionAvailable()) return this.reject("encryption_unavailable");
    const temporary = path.join(this.directory, `configuration-${randomUUID()}.tmp`);
    try {
      const encrypted = this.encryption.encryptString(JSON.stringify(candidate));
      if (encrypted.length > MAX_STORE_BYTES) throw new Error("size");
      await mkdir(this.directory, { recursive: true });
      const handle = await open(temporary, "wx");
      try { await handle.writeFile(encrypted); await handle.sync(); } finally { await handle.close(); }
      try {
        await mkdir(path.join(this.directory, "backups"), { recursive: true });
        await copyFile(this.file(), path.join(this.directory, "backups", `configuration.v3-${randomUUID()}.encrypted`));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      await rename(temporary, this.file()); this.data = candidate; this.error = null;
    } catch { this.error = "save_failed"; }
    finally { await unlink(temporary).catch(() => undefined); }
    return this.status();
  }
  async clear() { return this.persist(emptyData()); }
}
