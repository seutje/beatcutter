import { spawn } from "node:child_process";

const devServerUrl = "http://localhost:5173";
const processes = new Set();
let electronStarted = false;
let viteReady = false;
let mainReady = false;

const stopAll = () => {
  for (const child of processes) {
    if (!child.killed) {
      child.kill();
    }
  }
};

const startElectron = () => {
  if (electronStarted) {
    return;
  }
  if (!viteReady || !mainReady) {
    return;
  }
  electronStarted = true;

  const env = { ...process.env, VITE_DEV_SERVER_URL: devServerUrl };
  const electron = spawn("npm", ["exec", "--", "electron", "."], {
    stdio: "inherit",
    env,
    shell: true,
  });

  processes.add(electron);
  electron.on("exit", () => {
    stopAll();
    process.exit();
  });
};

const vite = spawn("npm", ["run", "dev:renderer"], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: true,
});

processes.add(vite);

vite.stdout.on("data", (data) => {
  const text = data.toString();
  process.stdout.write(text);

  if (!viteReady && text.includes(devServerUrl)) {
    viteReady = true;
    startElectron();
  }
});

vite.stderr.on("data", (data) => {
  process.stderr.write(data.toString());
});

const tsc = spawn("npm", ["run", "dev:main"], {
  stdio: ["inherit", "pipe", "pipe"],
  shell: true,
});

processes.add(tsc);

tsc.stdout.on("data", (data) => {
  const text = data.toString();
  process.stdout.write(text);

  if (!mainReady && text.includes("Watching for file changes")) {
    mainReady = true;
    startElectron();
  }
});

tsc.stderr.on("data", (data) => {
  process.stderr.write(data.toString());
});

process.on("SIGINT", () => {
  stopAll();
  process.exit();
});

process.on("SIGTERM", () => {
  stopAll();
  process.exit();
});

process.on("exit", () => {
  stopAll();
});
