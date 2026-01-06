# Migration Plan: Electron + Native FFmpeg

This document describes a detailed plan to migrate Beatcutter from a browser-only Vite app to an Electron desktop app with native FFmpeg. The goal is to preserve the current React/TypeScript architecture while removing browser resource limitations.

## Goals

- Keep the UI and state flow in `App.tsx` intact.
- Replace FFmpeg.wasm export with native FFmpeg.
- Move file access to OS-level paths instead of browser File handles.
- Improve performance for large media projects.

## Constraints and Assumptions

- Primary target is Windows.
- React + Vite renderer remains the main UI.
- No new dependencies unless required for Electron packaging.

## Phase 0: Decisions

Chosen defaults for a local-only app:

1. Packaging tool: `electron-builder`.
2. FFmpeg bundle: ship `ffmpeg.exe` and `ffprobe.exe` with the app.
3. FFmpeg execution: spawn in the Electron main process.
4. IPC surface: minimal and explicit.

## Phase 1: Electron Bootstrap

### Tasks

- Add Electron main process entry file.
- Add preload script with a narrow, safe API.
- Update `package.json` scripts to run Vite + Electron in dev.
- Configure build output so Electron loads Vite in dev and static files in prod.

### Deliverables

- `electron/main.ts` - Create BrowserWindow and register IPC handlers.
- `electron/preload.ts` - Expose safe API to renderer.
- `package.json` - Scripts for dev/build.

## Phase 2: Native FFmpeg Integration

### Tasks

- Bundle FFmpeg binaries inside the app resources.
- Add main-process wrapper to spawn FFmpeg and stream progress.
- Implement cancellation support.

### Deliverables

- `electron/ffmpeg.ts` - Spawn and monitor FFmpeg.
- `services/ffmpegBridge.ts` - Renderer calls IPC.

### Notes

- Parse stderr for `time=...` to estimate progress.
- Use a job ID for progress and cancellation.

## Phase 3: File Access + Ingestion

### Tasks

- Replace File System Access API with Electron `dialog.showOpenDialog`.
- Store file paths instead of `File` objects in app state.
- Update ingestion pipeline to load via file path.

### Data Model Changes

- `SourceClip`:
  - Replace `fileHandle: File` with `filePath: string`.
  - Add `proxyPath?: string` (optional).

### Deliverables

- `types.ts` updates.
- `App.tsx` updates to use IPC file selection.

## Phase 4: Export Pipeline

### Tasks

- Replace FFmpeg.wasm export with native FFmpeg command construction.
- Build the same filter graph (trim/setpts/concat).
- Use OS temp directory or project output folder.

### Deliverables

- Updated export handler in `App.tsx`.
- IPC call to `electron/ffmpeg.ts`.

## Phase 5: Proxy Generation (Optional)

### Tasks

- Add background proxy generation using FFmpeg.
- Store proxy paths in project state.
- Toggle between proxy and original in preview.

### Deliverables

- `services/proxyManager.ts` (renderer orchestration).
- IPC handler for proxy jobs.

## Phase 6: Preview Playback

### Tasks

- Keep HTML5 `<video>` preview for now.
- Update preview to load file paths (or proxies).
- If needed, improve buffering by preloading via file path.

## Phase 7: Packaging & Distribution

### Tasks

- Configure packaging tool to include FFmpeg binaries.
- Build Windows installer.
- Validate FFmpeg path resolution at runtime.

### Deliverables

- Packaging config in `package.json` or tool-specific config.
- Release build script.

## IPC API Proposal

- `selectFiles(): Promise<string[]>`
- `runExport(exportSpec): Promise<string>`
- `runProxy(inputPath, targetSpec): Promise<string>`
- `cancelJob(jobId): void`
- `onProgress(jobId, cb): void`

## Risks and Mitigations

- Security: Keep `contextIsolation` enabled and expose minimal preload API.
- Large files: Use direct file paths and avoid loading large blobs in renderer memory.
- Codec support: Preview may still be limited by system codecs; proxy generation mitigates this.

