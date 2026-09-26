import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AppearanceStore, decodeSettings } from '../glass/settings-store';
import { ACCEPTED_MATERIAL, ACCEPTED_MOTION } from '../glass/presets';
import { DEFAULT_MOTION } from '../glass/motion';
import { roleCanAct, trustedFrame } from '../security';
const fixture = async () => new AppearanceStore(path.join(await mkdtemp(path.join(os.tmpdir(), 't15-settings-')), 'appearance'));

test('formal startup uses accepted24 and final accepted10, not engineering defaults', async () => {
  const store = await fixture(); await store.load();
  assert.equal(store.material.settings.blurSigma, .5); assert.equal(store.material.settings.highlightStrength, 3);
  assert.deepEqual(store.motion.settings, { enabled: true, liquid: true, stage: 4, strength: 5, duration: 1, bulge: 5, pull: 22, light: 2.5, waveRadius: 60, waveWidth: 8, waveMs: 580, damping: .27 });
  assert.notDeepEqual(store.motion.settings, DEFAULT_MOTION); assert.equal(store.summary().motion.savedAt, null);
});
test('preview, separate atomic saves, preferences and restart preserve explicit user settings', async () => {
  const store = await fixture();
  store.material = { settings: { ...ACCEPTED_MATERIAL, shadowStrength: .23 }, fps: 60, startupEnabled: false, menuFrost: false };
  store.motion = { settings: { ...ACCEPTED_MOTION, bulge: 2, light: 3.8 }, reduced: true };
  assert.equal(store.summary().material.dirty, true); await store.save('material');
  const first = new AppearanceStore(store.directory); await first.load();
  assert.deepEqual(first.material, store.material); assert.deepEqual(first.motion.settings, ACCEPTED_MOTION);
  await store.save('motion'); const second = new AppearanceStore(store.directory); await second.load();
  assert.deepEqual(second.motion, store.motion); assert.equal(second.summary().motion.dirty, false);
  second.motion = { settings: { ...ACCEPTED_MOTION }, reduced: false };
  assert.equal(second.summary().motion.dirty, true);
  const third = new AppearanceStore(store.directory); await third.load(); assert.equal(third.motion.settings.bulge, 2);
});
test('legacy JSON import is read-only and preview-only; saved experiment values remain exact', async () => {
  const store = await fixture(), source = path.join(path.dirname(store.directory), 'legacy.json');
  const body = JSON.stringify({ schema: 1, revision: 'candidate8', settings: { ...ACCEPTED_MOTION, bulge: 2, light: 3.8 } });
  await writeFile(source, body); await store.importFile('motion', source);
  assert.equal(store.motion.settings.light, 3.8); assert.equal(store.summary().motion.dirty, true);
  const restart = new AppearanceStore(store.directory); await restart.load(); assert.deepEqual(restart.motion.settings, ACCEPTED_MOTION);
  await store.save('motion'); assert.equal(await readFile(source, 'utf8'), body);
});
test('corrupt or unknown-version formal files stay untouched; fallback remains operable', async () => {
  for (const body of ['{bad', JSON.stringify({ schema: 2, settings: ACCEPTED_MATERIAL }), JSON.stringify({ schema: 1, application: 'LearningWithYou', kind: 'material', settings: { blurSigma: 200 } })]) {
    const store = await fixture(); await mkdir(store.directory); await writeFile(store.file('material'), body); await store.load();
    assert.deepEqual(store.material.settings, ACCEPTED_MATERIAL); assert.ok(store.summary().material.warning); assert.equal(await readFile(store.file('material'), 'utf8'), body);
    await store.save('material'); const backups = await readdir(path.join(store.directory, 'backups'));
    assert.equal(await readFile(path.join(store.directory, 'backups', backups[0]), 'utf8'), body);
  }
});
test('whitelist rejects nonfinite values, bad types, unsafe keys and saved out-of-range values', () => {
  for (const settings of [{ bulge: Infinity }, { bulge: 100 }, { enabled: 'true' }, { stage: 0 }, { apiKey: 'no' }, JSON.parse('{"__proto__":{}}')]) assert.throws(() => decodeSettings('motion', { schema: 1, settings }, true));
  assert.throws(() => decodeSettings('material', { schema: 1, settings: {} }, true));
  assert.throws(() => decodeSettings('motion', { schema: 1, kind: 'material', application: 'LearningWithYou', settings: ACCEPTED_MOTION }));
});
test('failed save reports failure and preserves the old file and current preview', async () => {
  const store = await fixture(); await store.save('motion');
  const original = await readFile(store.file('motion'), 'utf8');
  // A path collision prevents backup creation without OS-dependent ACL changes.
  await writeFile(path.join(store.directory, 'backups', 'sentinel'), 'preserved');
  const failing = new AppearanceStore(path.join(store.file('motion'), 'child'));
  failing.motion = { settings: { ...ACCEPTED_MOTION, pull: 9 }, reduced: false };
  await assert.rejects(failing.save('motion')); assert.ok(failing.summary().motion.warning);
  assert.equal(failing.motion.settings.pull, 9); assert.equal(await readFile(store.file('motion'), 'utf8'), original);
});
test('appearance has its own trusted page and never gets learning Action authority', () => {
  assert.equal(trustedFrame('learning://app/glass.html?role=orb', 'orb', true), true);
  assert.equal(trustedFrame('learning://app/index.html?role=orb', 'orb', true), false);
  assert.equal(trustedFrame('learning://app/glass.html?role=appearance', 'appearance', false), false);
  assert.equal(roleCanAct('appearance', { type: 'start', revision: 1 }), false);
});

test('menu frost defaults on for legacy material files; explicit off survives saves and preview restore does not overwrite it', async () => {
  const store = await fixture(); await mkdir(store.directory);
  const legacy = JSON.stringify({ application: 'LearningWithYou', kind: 'material', schema: 1, settings: { ...ACCEPTED_MATERIAL, shadowStrength: .37 }, fps: 60 });
  await writeFile(store.file('material'), legacy); await store.load();
  assert.equal(store.material.menuFrost, true); assert.equal(store.material.settings.shadowStrength, .37);
  assert.equal(await readFile(store.file('material'), 'utf8'), legacy);
  store.material = { ...store.material, menuFrost: false }; await store.save('material');
  const next = new AppearanceStore(store.directory); await next.load(); assert.equal(next.material.menuFrost, false);
  next.material = { ...next.material, settings: { ...ACCEPTED_MATERIAL }, menuFrost: true };
  assert.equal(next.summary().material.dirty, true);
  const restart = new AppearanceStore(store.directory); await restart.load(); assert.equal(restart.material.menuFrost, false);
  for (const menuFrost of [null, 'false', 0, {}]) {
    const body = JSON.stringify({ application: 'LearningWithYou', kind: 'material', schema: 1, settings: ACCEPTED_MATERIAL, menuFrost });
    await writeFile(store.file('material'), body); const invalid = new AppearanceStore(store.directory); await invalid.load();
    assert.equal(invalid.material.menuFrost, true); assert.ok(invalid.summary().material.warning); assert.equal(await readFile(store.file('material'), 'utf8'), body);
  }
});
