import { app, ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync } from "node:fs";
import { join } from "node:path";

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

type ActiveJob = {
  child: ChildProcessWithoutNullStreams;
  sender: WebContents;
  durationSec?: number;
  buffer: string;
};

const activeJobs = new Map<string, ActiveJob>();

const resolveFfmpegPath = (): string => {
  const binaryName = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const envPath = process.env.BEATCUTTER_FFMPEG_PATH;
  const packagedPath = join(process.resourcesPath, "ffmpeg", binaryName);
  const devPath = join(app.getAppPath(), "ffmpeg", binaryName);
  const candidate = envPath ?? (app.isPackaged ? packagedPath : devPath);

  if (!existsSync(candidate)) {
    throw new Error(
      `FFmpeg binary not found at ${candidate}. Place it under resources/ffmpeg or set BEATCUTTER_FFMPEG_PATH.`,
    );
  }

  if (process.platform !== "win32") {
    try {
      chmodSync(candidate, 0o755);
    } catch (error) {
      throw new Error(
        `FFmpeg binary is not executable at ${candidate}. Run chmod +x or set BEATCUTTER_FFMPEG_PATH to an executable binary.`,
      );
    }
  }

  return candidate;
};

const parseTimeToSeconds = (line: string): number | null => {
  const match = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(line);
  if (!match) return null;

  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  if (!Number.isFinite(hours) || !Number.isFinite(minutes) || !Number.isFinite(seconds)) {
    return null;
  }

  return hours * 3600 + minutes * 60 + seconds;
};

const emitProgress = (
  sender: WebContents,
  payload: {
    jobId: string;
    timeSec: number;
    progress?: number;
    line: string;
  },
) => {
  sender.send("ffmpeg:progress", payload);
};

const attachProgressListeners = (jobId: string, job: ActiveJob) => {
  job.child.stderr.on("data", (chunk) => {
    const text = chunk.toString();
    const combined = (job.buffer + text).replace(/\r/g, "\n");
    const lines = combined.split("\n");
    job.buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      const timeSec = parseTimeToSeconds(line);
      if (timeSec === null) continue;

      const progress =
        job.durationSec && job.durationSec > 0
          ? Math.min(100, Math.max(0, (timeSec / job.durationSec) * 100))
          : undefined;

      emitProgress(job.sender, { jobId, timeSec, progress, line });
    }
  });
};

const startFfmpeg = (sender: WebContents, request: FfmpegRunRequest): Promise<FfmpegRunResult> => {
  const jobId = request.jobId ?? randomUUID();

  if (activeJobs.has(jobId)) {
    throw new Error(`FFmpeg job already running for jobId=${jobId}.`);
  }

  const ffmpegPath = resolveFfmpegPath();
  const child = spawn(ffmpegPath, request.args, {
    cwd: request.cwd,
    windowsHide: true,
  });

  const job: ActiveJob = {
    child,
    sender,
    durationSec: request.durationSec,
    buffer: "",
  };

  activeJobs.set(jobId, job);
  attachProgressListeners(jobId, job);

  return new Promise((resolve, reject) => {
    child.once("error", (error) => {
      activeJobs.delete(jobId);
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      activeJobs.delete(jobId);
      resolve({ jobId, exitCode, signal });
    });
  });
};

export const registerFfmpegIpc = () => {
  ipcMain.handle("ffmpeg:run", async (event, request: FfmpegRunRequest) =>
    startFfmpeg(event.sender, request),
  );

  ipcMain.on("ffmpeg:cancel", (_event, jobId: string) => {
    const job = activeJobs.get(jobId);
    if (!job) return;

    job.child.kill("SIGTERM");
  });
};
