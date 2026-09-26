import { contextBridge, ipcRenderer } from "electron";
import type { MediaApi, MediaCommand } from "./shared";
const api: MediaApi = {
  onCommand: callback => { const listener = (_event: unknown, command: MediaCommand) => callback(command); ipcRenderer.on("t10:media-command", listener); return () => { ipcRenderer.removeListener("t10:media-command", listener); }; },
  reply: reply => ipcRenderer.send("t10:media-reply", reply),
  event: event => ipcRenderer.send("t10:media-event", event),
  ready: () => ipcRenderer.send("t10:media-ready"),
  pcm: packet => ipcRenderer.invoke("t11:pcm", packet),
};
contextBridge.exposeInMainWorld("mediaHost", api);
