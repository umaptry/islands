"""Package init that pins one import order.

onnxruntime must be imported before scikit-learn. Both ship their own OpenMP
runtime, and on Windows loading scikit-learn's first makes onnxruntime fail at
import with:

    ImportError: DLL load failed while importing onnxruntime_pybind11_state

Reproduced directly:

    import core.features   # pulls sklearn
    import onnxruntime     # ImportError
    # ...the reverse order is fine.

app.py currently happens to import in a working order, but only by accident of
which module comes first in its import block - a harmless-looking reordering
would break startup. Doing it here means every entry point (the app, the build
scripts, the tests) gets the safe order for free.

Wrapped in try/except because scripts/validate_corpus.py only needs Sudachi and
should still run in an environment without onnxruntime installed.
"""

try:  # noqa: SIM105
    import onnxruntime  # noqa: F401
except Exception:  # pragma: no cover - only when serving deps are absent
    pass
