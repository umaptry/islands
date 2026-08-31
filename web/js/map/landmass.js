// Which posts are standing on the same piece of land.
//
// islands' detectIslands, unchanged in mechanism: two posts belong to the same
// landmass when their influence radii overlap, and that relation is closed
// transitively with union-find. A chain of people whose interests shade into
// one another is one continent, which is the right answer and is not something
// a fixed number of clusters can produce.
//
// The server does this too (core/energy.py) because it needs the membership to
// name each landmass. The browser does it for the label positions and for the
// "this post is on X island" line in the sheet, over just the posts in view.
// The two agree because both read the radius out of /api/config.

import { radiusOf } from '../config.js';

class DisjointSet {
  constructor(size) {
    this.parent = new Int32Array(size);
    for (let i = 0; i < size; i += 1) this.parent[i] = i;
  }

  find(index) {
    let root = index;
    while (this.parent[root] !== root) root = this.parent[root];
    let walk = index;
    while (this.parent[walk] !== root) {
      const next = this.parent[walk];
      this.parent[walk] = root;
      walk = next;
    }
    return root;
  }

  union(a, b) {
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA !== rootB) this.parent[rootA] = rootB;
  }
}

/**
 * [{ posts, cx, cy, size, clusterId }], biggest first.
 *
 * O(n^2) with an early-out on the x gap. The caller passes one viewport - a few
 * hundred posts at most - and at that size a spatial grid costs more to rebuild
 * every time a reaction changes an energy than the pairs cost to walk.
 */
export function detectLandmasses(posts) {
  if (!posts.length) return [];

  const radii = posts.map(radiusOf);
  const sets = new DisjointSet(posts.length);

  for (let i = 0; i < posts.length; i += 1) {
    const xi = posts[i].x;
    const yi = posts[i].y;
    for (let j = i + 1; j < posts.length; j += 1) {
      const reach = radii[i] + radii[j];
      const dx = xi - posts[j].x;
      if (Math.abs(dx) >= reach) continue;
      const dy = yi - posts[j].y;
      if (dx * dx + dy * dy < reach * reach) sets.union(i, j);
    }
  }

  const groups = new Map();
  for (let i = 0; i < posts.length; i += 1) {
    const root = sets.find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(posts[i]);
  }

  const masses = [];
  groups.forEach((members) => {
    // Energy-weighted centre, so a busy post pulls the label onto itself rather
    // than the label floating on empty water between a crowd and a straggler.
    let total = 0;
    let cx = 0;
    let cy = 0;
    const votes = new Map();
    members.forEach((post) => {
      const weight = Math.max(radiusOf(post), 1e-6);
      total += weight;
      cx += post.x * weight;
      cy += post.y * weight;
      const cluster = Number(post.cluster_id) || 0;
      votes.set(cluster, (votes.get(cluster) || 0) + weight);
    });
    let clusterId = 0;
    let best = -1;
    [...votes.keys()].sort((a, b) => a - b).forEach((key) => {
      if (votes.get(key) > best) {
        best = votes.get(key);
        clusterId = key;
      }
    });
    masses.push({
      posts: members,
      cx: cx / total,
      cy: cy / total,
      size: members.length,
      clusterId,
    });
  });

  masses.sort((a, b) => b.size - a.size || a.cx - b.cx);
  return masses;
}

/** postId -> the landmass it stands on. */
export function membership(masses) {
  const index = new Map();
  masses.forEach((mass) => mass.posts.forEach((post) => index.set(post.id, mass)));
  return index;
}
