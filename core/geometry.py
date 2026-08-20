"""Reference-space coordinates -> map pixels.

Ported from pokeDB. The two rules that matter:

  * ISOTROPIC scaling - x and y share one multiplier, so "twice as far" means
    the same thing horizontally and vertically and distance ratios survive.
  * Only LITERALLY coincident points are nudged apart. pokeDB's earlier version
    forced every pair at least 28px apart, which flattened genuinely-close and
    genuinely-distant pairs onto the same distance and destroyed the signal.
    Icon overlap is a rendering concern, not a coordinate concern.
"""

import math

import numpy as np

from core.config import MAP_MAX, MAP_MIN, MAP_PADDING, OVERLAP_EPSILON

GOLDEN_ANGLE_DEG = 137.508


def quarter_turn(x, y, world_center):
    """Rotate 90 degrees about the centre of the map.

    A rigid transform: every pairwise distance, every relative bearing and every
    cluster is preserved exactly. It exists purely because the app is used in
    portrait, and UMAP has no canonical orientation - a layout that comes out
    900 wide by 640 tall wastes most of a phone screen, and the same layout
    turned on its side does not.
    """
    return world_center + (y - world_center), world_center - (x - world_center)


def isotropic_scale_coordinates(coords_raw):
    """Fit the reference layout into the map box with a single shared scale."""
    center = np.median(coords_raw, axis=0)
    radii = np.linalg.norm(coords_raw - center, axis=1)
    reference_radius = float(np.quantile(radii, 0.99)) or 1.0
    half_span = (MAP_MAX - MAP_MIN) / 2.0 * (1.0 - MAP_PADDING)
    scale = half_span / reference_radius
    world_center = (MAP_MIN + MAP_MAX) / 2.0

    scaled = np.clip(world_center + (coords_raw - center) * scale, MAP_MIN, MAP_MAX)

    # Portrait screens want the long axis vertical.
    spans = scaled.max(axis=0) - scaled.min(axis=0)
    turn = 1 if spans[0] > spans[1] else 0
    if turn:
        rotated_x, rotated_y = quarter_turn(scaled[:, 0], scaled[:, 1], world_center)
        scaled = np.clip(np.stack([rotated_x, rotated_y], axis=1), MAP_MIN, MAP_MAX)

    bounds = {
        "center_x": float(center[0]),
        "center_y": float(center[1]),
        "scale": float(scale),
        "world_center": float(world_center),
        "quarter_turn": float(turn),
    }
    return scaled, bounds


def scale_projected_coordinate(raw_x, raw_y, bounds):
    """The same transform applied to a single new point, forever."""
    world_center = bounds["world_center"]
    x = world_center + (raw_x - bounds["center_x"]) * bounds["scale"]
    y = world_center + (raw_y - bounds["center_y"]) * bounds["scale"]
    if bounds.get("quarter_turn"):
        x, y = quarter_turn(x, y, world_center)
    return (
        float(np.clip(x, MAP_MIN, MAP_MAX)),
        float(np.clip(y, MAP_MIN, MAP_MAX)),
    )


def dejitter_exact_overlaps(points, epsilon=OVERLAP_EPSILON):
    resolved = np.array(points, dtype=float, copy=True)
    seen = {}
    moved = 0
    for index, point in enumerate(resolved):
        key = (round(float(point[0]), 6), round(float(point[1]), 6))
        if key in seen:
            offset = seen[key] + 1
            seen[key] = offset
            angle = offset * GOLDEN_ANGLE_DEG * math.pi / 180.0
            resolved[index] = np.clip(
                point + np.array([math.cos(angle), math.sin(angle)]) * epsilon, MAP_MIN, MAP_MAX
            )
            moved += 1
        else:
            seen[key] = 0
    return resolved, moved


def resolve_exact_overlap(anchor_x, anchor_y, occupied, epsilon=OVERLAP_EPSILON):
    """Return the encoder's anchor untouched unless it sits exactly on another point."""
    point = np.array([
        float(np.clip(anchor_x, MAP_MIN, MAP_MAX)),
        float(np.clip(anchor_y, MAP_MIN, MAP_MAX)),
    ])
    occupied_points = [np.asarray(item, dtype=float) for item in occupied]
    for attempt in range(64):
        if all(np.linalg.norm(point - other) > 1e-6 for other in occupied_points):
            break
        angle = (attempt + 1) * GOLDEN_ANGLE_DEG * math.pi / 180.0
        point = np.clip(
            point + np.array([math.cos(angle), math.sin(angle)]) * epsilon, MAP_MIN, MAP_MAX
        )
    return round(float(point[0]), 2), round(float(point[1]), 2)


def nearest_neighbor_stats(points):
    """Distance-contrast diagnostics: a flat profile means the map lost meaning."""
    points = np.asarray(points, dtype=float)
    distances = []
    for index, point in enumerate(points):
        others = np.delete(points, index, axis=0)
        distances.append(float(np.min(np.linalg.norm(others - point, axis=1))))
    distances = np.array(distances)
    return {
        "min": round(float(distances.min()), 4),
        "median": round(float(np.median(distances)), 4),
        "p95": round(float(np.quantile(distances, 0.95)), 4),
        "max": round(float(distances.max()), 4),
        "p95_over_min": round(float(np.quantile(distances, 0.95) / max(distances.min(), 1e-6)), 4),
    }
