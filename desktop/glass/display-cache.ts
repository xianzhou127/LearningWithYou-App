import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { adaptationContract, computeAdaptation, type DisplayAdaptation, type DisplayIdentity } from './display-adaptation';
import { prepareSampling, type SamplingProfiles } from './desktop-layout';

type Entry = { hash: string; input: DisplayIdentity; adaptation: DisplayAdaptation };
type Cache = { application: 'LearningWithYou'; schema: 1; algorithm: string; hash: string; entries: Entry[]; sampling: SamplingProfiles };
export type DisplayCacheStatus = { hash: string; reused: number; computed: number; removed: number; written: boolean; warning: string | null };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const hash = (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex');
const algorithm = hash(adaptationContract);
const finite = (n: unknown, min: number, max: number): n is number => typeof n === 'number' && Number.isFinite(n) && n >= min && n <= max;
const string = (s: unknown): s is string => typeof s === 'string' && s.length < 2048;
function rectangle(v: unknown) {
  if (!object(v) || !finite(v.x, -1e6, 1e6) || !finite(v.y, -1e6, 1e6) || !finite(v.width, 1, 131072) || !finite(v.height, 1, 131072)) throw new Error('Invalid display rectangle');
  return { x: v.x, y: v.y, width: v.width, height: v.height };
}
export function displayIdentity(v: unknown): DisplayIdentity {
  if (!object(v) || !string(v.id) || !v.id || !string(v.device) || !string(v.label) || !string(v.colorSpace) || !finite(v.scale, .25, 8) || ![0, 90, 180, 270].includes(v.rotation as number) || !finite(v.refreshHz, 0, 2000) || !finite(v.colorDepth, 0, 128) || !finite(v.depthPerComponent, 0, 64) || typeof v.internal !== 'boolean') throw new Error('Invalid display identity');
  return { id: v.id, device: v.device, label: v.label, bounds: rectangle(v.bounds), pixels: rectangle(v.pixels), scale: v.scale, rotation: v.rotation as number, refreshHz: v.refreshHz, colorDepth: v.colorDepth, depthPerComponent: v.depthPerComponent, colorSpace: v.colorSpace, internal: v.internal };
}
const entryHash = (input: DisplayIdentity) => hash({ algorithm, input });
function readCache(raw: unknown): Cache {
  if (!object(raw) || raw.application !== 'LearningWithYou' || raw.schema !== 1 || raw.algorithm !== algorithm || !Array.isArray(raw.entries) || raw.entries.length > 32) throw new Error('Invalid display cache version');
  const entries = raw.entries.map(e => {
    if (!object(e)) throw new Error('Invalid cached display');
    const input = displayIdentity(e.input);
    if (e.hash !== entryHash(input) || !object(e.adaptation)) throw new Error('Invalid display hash');
    // Validate finite values and the persisted content digest without rerunning
    // geometry adaptation on a cache hit. Never accept executable paths/grants.
    const a = e.adaptation;
    if (!finite(a.inverseScale, .125, 4) || !object(a.roiPixels) || !object(a.outputPixels) || !object(a.samplePixels)) throw new Error('Invalid cached adaptation');
    const sizes = [a.roiPixels.width, a.roiPixels.height, a.outputPixels.width, a.outputPixels.height, a.samplePixels.width, a.samplePixels.height, a.samplePixels.pad];
    if (!sizes.every(n => finite(n, 1, 8192))) throw new Error('Invalid cached dimensions');
    const adaptation: DisplayAdaptation = { inverseScale: a.inverseScale, display: rectangle(a.display), roiPixels: { width: a.roiPixels.width as number, height: a.roiPixels.height as number }, contentPixels: rectangle(a.contentPixels), outputPixels: { width: a.outputPixels.width as number, height: a.outputPixels.height as number }, samplePixels: { pad: a.samplePixels.pad as number, width: a.samplePixels.width as number, height: a.samplePixels.height as number } };
    return { hash: e.hash as string, input, adaptation };
  }).sort((a, b) => a.input.id.localeCompare(b.input.id));
  if (!object(raw.sampling)) throw new Error('Invalid sampling profiles');
  const sampling: SamplingProfiles = {};
  for (const target of entries) {
    const row = raw.sampling[target.input.id]; if (!object(row)) throw new Error('Missing sampling profile');
    sampling[target.input.id] = Object.fromEntries(entries.map(source => [source.input.id, rectangle(row[source.input.id])]));
  }
  if (new Set(entries.map(e => e.input.id)).size !== entries.length || raw.hash !== hash({ entries, sampling })) throw new Error('Invalid cache content hash');
  return { application: 'LearningWithYou', schema: 1, algorithm, hash: raw.hash as string, entries, sampling };
}
export class DisplayCache {
  constructor(readonly file: string) {}
  // Caller serializes topology refreshes. No reads or writes occur during drag.
  async resolve(inputs: DisplayIdentity[]) {
    const identities = inputs.map(displayIdentity).sort((a, b) => a.id.localeCompare(b.id));
    if (!identities.length || identities.length > 32 || new Set(identities.map(i => i.id)).size !== identities.length) throw new Error('Invalid display inventory');
    let previous: Cache | undefined, invalid = false, warning: string | null = null;
    try { const text = await readFile(this.file, 'utf8'); if (text.length > 262144) throw new Error('Oversize cache'); previous = readCache(JSON.parse(text)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { invalid = true; warning = '屏幕缓存无效，已重新计算；原文件将保留备份。'; } }
    let reused = 0;
    const entries = identities.map(input => {
      const signature = entryHash(input), cached = previous?.entries.find(e => e.hash === signature);
      if (cached) { reused++; return cached; }
      return { hash: signature, input, adaptation: computeAdaptation(input) };
    });
    const sampling = previous && reused === entries.length && previous.entries.length === entries.length ? previous.sampling : prepareSampling(identities.map(i => ({ ...i, name: i.label, physical: { width: i.pixels.width, height: i.pixels.height } })));
    const next: Cache = { application: 'LearningWithYou', schema: 1, algorithm, hash: hash({ entries, sampling }), entries, sampling };
    const status: DisplayCacheStatus = { hash: next.hash, reused, computed: entries.length - reused, removed: previous?.entries.filter(e => !identities.some(i => i.id === e.input.id)).length ?? 0, written: false, warning };
    if (previous?.hash !== next.hash) {
      const temporary = `${this.file}.${randomUUID()}.tmp`;
      try {
        await mkdir(path.dirname(this.file), { recursive: true });
        await writeFile(temporary, JSON.stringify(next, null, 2), { flag: 'wx', flush: true });
        if (invalid) { const backup = path.join(path.dirname(this.file), 'backups'); await mkdir(backup, { recursive: true }); await copyFile(this.file, path.join(backup, `display-cache-${randomUUID()}.json`)); }
        await rename(temporary, this.file); status.written = true;
      } catch { status.warning = '屏幕适配缓存保存失败，旧文件保留；本次使用内存配置，下次启动重新检查。'; }
      finally { await unlink(temporary).catch(() => {}); }
    }
    return { entries, sampling, status };
  }
}
