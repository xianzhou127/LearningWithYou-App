import type { ViewAction } from "./shared";
import { UiIcon } from "./ui-icon";

export function WindowHeading({ title, maximized = false, closeLabel = "收起窗口", onView }: {
  title: string; maximized?: boolean; closeLabel?: string; onView(action: ViewAction): void;
}) {
  return <header className="heading"><span>{title}</span><div className="window-controls">
    <button type="button" className="icon-button" aria-label="最小化" title="最小化" onClick={() => onView("minimize")}><UiIcon name="minimize" /></button>
    <button type="button" className="icon-button" aria-label={maximized ? "还原窗口" : "最大化"} title={maximized ? "还原窗口" : "最大化"} onClick={() => onView("toggle-maximize")}><UiIcon name={maximized ? "restore-window" : "maximize"} /></button>
    <button type="button" className="icon-button" aria-label={closeLabel} title={closeLabel} onClick={() => onView("close")}><UiIcon name="close" /></button>
  </div></header>;
}
