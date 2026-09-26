import { mkdir, readFile, rename, writeFile, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ACCEPTED_MATERIAL, ACCEPTED_MOTION } from './presets';
import { MATERIAL_CONTROLS, patchMaterial, type MaterialSettings } from './material-settings';
import { MOTION_CONTROLS, patchMotion, type MotionSettings } from './motion';
import type { AppearanceKind, SavedState } from './api';

type MaterialValue = { settings: MaterialSettings; fps: 30 | 60; startupEnabled?: boolean; menuFrost?: boolean };
type MotionValue = { settings: MotionSettings; reduced: boolean };
type Values = { material: MaterialValue; motion: MotionValue };
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export function decodeSettings(kind: AppearanceKind, raw: unknown, imported = false): MaterialValue | MotionValue {
  if (!object(raw) || raw.schema !== 1 || !object(raw.settings) || !Object.keys(raw.settings).length) throw new Error('Unsupported appearance file');
  if (!imported && (raw.kind !== kind || raw.application !== 'LearningWithYou')) throw new Error('Wrong appearance file');
  const controls = kind === 'material' ? MATERIAL_CONTROLS : MOTION_CONTROLS;
  for (const [key, value] of Object.entries(raw.settings)) {
    const range = (controls as Record<string, { min: number; max: number }>)[key];
    if (Object.hasOwn(controls, key) && (typeof value !== 'number' || !Number.isFinite(value) || value < range.min || value > range.max)) throw new Error('Invalid saved range');
  }
  if (kind === 'material') {
    if (raw.fps !== undefined && raw.fps !== 30 && raw.fps !== 60) throw new Error('Invalid capture rate');
    if (raw.startupEnabled !== undefined && typeof raw.startupEnabled !== 'boolean') throw new Error('Invalid startup preference');
    if (raw.menuFrost !== undefined && typeof raw.menuFrost !== 'boolean') throw new Error('Invalid menu frost preference');
    return { settings: { ...patchMaterial(ACCEPTED_MATERIAL, raw.settings), debugView: 'normal' }, fps: raw.fps === 60 ? 60 : 30, startupEnabled: raw.startupEnabled !== false, menuFrost: raw.menuFrost !== false };
  }
  if (raw.reduced !== undefined && typeof raw.reduced !== 'boolean') throw new Error('Invalid reduced motion preference');
  return { settings: patchMotion(ACCEPTED_MOTION, raw.settings), reduced: raw.reduced === true };
}
export class AppearanceStore {
  material: MaterialValue = { settings: { ...ACCEPTED_MATERIAL }, fps: 30, startupEnabled: true, menuFrost: true };
  motion: MotionValue = { settings: { ...ACCEPTED_MOTION }, reduced: false };
  private saved: Values = { material: this.material, motion: this.motion };
  private status: Record<AppearanceKind, Omit<SavedState, 'dirty'>> = {
    material: { source: '候选24验收预设', savedAt: null, warning: null },
    motion: { source: '候选10最终验收预设', savedAt: null, warning: null },
  };
  private saving = new Set<AppearanceKind>();
  constructor(readonly directory: string) {}
  file(kind: AppearanceKind) { return path.join(this.directory, `${kind}-v1.json`); }
  async load() {
    for (const kind of ['material', 'motion'] as const) {
      try {
        const content = await readFile(this.file(kind), 'utf8');
        if (content.length > 32768) throw new Error('File too large');
        const raw = JSON.parse(content), value = decodeSettings(kind, raw);
        if (kind === 'material') this.material = value as MaterialValue; else this.motion = value as MotionValue;
        this.saved[kind] = value as MaterialValue & MotionValue;
        this.status[kind] = { source: '正式保存值', savedAt: typeof raw.savedAt === 'string' ? raw.savedAt : null, warning: null };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.status[kind].warning = '配置无法读取或已损坏：原文件保留，当前使用验收预设。';
      }
    }
  }
  summary(): Record<AppearanceKind, SavedState> {
    return Object.fromEntries((['material', 'motion'] as const).map(kind => [kind, { ...this.status[kind], dirty: JSON.stringify(this[kind]) !== JSON.stringify(this.saved[kind]) }])) as Record<AppearanceKind, SavedState>;
  }
  async importFile(kind: AppearanceKind, source: string) {
    const text = await readFile(source, 'utf8');
    if (text.length > 32768) throw new Error('File too large');
    const value = decodeSettings(kind, JSON.parse(text), true);
    if (kind === 'material') this.material = value as MaterialValue; else this.motion = value as MotionValue;
    // Import is preview only. The experiment file is never written or removed.
    this.status[kind].warning = '已只读导入到当前预览；保存后才写入正式配置。';
  }
  async save(kind: AppearanceKind) {
    if (this.saving.has(kind)) throw new Error('Save in progress');
    this.saving.add(kind);
    const target = this.file(kind), temporary = `${target}.${randomUUID()}.tmp`;
    const savedAt = new Date().toISOString();
    const value = kind === 'material' ? { ...this.material, settings: { ...this.material.settings, debugView: 'normal' as const } } : this.motion;
    try {
      await mkdir(this.directory, { recursive: true });
      const body = JSON.stringify({ application: 'LearningWithYou', schema: 1, kind, savedAt, ...value }, null, 2);
      decodeSettings(kind, JSON.parse(body));
      await writeFile(temporary, body, { flag: 'wx', flush: true });
      // Preserve the original, including malformed files, before an explicit save.
      try {
        await mkdir(path.join(this.directory, 'backups'), { recursive: true });
        await copyFile(target, path.join(this.directory, 'backups', `${kind}-${randomUUID()}.json`));
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      await rename(temporary, target);
      this.saved[kind] = value as MaterialValue & MotionValue;
      this.status[kind] = { source: '正式保存值', savedAt, warning: null };
      return { path: target };
    } catch {
      this.status[kind].warning = '保存失败：旧值保留，当前预览仍有效。请检查用户数据目录后重试。';
      throw new Error(this.status[kind].warning!);
    } finally { this.saving.delete(kind); await unlink(temporary).catch(() => {}); }
  }
}
