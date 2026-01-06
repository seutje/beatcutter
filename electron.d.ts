import type {
  FfmpegProgress,
  FfmpegRunRequest,
  FfmpegRunResult,
} from "./services/ffmpegBridge";
import type {
  ProxyProgress,
  ProxyRunRequest,
  ProxyRunResult,
} from "./services/proxyManager";

type AppVersions = {
  electron: string;
  chrome: string;
  node: string;
};

declare global {
  interface Window {
    electronAPI?: {
      ping: () => Promise<string>;
      getVersions: () => Promise<AppVersions>;
      selectFiles: () => Promise<string[]>;
      ffmpeg: {
        run: (request: FfmpegRunRequest) => Promise<FfmpegRunResult>;
        cancel: (jobId: string) => void;
        onProgress: (callback: (progress: FfmpegProgress) => void) => () => void;
      };
      proxy: {
        run: (request: ProxyRunRequest) => Promise<ProxyRunResult>;
        cancel: (jobId: string) => void;
        onProgress: (callback: (progress: ProxyProgress) => void) => () => void;
      };
    };
  }
}

export {};
