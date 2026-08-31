"""islands' terrain rule, on かさなり's coordinates.

This is the whole of what `C:/Users/zk-ht/Downloads/islands` contributes to the
map, stated once so the browser and the server cannot drift apart:

    energy  = motivation + interactions * 5
    radius  = (30 + energy * 0.45) * (2 / 3)
    ground  = the SUM of every post's cone at that point, banded into biomes
    landmass = posts whose radii overlap, joined transitively (union-find)

The only change from islands is what happens next. islands named each landmass
by taking a majority vote over a hand-written table of twelve genres, because
its coordinates were random and there was nothing else to go on. Here the
coordinates mean something, so the name comes from the words of the posts
standing on the landmass - see `name_landmasses` below, which hands off to
core.clustering.name_group. A landmass nobody has written anything nameable on
gets no name and is not labelled.
"""

from core.config import (
    BIOME_COLORS,
    BIOME_THRESHOLDS,
    CONTINENT_MIN_POSTS,
    ENERGY_PER_INTERACTION,
    ENERGY_RADIUS_BASE,
    ENERGY_RADIUS_SCALE,
    ENERGY_RADIUS_TRIM,
    PLOT_TIERS,
)

# Ordered low to high. The client walks the same list.
BIOME_ORDER = ("shallow", "desert", "savanna", "plains", "forest", "mountain")


def interaction_count(post):
    """Reactions plus comments. What islands called "how busy is this"."""
    return (
        int(post.get("like_count") or 0)
        + int(post.get("help_count") or 0)
        + int(post.get("join_count") or 0)
        + int(post.get("comment_count") or 0)
    )


def computed_energy(post):
    """islands' calculateTotalEnergy, from the counts and nothing else.

    This is the definition. `energy` in Postgres is a generated column over the
    same expression, so a row that came from the database already agrees with
    this - but anything that has just changed a count has to come through here,
    or it recomputes the number from the number it is trying to replace.
    """
    motivation = float(post.get("motivation") or 0)
    return motivation + interaction_count(post) * ENERGY_PER_INTERACTION


def total_energy(post):
    """The energy of a post as it should be drawn.

    Prefers a stored `energy` because Postgres maintains it as a generated
    column and trusting it avoids two definitions that agree today. Callers that
    have just MUTATED a count must use computed_energy instead: passing a row
    whose stored energy is stale would return the stale value unchanged, which
    is exactly the bug this pair of functions exists to make impossible to write
    by accident.
    """
    stored = post.get("energy")
    if stored is not None:
        return float(stored)
    return computed_energy(post)


def influence_radius(energy):
    """How far one post's ground reaches. islands: (30 + e * 0.45) * (2/3)."""
    return (ENERGY_RADIUS_BASE + float(energy) * ENERGY_RADIUS_SCALE) * ENERGY_RADIUS_TRIM


def post_radius(post):
    return influence_radius(total_energy(post))


def biome_at(summed_energy):
    """Which band a point of the field falls in. `None` is open sea.

    Note the argument: this is the SUM at a point, not one post's energy. Two
    quiet posts next to each other make plains out of what either alone would
    leave as desert, and that is the mechanism - the map shows where activity
    piles up, not how loud any single person was.
    """
    energy = float(summed_energy)
    if energy < BIOME_THRESHOLDS["shallow"]:
        return None
    if energy < BIOME_THRESHOLDS["desert"]:
        return "shallow"
    if energy < BIOME_THRESHOLDS["savanna"]:
        return "desert"
    if energy < BIOME_THRESHOLDS["plains"]:
        return "savanna"
    if energy < BIOME_THRESHOLDS["forest"]:
        return "plains"
    if energy < BIOME_THRESHOLDS["mountain"]:
        return "forest"
    return "mountain"


def plot_glyph(post):
    """islands' staged settlement icon, by how much has happened on a post."""
    count = interaction_count(post)
    for threshold, glyph in PLOT_TIERS:
        if count >= threshold:
            return glyph
    return PLOT_TIERS[-1][1]


# ---------------------------------------------------------------------------
# landmasses
# ---------------------------------------------------------------------------

class _DisjointSet:
    def __init__(self, size):
        self._parent = list(range(size))

    def find(self, index):
        root = index
        while self._parent[root] != root:
            root = self._parent[root]
        # Path compression, iteratively: islands recursed, and at 800 posts in
        # one chain that is a stack the browser would not survive either.
        while self._parent[index] != root:
            self._parent[index], index = root, self._parent[index]
        return root

    def union(self, a, b):
        root_a, root_b = self.find(a), self.find(b)
        if root_a != root_b:
            self._parent[root_a] = root_b


