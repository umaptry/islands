"""Deterministic parametric UMAP encoder - TRAINING ONLY.

Copied from pokeDB/parametric_encoder.py. This is the only module in the
project that imports torch; serving uses the numpy re-implementation in
core/encoder.py, which reads the .npz this script writes.

Standard UMAP has no reusable projection function: it optimizes point positions
directly, so adding a point means re-running an optimization and existing points
can shift. This module replaces that with an explicit encoder

    f(features) -> (x, y)

trained in two phases:

1. Regression onto a reference UMAP layout, so the map keeps the shape UMAP
   found (and stays comparable to it).
2. Fine-tuning with UMAP's own objective - attraction along the fuzzy
   simplicial set built from the same features, repulsion against negative
   samples - so f is a genuine parametric UMAP encoder rather than a curve
   fitted through 500 memorized points.

Once trained, f is frozen. Every projection afterwards is a pure forward pass:
the same text always yields the same coordinate and no existing point moves.
"""

import math

import numpy as np
import torch
from torch import nn

SEED = 42
HIDDEN_SIZES = (512, 256, 128)
FIT_EPOCHS = 3000
# Fine-tuning with UMAP's own objective was measured on a 60-point holdout and
# made unseen points land WORSE, not better: neighbourhood overlap against the
# achievable ceiling went 0.70 (off) -> 0.65 (300 epochs) -> 0.63 (800 epochs).
# With only ~500 documents the fuzzy graph is too sparse to beat regression onto
# the reference layout, so the phase stays implemented but disabled.
UMAP_EPOCHS = 0
BATCH_SIZE = 128
EDGE_BATCH_SIZE = 1024
LEARNING_RATE = 2e-3
FINETUNE_LEARNING_RATE = 5e-4
WEIGHT_DECAY = 1e-4
NEGATIVE_SAMPLE_RATE = 5
ANCHOR_LOSS_WEIGHT = 0.15
EPSILON = 1e-4


def seed_everything(seed=SEED):
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)


class CoordEncoder(nn.Module):
    """448 -> 512 -> 256 -> 128 -> 2 with GELU activations and LayerNorm."""

    def __init__(self, input_dim, hidden_sizes=None):
        super().__init__()
        hidden_sizes = tuple(hidden_sizes or HIDDEN_SIZES)
        layers = []
        previous = input_dim
        for index, size in enumerate(hidden_sizes):
            layers.append(nn.Linear(previous, size))
            layers.append(nn.GELU())
            if index < len(hidden_sizes) - 1:
                layers.append(nn.LayerNorm(size))
            previous = size
        layers.append(nn.Linear(previous, 2))
        self.net = nn.Sequential(*layers)
        self.input_dim = input_dim
        self.hidden_sizes = hidden_sizes

    def forward(self, features):
        return self.net(features)


def build_fuzzy_graph(features, n_neighbors, metric="cosine", seed=SEED):
    """The same neighbour graph UMAP itself optimizes, reused as the training signal."""
    from umap.umap_ import fuzzy_simplicial_set

    graph = fuzzy_simplicial_set(
        np.asarray(features, dtype=np.float32),
        n_neighbors=n_neighbors,
        random_state=np.random.RandomState(seed),
        metric=metric,
    )[0]
    return graph.tocoo()


def _umap_ab(spread, min_dist):
    from umap.umap_ import find_ab_params

    return find_ab_params(spread, min_dist)


def _regression_phase(encoder, feature_tensor, target_tensor, epochs, generator, verbose):
    optimizer = torch.optim.AdamW(encoder.parameters(), lr=LEARNING_RATE, weight_decay=WEIGHT_DECAY)
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
    criterion = nn.HuberLoss(delta=1.0)
    sample_count = len(feature_tensor)
    last_loss = math.nan

    encoder.train()
    for epoch in range(epochs):
        order = torch.randperm(sample_count, generator=generator)
        epoch_loss = 0.0
        batch_count = 0
        for start in range(0, sample_count, BATCH_SIZE):
            batch = order[start:start + BATCH_SIZE]
            loss = criterion(encoder(feature_tensor[batch]), target_tensor[batch])
            optimizer.zero_grad()
            loss.backward()
            optimizer.step()
            epoch_loss += float(loss.detach())
            batch_count += 1
        schedule.step()
        last_loss = epoch_loss / max(1, batch_count)
        if verbose and (epoch + 1) % 500 == 0:
            print(f"  fit epoch {epoch + 1}/{epochs}: huber={last_loss:.6f}")
    return last_loss


