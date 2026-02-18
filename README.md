![Screenshot](screenshot.png)

## Setup
1. Install dependencies:
   `npm install`
2. Run the app (Electron + Vite):
   `npm run dev`

## BeatThis Model Setup
1. Clone BeatThis:
   `git clone https://github.com/CPJKU/beat_this.git /tmp/beat_this_repo`
2. Install export dependencies in a Python environment:
   `pip install soxr einops rotary_embedding_torch torchaudio tqdm onnx onnxscript`
3. Export the ONNX model:
   `PYTHONPATH=/tmp/beat_this_repo python scripts/export_beatthis_onnx.py --checkpoint small0 --out public/models/beatthis-small0.onnx`
4. Ensure the output exists at:
   `public/models/beatthis-small0.onnx`
5. Start Beatcutter; importing audio now uses BeatThis + ONNX Runtime Web for beat detection.

## Build
- Build renderer + Electron main process:
  `npm run build`
- Build with relative asset paths for packaging:
  `npm run build:electron`
- Create an unpacked build (useful for testing):
  `npm run pack`
- Create a Windows installer:
  `npm run dist`

## Usage
1. Import media via the Media Pool (audio + video).
   - Importing the main audio track analyzes beats and creates the audio timeline.
2. Open Auto-Sync, enter BPM / clip length / intro skip (or use Gemini in Options), then apply to generate video cuts.
3. Select timeline segments to tweak timing, fades, and source offsets in the Inspector.
4. Scrub or play from the header controls; zoom the timeline with Ctrl + mouse wheel or Ctrl + / Ctrl -.
5. Export from the header; the MP4 is saved next to the first video clip.
