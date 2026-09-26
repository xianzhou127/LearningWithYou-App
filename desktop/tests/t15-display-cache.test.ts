import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, stat, readdir, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DisplayCache } from '../glass/display-cache';
import { computeAdaptation, type DisplayIdentity } from '../glass/display-adaptation';
import { desktopGeometry, displayInGeometry, union } from '../glass/desktop-layout';
const monitor = (id: string, scale = 1): DisplayIdentity => ({ id, device: `display-${id}`, label: id, bounds: { x: id === 'a' ? -1920 : 0, y: 0, width: 1920, height: 1080 }, pixels: { x: id === 'a' ? -1920 : 0, y: 0, width: 1920, height: 1080 }, scale, rotation: 0, refreshHz: 60, colorSpace: 'sRGB', colorDepth: 24, depthPerComponent: 8, internal: false });
async function fixture(t: test.TestContext) { const dir = await mkdtemp(path.join(os.tmpdir(), 't15-screen-cache-')); t.after(() => rm(dir, { recursive: true, force: true })); return { dir, file: path.join(dir, 'display-adaptation-v1.json') }; }
test('startup prepares every display; identical/reordered inventories reuse bytes without rewriting', async t => {
  const { file } = await fixture(t), cache = new DisplayCache(file), screens = [monitor('a'), monitor('b', 1.4)];
  const first = await cache.resolve(screens); assert.equal(first.status.computed, 2); assert.equal(first.status.written, true);
  const bytes = await readFile(file, 'utf8'), time = (await stat(file)).mtimeMs;
  const hit = await cache.resolve([...screens].reverse());
  assert.deepEqual(hit.status, { ...first.status, computed: 0, reused: 2, written: false });
  assert.equal(await readFile(file, 'utf8'), bytes); assert.equal((await stat(file)).mtimeMs, time);
  const monitors = hit.entries.map(e => ({ ...e.input, name: e.input.label, physical: e.input.pixels, adaptation: e.adaptation }));
  const layout = { host: union(monitors.map(m => m.pixels)), position: { x: -400, y: 100 }, monitors, sampling: hit.sampling };
  for (const x of [-600, -200, 0, 600]) { const g = desktopGeometry(layout, { x, y: 100 }); for (const m of monitors) assert.equal(displayInGeometry(m, g), hit.sampling[g.activeMonitor!][m.id]); }
  assert.equal((await stat(file)).mtimeMs, time);
});
test('only changed display recalculates; metadata, scale and topology invalidate separately', async t => {
  const { file } = await fixture(t), cache = new DisplayCache(file), a = monitor('a'), b = monitor('b', 1.5);
  await cache.resolve([a, b]);
  for (const change of [{ scale: 2 }, { rotation: 90 }, { refreshHz: 144 }, { colorSpace: 'HDR-test' }, { pixels: { ...b.pixels, width: 2560 } }]) {
    Object.assign(b, change); const next = await cache.resolve([a, b]);
    assert.equal(next.status.computed, 1); assert.equal(next.status.reused, 1); assert.equal(next.status.written, true);
    assert.deepEqual(next.entries.find(e => e.input.id === 'b')!.adaptation, computeAdaptation(b));
  }
  const removed = await cache.resolve([b]); assert.equal(removed.status.removed, 1); assert.equal(removed.status.computed, 0);
  const added = await cache.resolve([b, monitor('c')]); assert.equal(added.status.computed, 1); assert.equal(added.status.reused, 1);
});
test('corrupt, stale, or tampered cache is backed up; no optical values/grants are persisted', async t => {
  const { dir, file } = await fixture(t), cache = new DisplayCache(file), screens = [monitor('a')];
  for (const corruption of ['invalid json', 'old algorithm', 'tamper dimensions', 'nonfinite']) {
    await cache.resolve(screens); const raw = JSON.parse(await readFile(file, 'utf8'));
    if (corruption === 'old algorithm') raw.algorithm = 'old';
    if (corruption === 'tamper dimensions') raw.entries[0].adaptation.outputPixels.width++;
    if (corruption === 'nonfinite') raw.entries[0].adaptation.inverseScale = null;
    const bad = corruption === 'invalid json' ? 'broken' : JSON.stringify(raw); await writeFile(file, bad);
    const result = await cache.resolve(screens); assert.equal(result.status.computed, 1); assert.equal(result.status.written, true); assert.ok(result.status.warning);
    const backups = await Promise.all((await readdir(path.join(dir, 'backups'))).map(f => readFile(path.join(dir, 'backups', f), 'utf8'))); assert.ok(backups.includes(bad));
  }
  const clean = await cache.resolve([{ ...screens[0], captureGrant: 'not-persisted', material: { blur: false } } as DisplayIdentity]);
  assert.equal(clean.status.computed, 0); assert.doesNotMatch(await readFile(file, 'utf8'), /captureGrant|material|data:/);
});
test('save failure preserves existing path and uses valid in-memory profiles', async t => {
  const { file } = await fixture(t); await mkdir(file); await writeFile(path.join(file, 'keep'), 'keep');
  const result = await new DisplayCache(file).resolve([monitor('a')]);
  assert.equal(result.status.written, false); assert.match(result.status.warning!, /保存失败/); assert.equal(result.entries.length, 1);
  assert.equal(await readFile(path.join(file, 'keep'), 'utf8'), 'keep');
  await assert.rejects(new DisplayCache(file).resolve([monitor('a', NaN)]));
});
