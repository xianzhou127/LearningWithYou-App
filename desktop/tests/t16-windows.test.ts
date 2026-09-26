import assert from "node:assert/strict";
import test from "node:test";
import { parseView, roleCanControlWindow } from "../security";

test("native window controls accept fixed actions for the four menu pages only", () => {
  assert.equal(parseView("minimize"), "minimize");
  assert.equal(parseView("toggle-maximize"), "toggle-maximize");
  for (const role of ["picker", "history", "panel", "settings"] as const) assert.equal(roleCanControlWindow(role), true);
  for (const role of ["orb", "menu", "media", "feedback", "appearance"] as const) assert.equal(roleCanControlWindow(role), false);
  for (const action of [{ action: "minimize", role: "media" }, { type: "toggle-maximize", id: 1 }, "maximize-other-window"]) assert.throws(() => parseView(action));
});
