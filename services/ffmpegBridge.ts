export type FfmpegRunRequest = {
  jobId?: string;
  args: string[];
  cwd?: string;
  durationSec?: number;
};

export type FfmpegRunResult = {
  jobId: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

export type FfmpegProgress = {
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

export const runFfmpeg = (request: FfmpegRunRequest) => getApi().ffmpeg.run(request);

export const cancelFfmpeg = (jobId: string) => getApi().ffmpeg.cancel(jobId);

export const onFfmpegProgress = (callback: (progress: FfmpegProgress) => void) =>
  getApi().ffmpeg.onProgress(callback);
