"""One-off: turn an existing frozen map a quarter turn for portrait screens.

Rotation is rigid, so this changes nothing that carries meaning - every pairwise
distance, every cluster membership and every island label is preserved, and the
distance quantiles are identical. It only changes which way up the map is drawn.

Newer builds do this inside isotropic_scale_coordinates; this script exists to
upgrade a map that was built before that, without a 25-minute retrain.

    python scripts/rotate_map.py
"""

import io
import json
import sys
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from core.geometry import quarter_turn  # noqa: E402

ARTIFACTS = ROOT / "artifacts"
SEED_MAP_JSON = ARTIFACTS / "seed_map.json"
ENCODER_NPZ = ARTIFACTS / "encoder.npz"

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")


def main():
    with io.open(SEED_MAP_JSON, encoding="utf-8") as handle:
        payload = json.load(handle)

    bounds = payload["scale_bounds"]
    if bounds.get("quarter_turn"):
        print("[!] すでに回転済みです。何もしません。")
        return 0

    world_center = bounds["world_center"]
    coords = np.array([[row[0], row[1]] for row in payload["seed"]], dtype=float)
    before = coords.max(axis=0) - coords.min(axis=0)
    if before[0] <= before[1]:
        print(f"[!] すでに縦長です（{before[0]:.0f} x {before[1]:.0f}）。何もしません。")
        return 0

    rotated_x, rotated_y = quarter_turn(coords[:, 0], coords[:, 1], world_center)
    rotated = np.stack([rotated_x, rotated_y], axis=1)
    after = rotated.max(axis=0) - rotated.min(axis=0)

    # Rotation must not change a single distance. Prove it before writing.
    sample = np.random.default_rng(42).integers(0, len(coords), (2000, 2))
    original_distances = np.linalg.norm(coords[sample[:, 0]] - coords[sample[:, 1]], axis=1)
    rotated_distances = np.linalg.norm(rotated[sample[:, 0]] - rotated[sample[:, 1]], axis=1)
    drift = float(np.abs(original_distances - rotated_distances).max())
    if drift > 1e-9:
        print(f"[NG] 回転で距離が変わりました（最大 {drift}）。中止します。")
        return 1

    payload["seed"] = [
        [round(float(x), 2), round(float(y), 2), row[2]]
        for (x, y), row in zip(rotated, payload["seed"])
    ]
    for island in payload["islands"]:
        cx, cy = quarter_turn(island["cx"], island["cy"], world_center)
        island["cx"] = round(float(cx), 2)
        island["cy"] = round(float(cy), 2)

    bounds["quarter_turn"] = 1.0
    payload["scale_bounds"] = bounds

    data = dict(np.load(ENCODER_NPZ))
    data["bounds_quarter_turn"] = np.asarray(1.0)
    np.savez(ENCODER_NPZ, **data)

    with io.open(SEED_MAP_JSON, "w", encoding="utf-8", newline="\n") as handle:
        json.dump(payload, handle, ensure_ascii=False, separators=(",", ":"))

    print(f"回転しました: {before[0]:.0f} x {before[1]:.0f}  ->  {after[0]:.0f} x {after[1]:.0f}")
    print(f"距離の最大変化: {drift:.2e}（完全一致）")
    return 0


if __name__ == "__main__":
    sys.exit(main())
