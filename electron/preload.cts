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

type ProxyRunRequest = {
  jobId?: string;
  inputPath: string;
  outputPath: string;
  maxWidth?: number;
  maxHeight?: number;
  crf?: number;
  preset?: string;
  withAudio?: boolean;
  durationSec?: number;
};

type ProxyRunResult = {
  jobId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type ProxyProgress = {
  jobId: string;
  timeSec: number;
  progress?: number;
  line: string;
};

type GeminiAnalyzeRequest = {
  apiKey: string;
  model: string;
  prompt: string;
  mimeType: string;
  base64Data: string;
};

type GeminiAnalyzeResponse = {
  ok: boolean;
  status: number;
  payload?: unknown;
  error?: string;
};

type ProjectSaveRequest = {
  filePath: string;
  data: string;
};

type ProjectSaveResponse = {
  ok: boolean;
  error?: string;
};

type ProjectLoadRequest = {
  filePath: string;
};

type ProjectLoadResponse = {
  ok: boolean;
  data?: string;
  error?: string;
};

type ProjectOpenDialogResponse = string | null;

const api = {
  ping: () => ipcRenderer.invoke("app:ping") as Promise<string>,
  getVersions: () => ipcRenderer.invoke("app:getVersions") as Promise<AppVersions>,
  selectFiles: () => ipcRenderer.invoke("dialog:openFiles") as Promise<string[]>,
  geminiAnalyze: (request: GeminiAnalyzeRequest) =>
    ipcRenderer.invoke("gemini:analyze", request) as Promise<GeminiAnalyzeResponse>,
  project: {
    save: (request: ProjectSaveRequest) =>
      ipcRenderer.invoke("project:save", request) as Promise<ProjectSaveResponse>,
    load: (request: ProjectLoadRequest) =>
      ipcRenderer.invoke("project:load", request) as Promise<ProjectLoadResponse>,
    selectFile: () =>
      ipcRenderer.invoke("project:openDialog") as Promise<ProjectOpenDialogResponse>,
  },
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
  proxy: {
    run: (request: ProxyRunRequest) =>
      ipcRenderer.invoke("proxy:run", request) as Promise<ProxyRunResult>,
    cancel: (jobId: string) => ipcRenderer.send("proxy:cancel", jobId),
    onProgress: (callback: (progress: ProxyProgress) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, progress: ProxyProgress) =>
        callback(progress);
      ipcRenderer.on("proxy:progress", listener);
      return () => {
        ipcRenderer.removeListener("proxy:progress", listener);
      };
    },
  },
};

contextBridge.exposeInMainWorld("electronAPI", api);
