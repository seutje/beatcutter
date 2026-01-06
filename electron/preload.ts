import { contextBridge, ipcRenderer } from "electron";

type AppVersions = {
  electron: string;
  chrome: string;
  node: string;
};

const api = {
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  getVersions: () => ipcRenderer.invoke("app:getVersions") as Promise<AppVersions>,
};

contextBridge.exposeInMainWorld("electronAPI", api);
