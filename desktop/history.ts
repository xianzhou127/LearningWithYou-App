import "../trusted/node-only";
import { lstat, mkdir, open, readdir, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isRecord, isVerdict } from "../shared/analysis-contract";
import type { Artifacts } from "./shared";
import type { Attachment, HistoryDetail, HistoryPage, HistoryRecord, HistorySummary } from "./history-types";

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const files: Record<Attachment, string> = { start: "start.jpg", end: "end.jpg", audio: "recording.webm" };
const keys: Attachment[] = ["start", "end", "audio"];
const MAX_META = 2 * 1024 * 1024;
const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
export function validHistoryId(id: unknown): id is string { return typeof id === "string" && idPattern.test(id); }

// Strictly project business fields on both write and read. Never persist runtime/config/diagnostics.
function recordValue(v: unknown, id: string): HistoryRecord {
  if (!isRecord(v) || v.version !== 1 || v.id !== id || !finite(v.createdAt) || !finite(v.updatedAt)
    || typeof v.sourceName !== "string" || (v.durationMs !== null && !finite(v.durationMs))
    || !["recording", "transcribing", "analyzing", "complete", "failed", "interrupted"].includes(String(v.stage))
    || (v.reason !== null && typeof v.reason !== "string") || typeof v.simulated !== "boolean"
    || (v.transcript !== null && typeof v.transcript !== "string") || !isRecord(v.attachments)) throw new Error("记录损坏或格式版本不受支持。");
  const attachments = {} as HistoryRecord["attachments"];
  for (const key of keys) {
    const a = v.attachments[key];
    if (a !== null && (!isRecord(a) || !Number.isSafeInteger(a.bytes) || Number(a.bytes) <= 0 || Number(a.bytes) > 32 * 1024 * 1024)) throw new Error("附件元信息损坏。");
    attachments[key] = a === null ? null : { bytes: Number(a.bytes) };
  }
  let feedback: HistoryRecord["feedback"] = null;
  if (v.feedback !== null) {
    const f = v.feedback;
    if (!isRecord(f) || typeof f.message !== "string" || !["text", "json"].includes(String(f.mode))) throw new Error("反馈元信息损坏。");
    if (f.mode === "json") {
      const x = f.fields;
      if (!isRecord(x) || (x.topic !== null && typeof x.topic !== "string") || (x.understanding !== null && typeof x.understanding !== "string") || !isVerdict(x.verdict) || typeof x.evidence !== "string") throw new Error("反馈字段损坏。");
      feedback = { mode: "json", message: f.message, fields: { topic: x.topic, understanding: x.understanding, verdict: x.verdict, evidence: x.evidence } };
    } else feedback = { mode: "text", message: f.message };
  }
  if (v.stage === "complete" && (!feedback || v.transcript === null)) throw new Error("记录状态与内容不一致。");
  return { version: 1, id, createdAt: v.createdAt, updatedAt: v.updatedAt, sourceName: v.sourceName, durationMs: v.durationMs,
    stage: v.stage as HistoryRecord["stage"], reason: v.reason, simulated: v.simulated, attachments, transcript: v.transcript, feedback };
}

