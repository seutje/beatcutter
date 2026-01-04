# Design Document: Browser-Based Music Video Editor (Client-Side)

## 1\. Executive Summary

This document outlines the technical design for a Single Page Application (SPA) capable of automatically syncing video clips to an audio track to create a music video. The application operates entirely client-side using modern Web APIs and WebAssembly (WASM), ensuring user privacy and eliminating server costs. The core functionality involves audio analysis (BPM/Beat detection), intelligent video slicing, a non-linear timeline interface, and high-fidelity export via FFmpeg.wasm.

-----

## 2\. Technical Architecture

### 2.1. High-Level Stack

  * **Frontend Framework:** React or Vue 3 (for reactive state management).
  * **State Management:** Redux Toolkit or Pinia (handling complex timeline state).
  * **Build Tool:** Vite (for fast HMR and WASM support).
  * **Language:** TypeScript (strictly typed for media data structures).

### 2.2. Core Libraries & APIs

  * **Audio Processing:** **Web Audio API** (for playback and raw data access).
  * **Audio Analysis:** Custom implementation using **Spectral Flux** or a library like `essentia.js` for BPM and onset detection.
  * **Video Preview Engine:** **HTML5 Canvas** + **WebCodecs API** (experimental) or optimized `<video>` element sequencing.
  * **Export/Rendering:** **FFmpeg.wasm** (multi-threaded version).
  * **File Handling:** **File System Access API** (where supported) and `URL.createObjectURL` for blob management without loading full files into RAM.

-----

## 3\. Data Flow & Modules

### 3.1. The Media Ingestion Module

  * **Input:** Drag-and-drop zone.
  * **Processing:**
      * Files are kept as `File` handles.
      * **Proxy Generation (Optional but Recommended):** If files are 4K HEVC, generate 720p proxies via FFmpeg.wasm for smooth timeline scrubbing, or rely on browser native decoding if performant enough.
      * Waveforms generated for audio visualization.

### 3.2. Audio Analysis Engine

1.  **Decode Audio:** Decode audio file into an `AudioBuffer`.
2.  **Onset Detection:** Analyze peaks to find transients (beats).
3.  **BPM Calculation:** Use interval histogramming to determine the Tempo (Beats Per Minute).
4.  **Grid Mapping:** Create a "Beat Grid" data structure mapping timestamps (ms) to Musical Measures (Bars) and Beats (1/4 notes).

### 3.3. The "Auto-Sync" Algorithm

The core logic for generating the initial cut.

1.  **Input:** Array of Video Clips, Audio Beat Grid, Target Cut Frequency (e.g., "Cut on every Bar" or "Dynamic").
2.  **Filtering:** Filter out clips shorter than the target interval.
3.  **Selection:** Randomly or sequentially select a video clip for the current time slot.
4.  **Trimming:**
      * Select a "Sub-clip" from the source video.
      * Default behavior: Center crop (temporal) or Start-to-duration.
      * Ensure the duration matches the audio interval (e.g., 1 Bar at 120BPM = 2000ms).
5.  **Output:** A `Sequence` state object populated with `ClipSegment` items.

-----

## 4\. User Interface Design

### 4.1. Layout

  * **Header:** Import buttons, Export settings, Playback controls (Play, Pause, Loop).
  * **Main Stage (Top Center):** \* **Video Preview:** 16:9 Canvas/Video element.
    \*
  * **Media Pool (Left Sidebar):** List of uploaded clips with thumbnails and duration.
  * **Inspector (Right Sidebar):** Properties of the currently selected clip (Speed, Volume, Source Time offsets).
  * **Timeline (Bottom):**
      * **Track 1:** Audio Waveform with visual markers for Beats/Bars.
      * **Track 2:** Video Clips visualized as blocks. Snaps to grid.

### 4.2. Timeline Interaction

  * **Zooming:** Mouse wheel to zoom in/out on the timeline (pixel-to-millisecond ratio).
  * **Slip Edit:** Click and drag the *content* of a clip without moving its position on the timeline (changing the in/out points relative to the source).
  * **Ripple Edit:** (Optional) Rearranging clip order.
  * **Quantization:** All movements snap to the nearest 1/4, 1/8, or 1/16 note based on the calculated BPM.

