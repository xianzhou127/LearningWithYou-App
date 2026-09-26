import test from 'node:test';
import assert from 'node:assert/strict';
import { InkStability, inkThreshold } from '../../glass/adaptive-ink';
import { DEFAULT_MATERIAL, patchMaterial } from '../../glass/material-settings';
test('foreground ignores one-frame changes and uses independent region history', () => {
  const ink = new InkStability();
  assert.deepEqual(ink.accept([true, false]), ['dark', 'light']);
  assert.deepEqual(ink.accept([false, true]), ['dark', 'light']);
  assert.deepEqual(ink.accept([true, true]), ['dark', 'dark']);
  assert.deepEqual(ink.accept([false, true]), ['dark', 'dark']);
  assert.deepEqual(ink.accept([false, true]), ['light', 'dark']);
  assert.ok(inkThreshold('dark') < inkThreshold() && inkThreshold() < inkThreshold('light'));
});
test('saved candidate 17 dimming value migrates without restoring background dimming', () => {
  const loaded = patchMaterial(DEFAULT_MATERIAL, { readabilityStrength: .6, tintStrength: 0, blurSigma: .8 });
  assert.equal(loaded.adaptiveText, true); assert.equal(loaded.tintStrength, 0); assert.equal(loaded.blurSigma, .8);
  assert.equal('readabilityStrength' in loaded, false);
  assert.equal(patchMaterial(loaded, { adaptiveText: false }).adaptiveText, false);
});
