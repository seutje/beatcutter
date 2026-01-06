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

declare global {
  interface Window {
    electronAPI?: {
      ping: () => Promise<string>;
      getVersions: () => Promise<AppVersions>;
      selectFiles: () => Promise<string[]>;
      geminiAnalyze: (request: GeminiAnalyzeRequest) => Promise<GeminiAnalyzeResponse>;
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