-----

## 5\. Implementation Details

### 5.1. Audio Analysis (Beat Detection) logic

Instead of full Music Information Retrieval (MIR), we implement a lightweight energy detector:

```typescript
interface BeatGrid {
  bpm: number;
  offset: number; // Time in sec to first beat
  beats: number[]; // Array of timestamps
}

// Logic:
// 1. Get Channel Data from AudioBuffer
// 2. Divide into small windows (e.g., 20ms)
// 3. Calculate RMS (Root Mean Square) amplitude for each window
// 4. Compare local energy to average local energy history (1s) to find peaks
// 5. Use autocorrelation on peaks to find dominant interval (BPM)
```

### 5.2. Video Preview Sync Strategy

Rendering 4K clips in real-time in the DOM is heavy.

  * **Strategy:** Dual-Buffer Video Elements.
  * Use two hidden `<video>` elements.
  * While Video A plays Clip 1, Video B preloads Clip 2 and seeks to the correct start time.
  * At the cut point, swap visibility (or draw the active video to a central Canvas).
  * *Fallback:* If the browser lags, the audio keeps playing, and the video "catches up" (frame dropping).

### 5.3. FFmpeg.wasm Export Pipeline

Since we cannot rely on the DOM for the final export (frame dropping is unacceptable), we re-render everything using FFmpeg.

1.  **User Trigger:** Click "Export 4K".
2.  **Manifest Generation:** Create a text file (virtual) listing inputs and filter complex.
3.  **FFmpeg Command Construction:**
      * Instead of simple concatenation, we use the `filter_complex` graph.
      * We must calculate exact `trim` (start/end) and `setpts` (timestamp) for every clip.
4.  **Execution:**
    ```bash
    # Conceptual FFmpeg command structure
    ffmpeg -i clip1.mp4 -i clip2.mp4 -i audio.mp3 \
    -filter_complex \
    "[0:v]trim=start=10:end=14,setpts=PTS-STARTPTS,scale=3840:2160[v0]; \
     [1:v]trim=start=5:end=9,setpts=PTS-STARTPTS,scale=3840:2160[v1]; \
     [v0][v1]concat=n=2:v=1:a=0[outv]" \
    -map "[outv]" -map 2:a -c:v libx264 -preset ultrafast output.mp4
    ```
5.  **Memory Management:**
      * Large files must be processed in chunks or the user must be warned about RAM limits.
      * Use `SharedArrayBuffer` to prevent UI freezing during render.

-----

## 6\. Data Structures (TypeScript Interfaces)

```typescript
type TimeMS = number;

interface Project {
  id: string;
  bpm: number;
  clips: SourceClip[];
  timeline: TimelineTrack[];
}

interface SourceClip {
  id: string;
  fileHandle: File; // The raw file blob
  duration: TimeMS;
  thumbnailUrl: string;
}

interface TimelineTrack {
  id: string;
  type: 'video' | 'audio';
  segments: ClipSegment[];
}

interface ClipSegment {
  id: string;
  sourceClipId: string;
  
  // Timeline positioning
  timelineStart: TimeMS; 
  duration: TimeMS;      
  
  // Source content selection (The "Slip")
  sourceStartOffset: TimeMS; 
}
```

-----

## 7\. Performance & Limitations

### 7.1. Browser Constraints

  * **Memory Limit:** Browsers cap tab memory (often 2GB-4GB). Loading 20 4K clips into memory simultaneously will crash.
      * *Mitigation:* Do not read files into ArrayBuffers until the exact moment of Export. During Preview, stream via `URL.createObjectURL`.
  * **Codec Support:** Not all browsers support H.265 (HEVC).
      * *Mitigation:* Detect support. If unsupported, use FFmpeg.wasm to transcode proxies (slow) or warn user.

### 7.2. Cross-Origin Isolation

  * Required for `SharedArrayBuffer` (crucial for FFmpeg.wasm).
  * **Headers required:**
      * `Cross-Origin-Opener-Policy: same-origin`
      * `Cross-Origin-Embedder-Policy: require-corp`
