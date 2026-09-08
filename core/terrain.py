"""Sample the sum of post influence cones once, without aggregate double counting."""
import hashlib
import json

import numpy as np

from core.energy import total_energy, post_radius


def energy_grid(posts, bounds, resolution=192):
    min_x, min_y, max_x, max_y = bounds
    width = height = resolution
    xs = np.linspace(min_x, max_x, width)
    ys = np.linspace(min_y, max_y, height)
    field = np.zeros((height, width), dtype=np.float64)
    for post in posts:
        energy = total_energy(post)
        radius = post_radius(post)
        if energy <= 0 or radius <= 0:
            continue
        # Touch only samples inside this cone's bounding square.
        x0, x1 = np.searchsorted(xs, [post['x'] - radius, post['x'] + radius], side='left')
        y0, y1 = np.searchsorted(ys, [post['y'] - radius, post['y'] + radius], side='left')
        x1, y1 = min(width, x1 + 1), min(height, y1 + 1)
        distance = np.hypot(xs[None, x0:x1] - post['x'], ys[y0:y1, None] - post['y'])
        field[y0:y1, x0:x1] += energy * np.maximum(0, 1 - distance / radius)
    values = np.round(field, 4).ravel().tolist()
    revision = hashlib.sha256(json.dumps([bounds, values], separators=(',', ':')).encode()).hexdigest()[:24]
    return dict(minX=min_x, minY=min_y, maxX=max_x, maxY=max_y,
                width=width, height=height, values=values, revision=revision)
