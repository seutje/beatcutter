export type ProxyRunRequest = {
  jobId?: string;
  inputPath: string;
  outputPath: string;
  maxWidth?: number;
  maxHeight?: number;
  crf?: number;
  preset?: string;
  withAudio?: boolean;
  durationSec?: number;
  reverse?: boolean;
};

export type ProxyRunResult = {
  jobId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type ProxyProgress = {
  jobId: string;
  timeSec: number;
  progress?: number;
  line: string;
};

const getApi = () => {
  if (!window.electronAPI) {
    throw new Error("Electron API not available. Are you running inside Electron?");
  }

  return window.electronAPI;
};

export const runProxy = (request: ProxyRunRequest) => getApi().proxy.run(request);

export const cancelProxy = (jobId: string) => getApi().proxy.cancel(jobId);

export const onProxyProgress = (callback: (progress: ProxyProgress) => void) =>
  getApi().proxy.onProgress(callback);