export class HistoryStore {
  readonly directory: string;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, number>();
  private active = new Set<string>();
  private reserved = new Set<string>();
  private failed = new Map<string, { record: HistoryRecord; artifacts: Artifacts }>();
  private listeners = new Set<() => void>();
  revision = 0;
  clearing = false;
  constructor(private userData: string) { this.directory = path.resolve(userData, "history-v1"); }
  subscribe(listener: () => void) { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
  private changed() { this.revision++; this.listeners.forEach(f => f()); }
  get saving() { return [...this.pending.values()].reduce((n, v) => n + v, 0); }
  get error() { return this.failed.size ? `${this.failed.size} 轮历史保存失败，当前已取得的内容仍在内存中。请检查磁盘空间或权限；下次更新及正常退出会重试保存。` : null; }
  get hasActive() { return this.active.size > 0; }
  locked(id: string) { return this.active.has(id) || this.pending.has(id) || this.failed.has(id); }
  private queue<T>(work: () => Promise<T>): Promise<T> {
    const task = this.tail.then(work); this.tail = task.catch(() => undefined); return task;
  }
  private async root() {
    await mkdir(this.directory, { recursive: true });
    const info = await lstat(this.directory);
    const parent = await realpath(this.userData);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(this.directory)).toLowerCase() !== path.join(parent, "history-v1").toLowerCase()) throw new Error("历史目录路径不安全或不可用。");
  }
  private async folder(id: string, deleted = false) {
    if (!validHistoryId(id)) throw new Error("记录 ID 无效。");
    await this.root();
    const target = path.join(this.directory, `${deleted ? ".deleted-" : ""}${id}`);
    const info = await lstat(target);
    if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(target)).toLowerCase() !== path.join(await realpath(this.directory), path.basename(target)).toLowerCase()) throw new Error("记录目录不安全。");
    return target;
  }
  private async atomic(file: string, bytes: Uint8Array | string) {
    const tmp = `${file}.${randomUUID()}.tmp`;
    try {
      const handle = await open(tmp, "wx");
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      for (let attempt = 0; ; attempt++) {
        try { await rename(tmp, file); break; }
        catch (e) {
          // Windows may briefly hold a destination open (e.g. scanner/indexer). Never unlink the last valid metadata.
          if (attempt >= 4 || !["EPERM", "EACCES", "EBUSY"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
          await new Promise(resolve => setTimeout(resolve, 25 * 2 ** attempt));
        }
      }
    } finally { await unlink(tmp).catch(() => undefined); }
  }
  begin(sourceName: string, createdAt: number, simulated: boolean) {
    if (this.clearing) throw new Error("正在清除历史，请稍后开始。");
    const id = randomUUID(); this.reserved.add(id); this.active.add(id); this.changed();
    return new HistoryRound(this, { version: 1, id, createdAt, updatedAt: createdAt, sourceName, durationMs: null, stage: "recording", reason: null, simulated,
      attachments: { start: null, end: null, audio: null }, transcript: null, feedback: null });
  }
  activate(id: string) { if (!this.reserved.has(id) || this.clearing) return false; this.active.add(id); this.changed(); return true; }
  release(id: string) { this.active.delete(id); this.changed(); }
  save(record: HistoryRecord, artifacts: Artifacts) {
    const id = record.id;
    if (!this.reserved.has(id) || this.clearing) return; // Deleted IDs are never recreated, including by late callbacks.
    const value = recordValue(record, id), data = { ...artifacts };
    this.pending.set(id, (this.pending.get(id) ?? 0) + 1); this.changed();
    void this.queue(async () => {
      try {
        await this.root();
        await mkdir(path.join(this.directory, id), { recursive: true });
        const dir = await this.folder(id);
        for (const key of keys) {
          const item = data[key]; if (!item) continue;
          const bytes = key === "audio" ? Buffer.from(data.audio!.bytes) : Buffer.from(data[key as "start" | "end"]!.dataUrl.split(",")[1], "base64");
          const target = path.join(dir, files[key]);
          let exists = false;
          try { const stat = await lstat(target); exists = stat.isFile() && !stat.isSymbolicLink() && stat.size === bytes.length; } catch (e) { if (!missing(e)) throw e; }
          if (!exists) await this.atomic(target, bytes);
        }
        const json = JSON.stringify(value);
        if (Buffer.byteLength(json) > MAX_META) throw new Error("metadata size");
        await this.atomic(path.join(dir, "record.json"), json);
        this.failed.delete(id);
      } catch { this.failed.set(id, { record: value, artifacts: data }); }
      finally { const n = this.pending.get(id)! - 1; if (n) this.pending.set(id, n); else this.pending.delete(id); this.changed(); }
    });
  }
  async flush() {
    await this.tail;
    for (const value of this.failed.values()) this.save(value.record, value.artifacts);
    await this.tail; return this.failed.size === 0;
  }
  private async read(id: string): Promise<HistoryRecord> {
    const file = path.join(await this.folder(id), "record.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_META) throw new Error("记录文件不可读。");
    const handle = await open(file, "r");
    try {
      const bytes = Buffer.alloc(MAX_META + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > MAX_META) throw new Error("记录过大。");
      return recordValue(JSON.parse(bytes.subarray(0, bytesRead).toString("utf8")), id);
    } finally { await handle.close(); }
  }
  private async names() {
    await this.root();
    return (await readdir(this.directory)).filter(n => idPattern.test(n) || (n.startsWith(".deleted-") && validHistoryId(n.slice(9))));
  }
  detail(id: string): Promise<HistoryDetail> { return this.queue(() => this.detailNow(id)); }
  private async detailNow(id: string): Promise<HistoryDetail> {
    if (!validHistoryId(id)) throw new Error("记录 ID 无效。");
    const summary: HistorySummary = { id, createdAt: 0, sourceName: "无法读取的记录", durationMs: null, stage: "interrupted", simulated: false, corrupt: false, deleting: false, locked: this.locked(id), issue: null };
    const available = { start: false, end: false, audio: false }, issues: string[] = [];
    let record: HistoryRecord | null = null;
    try {
      try { await this.folder(id, true); summary.deleting = true; throw new Error("删除未完成，请再次删除以清理剩余附件。"); }
      catch (e) { if (!missing(e)) throw e; }
      record = await this.read(id);
      const stage = !this.active.has(id) && ["recording", "transcribing", "analyzing"].includes(record.stage) ? "interrupted" : record.stage;
      Object.assign(summary, { createdAt: record.createdAt, sourceName: record.sourceName, durationMs: record.durationMs, stage, simulated: record.simulated });
      record = { ...record, stage };
      for (const key of keys) {
        if (!record.attachments[key]) continue;
        try { const stat = await lstat(path.join(await this.folder(id), files[key])); available[key] = stat.isFile() && !stat.isSymbolicLink() && stat.size === record.attachments[key]!.bytes; } catch { /* Isolate a missing attachment. */ }
        if (!available[key]) issues.push(`${key === "start" ? "开始截图" : key === "end" ? "结束截图" : "录音"}附件缺失或损坏。`);
      }
      summary.issue = issues.length ? "附件缺失或损坏" : null;
    } catch {
      summary.corrupt = true;
      summary.issue = summary.deleting ? "删除未完成，请重试删除。" : "记录损坏或不可读，其他记录仍可查看。";
      issues.push(summary.issue);
      try { summary.createdAt = (await lstat(path.join(this.directory, summary.deleting ? `.deleted-${id}` : id))).birthtimeMs; } catch { /* Gone. */ }
    }
    return { summary, record, available, issues };
  }
  list(offset = 0): Promise<HistoryPage> { return this.queue(() => this.listNow(offset)); }
  private async listNow(offset: number): Promise<HistoryPage> {
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("分页无效。");
    // Metadata only; never load image/audio bytes to build a list.
    const items: HistorySummary[] = [];
    for (const name of await this.names()) items.push((await this.detailNow(name.replace(/^\.deleted-/, ""))).summary);
    items.sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return { items: items.slice(offset, offset + 30), total: items.length, nextOffset: offset + 30 < items.length ? offset + 30 : null };
  }
  media(id: string, kind: Attachment, range: string | null): Promise<Response> { return this.queue(() => this.mediaNow(id, kind, range)); }
  private async mediaNow(id: string, kind: Attachment, range: string | null): Promise<Response> {
    if (!keys.includes(kind)) return new Response(null, { status: 404 });
    const detail = await this.detailNow(id);
    if (!detail.available[kind]) return new Response(null, { status: 404 });
    const handle = await open(path.join(await this.folder(id), files[kind]), "r");
    try {
      const size = (await handle.stat()).size;
      const match = range?.match(/^bytes=(\d+)-(\d*)$/);
      if (range && !match) return new Response(null, { status: 416 });
      const start = match ? Number(match[1]) : 0, end = match?.[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size) return new Response(null, { status: 416 });
      const bytes = Buffer.alloc(end - start + 1); const { bytesRead } = await handle.read(bytes, 0, bytes.length, start);
      if (bytesRead !== bytes.length) return new Response(null, { status: 404 });
      return new Response(bytes, { status: match ? 206 : 200, headers: { "Content-Type": kind === "audio" ? "audio/webm" : "image/jpeg", "Accept-Ranges": "bytes", "Content-Length": String(bytes.length), "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", ...(match ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}) } });
    } finally { await handle.close(); }
  }
  private async removeNow(id: string) {
    // A durable renamed tombstone prevents resurrection after partial deletion or restart.
    let dir: string;
    try { dir = await this.folder(id, true); }
    catch (e) { if (!missing(e)) throw e; const original = await this.folder(id); dir = path.join(this.directory, `.deleted-${id}`); await rename(original, dir); }
    this.reserved.delete(id);
    const checked = await this.folder(id, true);
    if (checked !== dir || path.dirname(checked) !== this.directory) throw new Error("删除路径不安全。");
    // rm removes symlinks themselves and does not traverse their targets. The root was verified above.
    await rm(checked, { recursive: true });
  }
  delete(id: string) {
    if (!validHistoryId(id) || this.clearing || this.locked(id)) return Promise.reject(new Error("记录正在写入或等待结果，暂不可删除。"));
    this.reserved.delete(id);
    this.pending.set(id, 1); this.changed();
    return this.queue(async () => { try { await this.removeNow(id); } finally { this.pending.delete(id); this.changed(); } });
  }
  async clear(confirm: (count: number) => Promise<boolean>, blocked: () => boolean) {
    if (this.clearing || this.saving || this.hasActive || this.failed.size || blocked()) throw new Error("录音、转写、分析或保存期间不能全部清除。");
    this.clearing = true; this.changed(); // Acquire before dialog: new starts and writes are rejected.
    try {
      return await this.queue(async () => {
        const names = await this.names();
        if (!names.length || !await confirm(names.length)) return false;
        for (const name of names) await this.removeNow(name.replace(/^\.deleted-/, ""));
        return true;
      });
    } finally { this.clearing = false; this.changed(); }
  }
}

export class HistoryRound {
  private artifacts: Artifacts = {};
  private closed = false;
  constructor(private store: HistoryStore, readonly record: HistoryRecord) {}
  update(patch: Partial<Pick<HistoryRecord, "stage" | "reason" | "durationMs" | "transcript" | "feedback">>, artifacts: Artifacts = {}) {
    if (this.closed) return;
    Object.assign(this.record, patch, { updatedAt: Date.now() }); Object.assign(this.artifacts, artifacts);
    for (const key of keys) {
      const item = this.artifacts[key];
      if (item) this.record.attachments[key] = { bytes: key === "audio" ? this.artifacts.audio!.bytes.byteLength : Buffer.byteLength(this.artifacts[key as "start" | "end"]!.dataUrl.split(",")[1], "base64") };
    }
    this.store.save(this.record, this.artifacts);
  }
  retry() { return !this.closed && this.store.activate(this.record.id); }
  settle() { this.store.release(this.record.id); }
  close() {
    if (this.closed) return;
    if (["recording", "transcribing", "analyzing"].includes(this.record.stage)) this.update({ stage: "interrupted", reason: "本轮中断，仅保留已可靠取得的材料；未完成的录音无法恢复。" });
    this.closed = true; this.settle();
  }
}
