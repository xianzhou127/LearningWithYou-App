import { useCallback, useEffect, useRef, useState } from "react";
import type { WindowPreferencesStatus } from "./shared";

const errors = {
  read_failed: "窗口设置无法读取，其他窗口的截屏屏蔽已关闭，主体和菜单仍保持屏蔽。原文件保留，可重新选择并保存。",
  save_failed: "其他窗口的截屏屏蔽设置保存失败，原设置保留。请检查本地文件权限后重试。",
  apply_failed: "设置已保存，但部分窗口未能立即应用。请重试应用或重启应用。",
};

export function WindowPreferencesPanel() {
  const [state, setState] = useState<WindowPreferencesStatus | null>(null);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [failure, setFailure] = useState("");
  const pending = useRef(false), active = useRef(false);
  const run = useCallback(async (contentProtection?: boolean) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setNotice(""); setFailure("");
    try {
      const next = await window.desktop.windowPreferences(contentProtection);
      if (!active.current) return;
      setState(next);
      if (next.error) setFailure(errors[next.error]);
      else if (contentProtection !== undefined) setNotice(`已${next.contentProtection ? "开启" : "关闭"}其他窗口的截屏屏蔽，已保存并立即生效。主体和菜单始终保持屏蔽。`);
    } catch { if (active.current) setFailure("窗口设置操作未完成，请重试。"); }
    finally { pending.current = false; if (active.current) setBusy(false); }
  }, []);
  useEffect(() => {
    active.current = true; pending.current = true;
    void window.desktop.windowPreferences().then(next => {
      if (!active.current) return;
      setState(next);
      if (next.error) setFailure(errors[next.error]);
    }).catch(() => { if (active.current) setFailure("窗口设置无法读取，请重试。"); })
      .finally(() => { pending.current = false; if (active.current) setBusy(false); });
    const unsubscribe = window.desktop.onSettingsVisibility(visible => { if (visible) void run(); });
    return () => { active.current = false; unsubscribe(); };
  }, [run]);

  return <section className="configuration window-preferences" aria-label="窗口设置" aria-busy={busy}>
    <label className="window-preferences-toggle" htmlFor="content-protection">
      <input id="content-protection" type="checkbox" role="switch" checked={state?.contentProtection ?? false} disabled={busy || !state} aria-describedby="content-protection-help" onChange={event => void run(event.target.checked)} />
      <span>其他窗口截屏屏蔽</span>
    </label>
    <p id="content-protection-help" className="fine">默认关闭，反馈、设置、历史等其他窗口可出现在截图和录屏中。主体胶囊与菜单始终屏蔽，避免液态玻璃采到自身，不受此开关影响。更改后自动保存并立即生效，重启后保持。</p>
    {failure && <p role="alert" className="error">{failure}</p>}
    {notice && <p role="status" className="configuration-notice">{notice}</p>}
    {!state && !busy && <button onClick={() => void run()}>重新读取</button>}
    {state?.error === "apply_failed" && <button disabled={busy} onClick={() => void run(state.contentProtection)}>重试应用</button>}
  </section>;
}