def detect_landmasses(posts):
    """Group posts whose ground overlaps. islands' detectIslands, minus the naming.

    Returns [{"posts": [...], "cx": float, "cy": float, "size": int,
              "energy": float, "cluster_id": int}], sorted by size descending.

    `cluster_id` is the FROZEN k-means region most of the members sit in. It is
    carried through for one reason: colour. Landmasses merge and split as people
    react to each other, and a colour that changed every time two islands
    touched would make the map look like it was reshuffling itself. The frozen
    region never moves, so neither does the hue.

    O(n^2). Deliberately: the caller passes one viewport's worth of posts (a few
    hundred), and a grid would have to be rebuilt every time an energy changed.
    """
    count = len(posts)
    if count == 0:
        return []

    radii = [post_radius(post) for post in posts]
    sets = _DisjointSet(count)
    for i in range(count):
        xi, yi = float(posts[i]["x"]), float(posts[i]["y"])
        for j in range(i + 1, count):
            reach = radii[i] + radii[j]
            dx = xi - float(posts[j]["x"])
            if abs(dx) >= reach:
                continue
            dy = yi - float(posts[j]["y"])
            if dx * dx + dy * dy < reach * reach:
                sets.union(i, j)

    groups = {}
    for index in range(count):
        groups.setdefault(sets.find(index), []).append(posts[index])

    landmasses = []
    for members in groups.values():
        # Energy-weighted centre: islands did this so a busy post pulls the
        # label towards itself rather than the label sitting on empty ground
        # between a crowd and one straggler.
        weights = [max(total_energy(post), 1e-6) for post in members]
        total = sum(weights)
        cx = sum(float(p["x"]) * w for p, w in zip(members, weights)) / total
        cy = sum(float(p["y"]) * w for p, w in zip(members, weights)) / total

        votes = {}
        for post, weight in zip(members, weights):
            key = int(post.get("cluster_id") or 0)
            votes[key] = votes.get(key, 0.0) + weight
        cluster_id = max(sorted(votes), key=lambda key: votes[key])

        landmasses.append({
            "posts": members,
            "cx": round(cx, 2),
            "cy": round(cy, 2),
            "size": len(members),
            "energy": round(total, 2),
            "cluster_id": cluster_id,
        })

    landmasses.sort(key=lambda mass: (-mass["size"], -mass["energy"], mass["cx"]))
    return landmasses


def terrain_word(size):
    """島 or 大陸. islands drew the line at 50 posts."""
    return "大陸" if size >= CONTINENT_MIN_POSTS else "島"


def name_landmasses(posts, idf, name_group):
    """Landmasses with names taken from the posts standing on them.

    `name_group` is core.clustering.name_group, passed in rather than imported
    so this module stays free of the artifact-loading half of the codebase and
    can be tested against islands' own fixtures with a stub.

    The biggest landmass is named first. When two would pick the same word, the
    one with more people behind it has the better claim - the same rule the map
    used before landmasses existed.
    """
    landmasses = detect_landmasses(posts)
    taken = []
    named = []
    for mass in landmasses:
        term_lists = [post.get("terms") or [] for post in mass["posts"]]
        name = name_group(term_lists, idf, taken)
        if not name:
            # No name, no label. The map starts as open water and grows names
            # as people write things worth naming, rather than presenting a set
            # of genres nobody has posted under.
            continue
        taken.append(name)
        named.append({
            "name": name,
            "label": f"{name}{terrain_word(mass['size'])}",
            "cx": mass["cx"],
            "cy": mass["cy"],
            "size": mass["size"],
            "energy": mass["energy"],
            "cluster_id": mass["cluster_id"],
            "post_ids": [post["id"] for post in mass["posts"]],
        })
    return named


def constants():
    """Everything the browser needs to draw the same ground the server computed."""
    return {
        "energy_per_interaction": ENERGY_PER_INTERACTION,
        "radius_base": ENERGY_RADIUS_BASE,
        "radius_scale": ENERGY_RADIUS_SCALE,
        "radius_trim": ENERGY_RADIUS_TRIM,
        "biome_order": list(BIOME_ORDER),
        "biome_thresholds": dict(BIOME_THRESHOLDS),
        "biome_colors": dict(BIOME_COLORS),
        "plot_tiers": [[threshold, glyph] for threshold, glyph in PLOT_TIERS],
        "continent_min_posts": CONTINENT_MIN_POSTS,
    }


__all__ = [
    "BIOME_ORDER", "biome_at", "computed_energy", "constants", "detect_landmasses",
    "influence_radius", "interaction_count", "name_landmasses", "plot_glyph",
    "post_radius", "terrain_word", "total_energy",
]