def _umap_phase(encoder, feature_tensor, target_tensor, graph, ab_params, epochs, generator, verbose):
    """Attraction along graph edges, repulsion against random negatives."""
    a, b = ab_params
    heads = torch.from_numpy(graph.row.astype(np.int64))
    tails = torch.from_numpy(graph.col.astype(np.int64))
    weights = torch.from_numpy(graph.data.astype(np.float32))
    probabilities = weights / weights.sum()
    sample_count = len(feature_tensor)

    optimizer = torch.optim.AdamW(
        encoder.parameters(), lr=FINETUNE_LEARNING_RATE, weight_decay=WEIGHT_DECAY
    )
    schedule = torch.optim.lr_scheduler.CosineAnnealingLR(optimizer, T_max=max(1, epochs))
    anchor_criterion = nn.HuberLoss(delta=1.0)
    last_loss = math.nan

    encoder.train()
    for epoch in range(epochs):
        edge_batch = torch.multinomial(
            probabilities, min(EDGE_BATCH_SIZE, len(probabilities)), replacement=True,
            generator=generator,
        )
        head_index = heads[edge_batch]
        tail_index = tails[edge_batch]

        head_points = encoder(feature_tensor[head_index])
        tail_points = encoder(feature_tensor[tail_index])
        positive_distance = torch.sum((head_points - tail_points) ** 2, dim=1)
        attraction = torch.log1p(a * positive_distance.clamp(min=0.0) ** b)

        negative_index = torch.randint(
            0, sample_count, (len(edge_batch) * NEGATIVE_SAMPLE_RATE,), generator=generator
        )
        repeated_heads = head_points.repeat_interleave(NEGATIVE_SAMPLE_RATE, dim=0)
        negative_points = encoder(feature_tensor[negative_index])
        negative_distance = torch.sum((repeated_heads - negative_points) ** 2, dim=1)
        similarity = 1.0 / (1.0 + a * negative_distance.clamp(min=EPSILON) ** b)
        repulsion = -torch.log((1.0 - similarity).clamp(min=EPSILON))

        anchor_batch = torch.randperm(sample_count, generator=generator)[:BATCH_SIZE]
        anchor = anchor_criterion(encoder(feature_tensor[anchor_batch]), target_tensor[anchor_batch])

        loss = attraction.mean() + repulsion.mean() + ANCHOR_LOSS_WEIGHT * anchor
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()
        schedule.step()
        last_loss = float(loss.detach())
        if verbose and (epoch + 1) % 100 == 0:
            print(f"  umap epoch {epoch + 1}/{epochs}: loss={last_loss:.6f}")
    return last_loss


def train_encoder(features, coords, graph=None, ab_params=(1.0, 1.0),
                  fit_epochs=FIT_EPOCHS, umap_epochs=UMAP_EPOCHS, verbose=True):
    """Fit f(features) -> coords, then refine it with the UMAP objective.

    `coords` are the reference UMAP coordinates in UMAP's own (unscaled) space;
    mapping them into map pixels is a separate, fixed affine step.
    """
    seed_everything()
    features = np.asarray(features, dtype=np.float32)
    coords = np.asarray(coords, dtype=np.float32)
    coord_mean = coords.mean(axis=0)
    coord_scale = float(np.abs(coords - coord_mean).std() or 1.0)
    targets = (coords - coord_mean) / coord_scale

    encoder = CoordEncoder(features.shape[1])
    feature_tensor = torch.from_numpy(features)
    target_tensor = torch.from_numpy(targets)
    generator = torch.Generator().manual_seed(SEED)

    fit_loss = _regression_phase(
        encoder, feature_tensor, target_tensor, fit_epochs, generator, verbose
    )
    umap_loss = math.nan
    if graph is not None and umap_epochs:
        # The UMAP loss lives in the reference coordinate scale, so normalize a
        # to match the target normalization used above.
        a, b = ab_params
        scaled_ab = (a * (coord_scale ** (-2.0 * b)), b)
        umap_loss = _umap_phase(
            encoder, feature_tensor, target_tensor, graph, scaled_ab, umap_epochs, generator, verbose
        )

    encoder.eval()
    artifacts = {
        "encoder_state_dict": {
            key: value.cpu().numpy() for key, value in encoder.state_dict().items()
        },
        "encoder_arch": {
            "input_dim": int(features.shape[1]),
            "hidden_sizes": list(encoder.hidden_sizes),
        },
        "coord_mean": coord_mean.astype(np.float32),
        "coord_scale": coord_scale,
        "seed": SEED,
    }
    predicted = predict(encoder, artifacts, features)
    errors = np.linalg.norm(predicted - coords, axis=1) / coord_scale
    stats = {
        "fit_loss": round(float(fit_loss), 6),
        "umap_loss": None if math.isnan(umap_loss) else round(float(umap_loss), 6),
        # Drift is reported in units of the reference layout spread, so the
        # numbers stay meaningful regardless of map pixel size.
        "mean_drift_ratio": round(float(errors.mean()), 4),
        "p95_drift_ratio": round(float(np.quantile(errors, 0.95)), 4),
        "max_drift_ratio": round(float(errors.max()), 4),
    }
    return encoder, artifacts, stats


