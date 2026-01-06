import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFfmpegIpc, registerProxyIpc } from "./ffmpeg.js";

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

const devServerUrl = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(devServerUrl);
const currentDir = dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([
  {
    scheme: "media",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
]);

const createWindow = async () => {
  const preloadPath = join(currentDir, "preload.cjs");

  const win = new BrowserWindow({
    width: 1280,
    height: 720,
    backgroundColor: "#111111",
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev && devServerUrl) {
    await win.loadURL(devServerUrl);
    win.webContents.openDevTools({ mode: "detach" });
    return;
  }

  const indexPath = join(app.getAppPath(), "dist", "index.html");
  await win.loadFile(indexPath);
};

app.whenReady().then(() => {
  protocol.registerFileProtocol("media", (request, callback) => {
    const url = new URL(request.url);
    const hostPart = url.host ? `/${url.host}` : "";
    let pathName = decodeURIComponent(`${hostPart}${url.pathname}`);
    if (process.platform === "win32" && pathName.startsWith("/")) {
      pathName = pathName.slice(1);
    }
    callback({ path: pathName });
  });

  ipcMain.handle("app:ping", () => "pong");
  ipcMain.handle("app:getVersions", () => ({
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  }));
  ipcMain.handle(
    "gemini:analyze",
    async (_event, request: GeminiAnalyzeRequest): Promise<GeminiAnalyzeResponse> => {
      try {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${request.model}:generateContent?key=${request.apiKey}`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              contents: [
                {
                  role: "user",
                  parts: [
                    { text: request.prompt },
                    { inline_data: { mime_type: request.mimeType, data: request.base64Data } },
                  ],
                },
              ],
              generationConfig: { temperature: 0.2 },
            }),
          }
        );

        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          return {
            ok: false,
            status: response.status,
            error:
              typeof payload?.error?.message === "string"
                ? payload.error.message
                : "Gemini request failed.",
          };
        }

        return { ok: true, status: response.status, payload };
      } catch (error) {
        return {
          ok: false,
          status: 0,
          error: error instanceof Error ? error.message : "Gemini request failed.",
        };
      }
    }
  );
  ipcMain.handle("dialog:openFiles", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      filters: [
        {
          name: "Media",
          extensions: [
            "mp4",
            "mov",
            "mkv",
            "webm",
            "avi",
            "mp3",
            "wav",
            "flac",
            "aac",
            "m4a",
            "ogg",
            "opus",
          ],
        },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });
  registerFfmpegIpc();
  registerProxyIpc();

  void createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});
