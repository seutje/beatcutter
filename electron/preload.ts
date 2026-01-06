import { contextBridge, ipcRenderer } from "electron";

type AppVersions = {
  electron: string;
  chrome: string;
  node: string;
};

type FfmpegRunRequest = {
  jobId?: string;
  args: string[];
  cwd?: string;
  durationSec?: number;
};

type FfmpegRunResult = {
  jobId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type FfmpegProgress = {
  jobId: string;
  timeSec: number;
  progress?: number;
  line: string;
};

const api = {
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  getVersions: () => ipcRenderer.invoke("app:getVersions") as Promise<AppVersions>,
  ffmpeg: {
    run: (request: FfmpegRunRequest) =>
      ipcRenderer.invoke("ffmpeg:run", request) as Promise<FfmpegRunResult>,
    cancel: (jobId: string) => ipcRenderer.send("ffmpeg:cancel", jobId),
    onProgress: (callback: (progress: FfmpegProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: FfmpegProgress) =>
        callback(progress);
      ipcRenderer.on("ffmpeg:progress", listener);
      return () => {
        ipcRenderer.removeListener("ffmpeg:progress", listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