def build_encoder(artifacts):
    """Rebuild a frozen encoder from saved artifacts."""
    arch = artifacts["encoder_arch"]
    encoder = CoordEncoder(arch["input_dim"], tuple(arch["hidden_sizes"]))
    state = {
        key: torch.from_numpy(np.asarray(value))
        for key, value in artifacts["encoder_state_dict"].items()
    }
    encoder.load_state_dict(state)
    encoder.eval()
    return encoder


def predict(encoder, artifacts, features):
    """Deterministic projection of L2-normalized hybrid features to reference coordinates."""
    features = np.asarray(features, dtype=np.float32)
    with torch.no_grad():
        normalized = encoder(torch.from_numpy(features)).numpy()
    return normalized * artifacts["coord_scale"] + artifacts["coord_mean"]


def neighborhood_overlap(features, coords, query_features, query_coords, k=15):
    """Fraction of a point's feature-space neighbours that are also map neighbours."""
    features = np.asarray(features, dtype=np.float32)
    coords = np.asarray(coords, dtype=np.float32)
    scores = []
    for query_feature, query_coord in zip(query_features, query_coords):
        similarity = features @ np.asarray(query_feature, dtype=np.float32)
        semantic_neighbors = set(np.argsort(-similarity)[:k])
        distances = np.linalg.norm(coords - np.asarray(query_coord, dtype=np.float32), axis=1)
        map_neighbors = set(np.argsort(distances)[:k])
        scores.append(len(semantic_neighbors & map_neighbors) / k)
    return float(np.mean(scores))


def evaluate_generalization(features, coords, graph_neighbors, ab_params, holdout=60,
                            fit_epochs=1500, umap_epochs=UMAP_EPOCHS, k=15):
    """Hold points out, retrain, and check they land among their semantic neighbours.

    Reported relative to the ceiling reached by the reference layout itself, so
    the gate measures the encoder rather than the difficulty of the data.
    """
    features = np.asarray(features, dtype=np.float32)
    coords = np.asarray(coords, dtype=np.float32)
    rng = np.random.default_rng(SEED)
    indices = rng.permutation(len(features))
    test_index = np.sort(indices[:holdout])
    train_index = np.sort(indices[holdout:])

    graph = build_fuzzy_graph(features[train_index], graph_neighbors) if umap_epochs else None
    encoder, artifacts, _ = train_encoder(
        features[train_index], coords[train_index], graph=graph, ab_params=ab_params,
        fit_epochs=fit_epochs, umap_epochs=umap_epochs, verbose=False,
    )
    predicted = predict(encoder, artifacts, features[test_index])
    # Compare inside the encoder's own frame: after fine-tuning its output space
    # is no longer identical to the reference layout, so the training points must
    # be re-projected too.
    train_map = predict(encoder, artifacts, features[train_index])

    achieved = neighborhood_overlap(
        features[train_index], train_map, features[test_index], predicted, k=k
    )
    ceiling = neighborhood_overlap(
        features[train_index], coords[train_index], features[test_index], coords[test_index], k=k
    )
    return {
        "holdout_neighborhood_overlap": round(achieved, 4),
        "reference_layout_ceiling": round(ceiling, 4),
        "overlap_vs_ceiling": round(achieved / max(ceiling, 1e-6), 4),
    }
