import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { WindowHeading } from "../desktop/window-heading";
import type { ViewAction } from "../desktop/shared";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
test("page heading sends minimize/maximize/close and follows native maximize state", async () => {
  const actions: ViewAction[] = [];
  const onView = (action: ViewAction) => { actions.push(action); };
  let tree!: ReactTestRenderer;
  await act(async () => { tree = create(<WindowHeading title="设置" onView={onView} />); });
  for (const label of ["最小化", "最大化", "收起窗口"]) await act(async () => tree.root.findByProps({ "aria-label": label }).props.onClick());
  assert.deepEqual(actions, ["minimize", "toggle-maximize", "close"]);
  await act(async () => tree.update(<WindowHeading title="历史回顾" maximized closeLabel="收起历史回顾" onView={onView} />));
  assert.equal(tree.root.findAllByProps({ "aria-label": "最大化" }).length, 0);
  assert.equal(tree.root.findAllByProps({ "aria-label": "收起历史回顾" }).length, 1);
  await act(async () => tree.root.findByProps({ "aria-label": "还原窗口" }).props.onClick());
  assert.equal(actions.at(-1), "toggle-maximize");
  await act(async () => tree.unmount());
});
