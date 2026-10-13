"""Islands with bays and headlands, the same on the server and in the browser.

web/js/map/coast.js repeats the hash and the sum; tests/frontend/coast.test.mjs
holds the same numbers as this file, so the two cannot drift apart unnoticed.
"""

import numpy as np

from core.energy import COAST_DEPTH, COAST_WAVES, coast_reach, constants, hash32, post_radius
from core.terrain import energy_grid

ANGLES = np.array([0.0, 1.0, 2.0, 3.0, -2.5])
EXPECTED = {
    "b14fb76b-1c98-59cc-a46d-f8cfbf62293c": [0.708454, 0.912329, 0.864196, 0.834185, 0.808537],
    "島-7": [0.95795, 0.824167, 0.819505, 0.865223, 0.89469],
}


def test_coastlines_match_the_browser():
    assert hash32("abc") == 440920331
    for post_id, values in EXPECTED.items():
        got = coast_reach({"id": post_id, "x": 0, "y": 0}, np.cos(ANGLES), np.sin(ANGLES))
        np.testing.assert_allclose(got, values, atol=1e-6)


def test_the_browser_is_served_the_same_constants():
    served = constants()
    assert served["coast_depth"] == COAST_DEPTH
    assert served["coast_waves"] == [[k, weight] for k, weight in COAST_WAVES]


def test_a_coast_only_pulls_in_and_is_not_a_circle():
    angles = np.linspace(-np.pi, np.pi, 721)
    for post_id in ("a", "b", "p1", *EXPECTED):
        reach = coast_reach({"id": post_id, "x": 0, "y": 0}, np.cos(angles), np.sin(angles))
        assert reach.min() >= 1 - COAST_DEPTH - 1e-9
        assert reach.max() <= 1 + 1e-9
        assert reach.max() - reach.min() > 0.08


def test_the_grid_follows_the_coast():
    post = {"id": "p1", "x": 0.0, "y": 0.0, "energy": 50.0}
    grid = energy_grid([post], [-60.0, -60.0, 60.0, 60.0], 121)   # one sample per world unit
    field = np.array(grid["values"]).reshape(121, 121)
    assert field[60, 60] == 50
    # How far the land (sand and up) reaches right, down, left and up from the post.
    rays = [field[60, 60:], field[60:, 60], field[60, 60::-1], field[60::-1, 60]]
    reach = [int(np.argmax(ray < 30)) for ray in rays]
    circle = post_radius(post) * (1 - 30 / 50)
    assert all(r <= circle + 1 for r in reach)
    assert len(set(reach)) > 1, reach
