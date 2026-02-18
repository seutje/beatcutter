Place the exported BeatThis ONNX model in this directory.

Expected default filename used by the app:
- `beatthis-small0.onnx`

Example export flow:
1. Clone BeatThis:
   - `git clone https://github.com/CPJKU/beat_this.git /tmp/beat_this_repo`
2. Install export deps in a Python venv:
   - `pip install soxr einops rotary_embedding_torch torchaudio tqdm onnx onnxscript`
3. Export:
   - `PYTHONPATH=/tmp/beat_this_repo python scripts/export_beatthis_onnx.py --checkpoint small0 --out public/models/beatthis-small0.onnx`
