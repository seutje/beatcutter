import { app, BrowserWindow, dialog, ipcMain, protocol } from "electron";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { registerFfmpegIpc } from "./ffmpeg.js";

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
