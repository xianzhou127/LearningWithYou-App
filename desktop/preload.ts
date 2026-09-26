import { contextBridge, ipcRenderer } from "electron";
import type { DesktopApi, Snapshot, Presentation } from "./shared";
import type { AppearanceApi } from "./glass/api";
let pickerOpened = false;
const pickerListeners = new Set<() => void>();
ipcRenderer.on("t10:picker-opened", () => { pickerOpened = true; pickerListeners.forEach(listener => listener()); });
const api: DesktopApi = {
  testAnalysis: (action, draft) => ipcRenderer.invoke("t16:test-analysis", action, draft),
  surfacePointer: () => ipcRenderer.send("t14:surface-pointer"),
  menuHeight: height => ipcRenderer.send("t13:menu-height", height),
  presentation: () => ipcRenderer.invoke("t13:presentation"),
  onPresentation: callback => { const listener = (_event: unknown, state: Presentation) => callback(state); ipcRenderer.on("t13:presentation", listener); return () => { ipcRenderer.removeListener("t13:presentation", listener); }; },
  historyStatus: () => ipcRenderer.invoke("t12:history-status"),
  onHistoryChanged: callback => { const listener = () => callback(); ipcRenderer.on("t12:history-changed", listener); return () => { ipcRenderer.removeListener("t12:history-changed", listener); }; },
  onPlaybackStop: callback => { const listener = () => callback(); ipcRenderer.on("t12:stop-playback", listener); return () => { ipcRenderer.removeListener("t12:stop-playback", listener); }; },
  historyList: offset => ipcRenderer.invoke("t12:history-list", offset),
  historyDetail: id => ipcRenderer.invoke("t12:history-detail", id),
  historyDelete: id => ipcRenderer.invoke("t12:history-delete", id),
  historyClear: () => ipcRenderer.invoke("t12:history-clear"),
  state: () => ipcRenderer.invoke("t10:state"),
  subscribe: callback => { const listener = (_event: unknown, state: Snapshot) => callback(state); ipcRenderer.on("t10:state", listener); return () => { ipcRenderer.removeListener("t10:state", listener); }; },
  act: action => ipcRenderer.invoke("t10:action", action),
  view: action => ipcRenderer.invoke("t10:view", action),
  sources: kind => ipcRenderer.invoke("t10:sources", kind),
  onPickerOpened: callback => { pickerListeners.add(callback); if (pickerOpened) callback(); return () => { pickerListeners.delete(callback); }; },
  onMenuOpened: callback => { const listener = () => callback(); ipcRenderer.on("t10:menu-opened", listener); return () => { ipcRenderer.removeListener("t10:menu-opened", listener); }; },
  diagnostics: () => ipcRenderer.invoke("t10:diagnostics"),
  exportEvidence: () => ipcRenderer.invoke("t10:export"),
  configuration: (action, draft) => ipcRenderer.invoke("t11:configuration", action, draft),
  windowPreferences: contentProtection => ipcRenderer.invoke("t15:window-preferences", contentProtection),
  onSettingsVisibility: callback => { const listener = (_event: unknown, visible: boolean) => callback(visible); ipcRenderer.on("t13:settings-visibility", listener); return () => { ipcRenderer.removeListener("t13:settings-visibility", listener); }; },
};
contextBridge.exposeInMainWorld("desktop", api);
if (['orb', 'appearance'].includes(new URLSearchParams(location.search).get('role') ?? '')) {
  const on = <T>(name: string, callback: (value: T) => void) => {
    const listener = (_event: unknown, value: T) => callback(value);
    ipcRenderer.on(`appearance:${name}`, listener); return () => { ipcRenderer.removeListener(`appearance:${name}`, listener); };
  };
  const appearance: AppearanceApi = {
    config: () => ipcRenderer.invoke('appearance:config'), onConfig: callback => on('config', callback),
    monitors: () => ipcRenderer.invoke('appearance:monitors'), configure: value => ipcRenderer.invoke('appearance:configure', value),
    prepareCapture: monitorId => ipcRenderer.invoke('appearance:prepare-capture', monitorId),
    tune: patch => ipcRenderer.invoke('appearance:tune', patch),
    saveMaterial: () => ipcRenderer.invoke('appearance:save-material'), saveMotion: () => ipcRenderer.invoke('appearance:save-motion'),
    importSettings: kind => ipcRenderer.invoke('appearance:import', kind),
    geometry: () => ipcRenderer.invoke('appearance:geometry'), onGeometry: callback => on('geometry', callback),
    pointer: inside => ipcRenderer.send('appearance:pointer', inside), placement: value => ipcRenderer.send('appearance:placement', value),
    report: value => ipcRenderer.send('appearance:telemetry', value), telemetry: () => ipcRenderer.invoke('appearance:telemetry'), onTelemetry: callback => on('telemetry', callback),
    utility: action => ipcRenderer.invoke('appearance:utility', action), onDiagnostic: callback => on('diagnostic', callback),
    contextMenu: () => ipcRenderer.send('appearance:context-menu'),
    consumeFeedback: (sessionId, roundId) => ipcRenderer.invoke('appearance:consume-feedback', { sessionId, roundId }),
  };
  contextBridge.exposeInMainWorld('appearance', appearance);
}
