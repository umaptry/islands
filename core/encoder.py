"""The frozen encoder f(448-dim features) -> (x, y), in pure numpy.

Standard UMAP has no reusable projection function: it optimizes point positions
directly, so adding one point can shift every other point. pokeDB replaces that
with an explicit neural encoder trained once against a reference UMAP layout and
then frozen. Every projection afterwards is a pure forward pass, so the same
text always yields the same coordinate and no existing point ever moves.

Training lives in scripts/train_parametric.py (torch). This module only runs the
frozen weights, which keeps torch out of the serving image entirely
(~2.5GB -> ~700MB) and makes cold starts on a free Space much faster.

Architecture, matching pokeDB exactly:
    448 -> Linear 512 -> GELU -> LayerNorm
        -> Linear 256 -> GELU -> LayerNorm
        -> Linear 128 -> GELU
        -> Linear 2
Note LayerNorm follows every hidden block EXCEPT the last one.
"""

import numpy as np

SQRT_2_OVER_PI = 0.7978845608028654
LAYER_NORM_EPS = 1e-5  # torch.nn.LayerNorm default


def _gelu(x):
    """Exact GELU, matching torch.nn.GELU's default (erf) formulation."""
    from scipy.special import erf

    return 0.5 * x * (1.0 + erf(x / np.sqrt(2.0)))


def _layer_norm(x, weight, bias, eps=LAYER_NORM_EPS):
    mean = x.mean(axis=-1, keepdims=True)
    variance = x.var(axis=-1, keepdims=True)
    return (x - mean) / np.sqrt(variance + eps) * weight + bias


class FrozenEncoder:
    """Runs the saved MLP. Stateless and deterministic."""

    def __init__(self, layers, coord_mean, coord_scale, input_dim, hidden_sizes):
        self.layers = layers
        self.coord_mean = np.asarray(coord_mean, dtype=np.float64)
        self.coord_scale = float(coord_scale)
        self.input_dim = int(input_dim)
        self.hidden_sizes = tuple(hidden_sizes)

    def forward(self, features):
        """Return coordinates in the reference layout's own (unscaled) space."""
        x = np.asarray(features, dtype=np.float64)
        single = x.ndim == 1
        if single:
            x = x[None, :]
        if x.shape[1] != self.input_dim:
            raise ValueError(f"expected {self.input_dim} features, got {x.shape[1]}")

        for layer in self.layers:
            x = x @ layer["weight"].T + layer["bias"]
            if layer.get("gelu"):
                x = _gelu(x)
            if "norm_weight" in layer:
                x = _layer_norm(x, layer["norm_weight"], layer["norm_bias"])

        out = x * self.coord_scale + self.coord_mean
        return out[0] if single else out

    __call__ = forward


def _npz_key(index, suffix):
    return f"layer{index}_{suffix}"


def save_encoder(path, state_dict, encoder_arch, coord_mean, coord_scale, scale_bounds):
    """Flatten a torch state_dict into a plain .npz the numpy encoder can read.

    `state_dict` keys look like `net.0.weight`, `net.2.weight` (LayerNorm),
    because the torch module is a Sequential of Linear/GELU/LayerNorm.
    """
    hidden_sizes = list(encoder_arch["hidden_sizes"])
    payload = {}
    # Sequential index -> (Linear at 3*i, GELU at 3*i+1, LayerNorm at 3*i+2)
    sequential_index = 0
    for depth in range(len(hidden_sizes)):
        payload[_npz_key(depth, "weight")] = np.asarray(state_dict[f"net.{sequential_index}.weight"])
        payload[_npz_key(depth, "bias")] = np.asarray(state_dict[f"net.{sequential_index}.bias"])
        payload[_npz_key(depth, "gelu")] = np.array(1)
        sequential_index += 2  # skip the GELU module, which has no parameters
        if depth < len(hidden_sizes) - 1:
            payload[_npz_key(depth, "norm_weight")] = np.asarray(state_dict[f"net.{sequential_index}.weight"])
            payload[_npz_key(depth, "norm_bias")] = np.asarray(state_dict[f"net.{sequential_index}.bias"])
            sequential_index += 1
    output_depth = len(hidden_sizes)
    payload[_npz_key(output_depth, "weight")] = np.asarray(state_dict[f"net.{sequential_index}.weight"])
    payload[_npz_key(output_depth, "bias")] = np.asarray(state_dict[f"net.{sequential_index}.bias"])

    payload["coord_mean"] = np.asarray(coord_mean, dtype=np.float64)
    payload["coord_scale"] = np.asarray(float(coord_scale))
    payload["input_dim"] = np.asarray(int(encoder_arch["input_dim"]))
    payload["hidden_sizes"] = np.asarray(hidden_sizes, dtype=np.int64)
    for key, value in scale_bounds.items():
        payload[f"bounds_{key}"] = np.asarray(float(value))

    np.savez(path, **payload)
    return path


def load_encoder(path):
    """Return (FrozenEncoder, scale_bounds)."""
    data = np.load(path)
    hidden_sizes = data["hidden_sizes"].tolist()

    layers = []
    for depth in range(len(hidden_sizes) + 1):
        layer = {
            "weight": data[_npz_key(depth, "weight")].astype(np.float64),
            "bias": data[_npz_key(depth, "bias")].astype(np.float64),
        }
        if _npz_key(depth, "gelu") in data:
            layer["gelu"] = True
        if _npz_key(depth, "norm_weight") in data:
            layer["norm_weight"] = data[_npz_key(depth, "norm_weight")].astype(np.float64)
            layer["norm_bias"] = data[_npz_key(depth, "norm_bias")].astype(np.float64)
        layers.append(layer)

    encoder = FrozenEncoder(
        layers=layers,
        coord_mean=data["coord_mean"],
        coord_scale=float(data["coord_scale"]),
        input_dim=int(data["input_dim"]),
        hidden_sizes=hidden_sizes,
    )
    scale_bounds = {
        key[len("bounds_"):]: float(data[key]) for key in data.files if key.startswith("bounds_")
    }
    return encoder, scale_bounds
