import assert from "node:assert/strict";
import { test } from "node:test";
import { adjacentBounds, constrain, roundedRegion, TOOLBAR } from "../window-placement";
import { primaryAction } from "../learning-view";
import { DesktopSession } from "../session";
import type { LearningServices } from "../services";
import { parseView, roleCanAct } from "../security";

const session = new DesktopSession({ call: async () => ({ type: "cleared" }) }, () => {}, { simulated: true } as LearningServices);
const ready = { ...session.snapshot(), phase: "ready" as const, source: { kind: "window" as const, id: "window:1:0", name: "资料" } };
test("one primary maps recording to check, feedback to next round, analysis failure to input reuse", () => {
  assert.equal(primaryAction(ready).intent, "start");
  assert.equal(primaryAction({ ...ready, phase: "recording", recording: true }).intent, "check");
  assert.equal(primaryAction({ ...ready, phase: "feedback", feedback: "结果" }).intent, "start");
  assert.equal(primaryAction({ ...ready, phase: "error", retryable: true, errorStage: "analysis" }).intent, "retry");
  for (const errorStage of ["media", "asr", "input"] as const) assert.equal(primaryAction({ ...ready, phase: "error", errorStage }).intent, "start");
  assert.equal(primaryAction({ ...ready, source: null, phase: "error", errorStage: "media" }).intent, "picker");
  assert.equal(primaryAction(ready, false).intent, "settings");
  assert.equal(primaryAction({ ...ready, phase: "error", errorStage: "configuration" }, true).intent, "start");
  assert.equal(primaryAction({ ...ready, phase: "processing", busy: true }).disabled, true);
});
test("adjacent surfaces fit each edge, negative-coordinate monitors, and preserve toolbar anchor", () => {
  for (const area of [{ x: 0, y: 0, width: 1920, height: 1040 }, { x: -1536, y: -100, width: 1536, height: 824 }, { x: 0, y: 0, width: 800, height: 560 }]) {
    for (const x of [area.x, area.x + area.width - TOOLBAR.width]) for (const y of [area.y, area.y + area.height - TOOLBAR.height]) {
      const anchor = { x, y, ...TOOLBAR }, original = { ...anchor };
      for (let i = 0; i < 20; i++) {
        const { bounds: b, direction } = adjacentBounds(anchor, area, { width: 440, height: 560 });
        assert.ok(b.x >= area.x && b.x + b.width <= area.x + area.width);
        assert.ok(b.y >= area.y && b.y + b.height <= area.y + area.height);
        assert.ok(direction === "up" ? b.y + b.height < anchor.y : b.y > anchor.y + anchor.height);
        assert.deepEqual(anchor, original);
      }
    }
  }
});
test("drag bounds constrain full toolbar and native rounded corners exclude pointer hits", () => {
  const area = { x: 0, y: 0, width: 800, height: 600 };
  assert.deepEqual(constrain({ x: 900, y: 900, ...TOOLBAR }, area), { x: area.width - TOOLBAR.width, y: area.height - TOOLBAR.height, ...TOOLBAR });
  const region = roundedRegion(460, 64, 24);
  const contains = (x: number, y: number) => region.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
  assert.equal(contains(0, 0), false); assert.equal(contains(230, 32), true); assert.equal(contains(459, 63), false);
});
test("new presentation commands remain fixed and do not grant source selection to toolbar", () => {
  assert.equal(parseView("toggle-feedback"), "toggle-feedback"); assert.equal(parseView("move-left"), "move-left");
  assert.throws(() => parseView({ action: "move", x: 100 }));
  assert.equal(roleCanAct("orb", { type: "check", revision: 1 }), true);
  assert.equal(roleCanAct("orb", { type: "select", sourceId: "window:1:0" }), false);
});
test("native hit regions leave CSS curve coverage intact at fractional corner radii", () => {
  for (const radius of [16, 19.2, 20, 24, 32]) {
    const region = roundedRegion(440, 560, radius);
    assert.ok(region.every(r => Object.values(r).every(Number.isInteger)));
    const contains = (x: number, y: number) => region.some(r => x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height);
    assert.equal(contains(0, 0), false);
    for (let step = 0; step <= 90; step++) {
      const angle = step * Math.PI / 180;
      const x = Math.floor(radius - radius * Math.cos(angle)), y = Math.floor(radius - radius * Math.sin(angle));
      for (const [px, py] of [[x, y], [439 - x, y], [x, 559 - y], [439 - x, 559 - y]]) assert.ok(contains(px, py), `curve coverage clipped at radius ${radius}, angle ${step}`);
    }
  }
});
