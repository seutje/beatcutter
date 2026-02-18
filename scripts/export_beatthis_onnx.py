#!/usr/bin/env python3
"""
Export BeatThis checkpoints to ONNX for local Beatcutter inference.

Examples:
  python scripts/export_beatthis_onnx.py --checkpoint small0 --out public/models/beatthis-small0.onnx
  python scripts/export_beatthis_onnx.py --checkpoint final0 --out public/models/beatthis-final0.onnx
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import torch
from beat_this.inference import load_model


def _to_2d_tensor(x: torch.Tensor) -> torch.Tensor:
    if x.dim() == 3 and x.shape[-1] == 1:
        return x[..., 0]
    if x.dim() == 3 and x.shape[1] == 1:
        return x[:, 0, :]
    if x.dim() == 1:
        return x.unsqueeze(0)
    if x.dim() != 2:
        raise RuntimeError(f"Expected 2D tensor for beat/downbeat, got shape {tuple(x.shape)}")
    return x


class BeatThisExportWrapper(torch.nn.Module):
    def __init__(self, model: torch.nn.Module):
        super().__init__()
        self.model = model.eval()

    def forward(self, log_mel: torch.Tensor) -> torch.Tensor:
        # Expected export input: [batch, time, 128]
        try:
            output = self.model(log_mel)
        except Exception:
            # Some checkpoints expect [batch, channel, time, mel].
            output = self.model(log_mel.unsqueeze(1))

        beat: torch.Tensor
        downbeat: torch.Tensor
        if isinstance(output, dict):
            beat = _to_2d_tensor(output["beat"])
            downbeat = _to_2d_tensor(output["downbeat"])
        elif isinstance(output, (tuple, list)) and len(output) >= 2:
            beat = _to_2d_tensor(output[0])
            downbeat = _to_2d_tensor(output[1])
        elif isinstance(output, torch.Tensor):
            if output.dim() == 3 and output.shape[-1] == 2:
                return output
            raise RuntimeError(
                f"Unexpected tensor-only output shape {tuple(output.shape)}; expected [..., 2] or beat/downbeat pair."
            )
        else:
            raise RuntimeError(f"Unsupported model output type: {type(output)}")

        return torch.stack((beat, downbeat), dim=-1)


def _resolve_torch_module(obj: Any) -> torch.nn.Module:
    if isinstance(obj, torch.nn.Module):
        return obj

    for attr in ("model", "module", "net", "network"):
        candidate = getattr(obj, attr, None)
        if isinstance(candidate, torch.nn.Module):
            return candidate

    raise RuntimeError(
        "Unable to find a torch.nn.Module inside the loaded BeatThis object. "
        "Inspect load_model(...) return type and update this script."
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Export BeatThis checkpoint to ONNX.")
    parser.add_argument(
        "--checkpoint",
        required=True,
        help="BeatThis checkpoint name/path (for example: small0 or final0).",
    )
    parser.add_argument(
        "--out",
        default="public/models/beatthis-small0.onnx",
        help="Output ONNX path.",
    )
    parser.add_argument("--frames", type=int, default=2000, help="Dummy frame length used for tracing.")
    parser.add_argument("--opset", type=int, default=17, help="ONNX opset version.")
    args = parser.parse_args()

    loaded = load_model(args.checkpoint)
    base_model = _resolve_torch_module(loaded)
    export_model = BeatThisExportWrapper(base_model).eval()

    dummy = torch.zeros((1, args.frames, 128), dtype=torch.float32)
    out_path = Path(args.out)
    out_path.parent.mkdir(parents=True, exist_ok=True)

    torch.onnx.export(
        export_model,
        dummy,
        out_path.as_posix(),
        dynamo=False,
        input_names=["log_mel"],
        output_names=["beat_downbeat"],
        dynamic_axes={
            "log_mel": {1: "time"},
            "beat_downbeat": {1: "time"},
        },
        opset_version=args.opset,
        do_constant_folding=True,
    )

    print(f"Exported ONNX model to {out_path}")


if __name__ == "__main__":
    main()
