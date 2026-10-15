"""Service layer: configuration registry, batch runner, BatchSummary.

Mirrors `src/engine/batch.ts` so that the field names in the JSON this produces
are the field names the web app already consumes. The scenario index is the
pairing key: scenario i always sees the same persona draw and the same equipment
state, which is what lets two variants be differenced scenario by scenario.

Data files are read from the repository's data/ directory and re-read when the
file on disk changes, because the procedure library is edited in place.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import torch

from . import hra, kernel, tank

REPO = Path(__file__).resolve().parents[3]
DATA = REPO / "data"

METHODS = ("sparh", "therp", "heart")

# severityOf() in src/engine/types.ts: a shift that ended in an aborted batch is
# not a shift that ended in a release, and the two are reported on different
# sheets to different people, so the summary keeps them apart.
SEVERITY = {
    "normal": "normal",
    "intercepted": "normal",
    "no_flow": "upset",
    "short_batch": "upset",
    "trip_stop": "upset",
    "no_light_off": "upset",
    "scrap_batch": "upset",
    "minor_release": "incident",
    "overfill": "incident",
    "containment_escape": "incident",
    "line_failure": "incident",
    "tank_breach": "incident",
    "misrouting": "incident",
    "deflagration": "incident",
    "refractory_damage": "incident",
    "shell_hotspot": "incident",
    "hot_start": "incident",
}


class ConfigError(ValueError):
    """A configuration the registry cannot serve."""


class Registry:
    """Procedures, personas, plants and prices, with an mtime-checked cache."""

    def __init__(self, root: Path = DATA) -> None:
        self.root = Path(root)
        self._cache: dict[str, tuple[float, Any]] = {}

    def _load(self, rel: str):
        path = self.root / rel
        if not path.exists():
            raise ConfigError(f"{rel} not found at {path}")
        stamp = path.stat().st_mtime
        hit = self._cache.get(rel)
        if hit and hit[0] == stamp:
            return hit[1]
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        self._cache[rel] = (stamp, data)
        return data

    def procedure(self, pid: str) -> dict:
        for name in sorted((self.root / "procedures").glob("*.json")):
            doc = self._load(f"procedures/{name.name}")
            if doc.get("id") == pid:
                return doc
        raise ConfigError(f"unknown procedure '{pid}'; known: {', '.join(self.procedure_ids())}")

    def procedure_ids(self) -> list[str]:
        out = []
        for name in sorted((self.root / "procedures").glob("*.json")):
            with open(name, encoding="utf-8") as fh:
                out.append(json.load(fh).get("id", name.stem))
        return out

    def persona(self, pid: str) -> dict:
        for row in self._load("personas.json"):
            if row["id"] == pid:
                return row
        raise ConfigError(f"unknown persona '{pid}'")

    def persona_ids(self) -> list[str]:
        return [r["id"] for r in self._load("personas.json")]

    def plant(self, pid: str) -> dict:
        for row in self._load("plants.json"):
            if row["id"] == pid:
                return row
        raise ConfigError(f"unknown plant '{pid}'")

    def plant_ids(self, twin: str | None = None) -> list[str]:
        rows = self._load("plants.json")
        return [r["id"] for r in rows if twin is None or r.get("twin") == twin]

    def costs(self) -> dict:
        return self._load("costs.json")


def resolve_document(registry: Registry, kind: str, value: Any) -> dict:
    """Accept either an id or the document itself.

    The web app sends the compiled procedure inline, because a procedure variant
    that only exists in that session still has to be fuzzed on the accelerator
    rather than silently downgraded to whatever the server has on disk. Ids are
    kept working for direct calls and for the smoke tests.
    """
    if isinstance(value, dict):
        if kind == "procedure" and not value.get("steps"):
            raise ConfigError("inline procedure has no steps")
        if kind != "procedure" and not value.get("id"):
            raise ConfigError(f"inline {kind} has no id")
        return value
    if not isinstance(value, str):
        raise ConfigError(f"{kind} must be an id or an object")
    return {
        "procedure": registry.procedure,
        "persona": registry.persona,
        "plant": registry.plant,
    }[kind](value)


def resolve_device(name: str | None) -> torch.device:
    """`cuda` is the ROCm device too: torch's HIP backend is spelled cuda."""
    if not name or name == "cpu":
        return torch.device("cpu")
    if name.startswith("cuda"):
        if not torch.cuda.is_available():
            raise ConfigError(
                f"device '{name}' requested but torch.cuda.is_available() is false; "
                "no AMD Instinct runtime is visible to this process"
            )
        return torch.device(name)
    return torch.device(name)


def apply_overrides(cfg: dict, overrides: dict[str, Any] | None) -> dict:
    """Variant overrides addressed by dotted path, e.g.
    `{"plant.protection.pis": false}` or `{"procedure.steps[3].durS": 120}`.

    A variant is a *copy*: the registry's own documents are never mutated, or
    two requests would contaminate each other.
    """
    if not overrides:
        return cfg
    import copy

    cfg = copy.deepcopy(cfg)
    for path, value in overrides.items():
        node: Any = cfg
        parts = _path_parts(path)
        for key in parts[:-1]:
            node = node[key]
        leaf = parts[-1]
        if value is None:
            if isinstance(node, dict):
                node.pop(leaf, None)
            continue
        if isinstance(node, list) and isinstance(leaf, int):
            node[leaf] = value
        else:
            node[leaf] = value
    return cfg


def _path_parts(path: str) -> list:
    import re

    parts: list = []
    for chunk in path.split("."):
        match = re.fullmatch(r"([a-zA-Z0-9_-]+)\[(\d+)\]", chunk)
        if match:
            parts += [match.group(1), int(match.group(2))]
        else:
            parts.append(chunk)
    return parts


def shifts_per_year(plant: dict) -> float:
    v = (plant.get("protection") or {}).get("shiftsPerYear")
    return float(v) if isinstance(v, (int, float)) and v > 0 else 600.0


def _quantile(values: torch.Tensor, q: float) -> float:
    """`quantile()` in stats.ts: sort, then floor(q*n) as the index."""
    if values.numel() == 0:
        return 0.0
    idx = min(max(int(q * values.numel()), 0), values.numel() - 1)
    return float(torch.sort(values).values[idx])


def _cvar(values: torch.Tensor, alpha: float = 0.95) -> float:
    if values.numel() == 0:
        return 0.0
    thresh = _quantile(values, alpha)
    tail = values[values >= thresh]
    return float(tail.mean()) if tail.numel() else 0.0


def _mean_ci(values: torch.Tensor, iterations: int = 200, cap: int = 20000, seed: int = 0) -> dict:
    """Percentile bootstrap of the mean, on its own seeded stream.

    The reference resamples every scenario on every iteration, which is O(n *
    iterations); at a million scenarios that is not a reasonable price for a
    confidence interval, so the resample pool is capped and the cap is reported.
    The seed comes from the run seed, so asking for the same batch twice returns
    the same interval instead of a different one every call.
    """
    n = values.numel()
    if n == 0:
        return {"mean": 0.0, "ciLow": 0.0, "ciHigh": 0.0, "pool": 0, "iterations": 0}
    gen = torch.Generator(device="cpu").manual_seed(int(seed))
    pool = values if n <= cap else values[
        torch.randint(0, n, (cap,), generator=gen, dtype=torch.int64).to(values.device)
    ]
    m = pool.numel()
    means = torch.empty(iterations, dtype=torch.float64, device=values.device)
    for b in range(iterations):
        idx = torch.randint(0, m, (m,), generator=gen, dtype=torch.int64).to(values.device)
        means[b] = pool[idx].mean()
    ordered = torch.sort(means).values
    lo = ordered[int(0.025 * iterations)]
    hi = ordered[min(iterations - 1, int(0.975 * iterations))]
    return {
        "mean": float(values.mean()),
        "ciLow": float(lo),
        "ciHigh": float(hi),
        "pool": int(m),
        "iterations": int(iterations),
    }


def summary(
    out: kernel.ShiftOutcome,
    procedure: dict,
    plant: dict,
    seed: str,
    wall_ms: float,
    device: torch.device,
    variant_id: str | None = None,
    collect_worst: int = 0,
) -> dict:
    """The BatchSummary field names from batch.ts, computed on the device."""
    steps = procedure["steps"]
    n = out.cost.numel()
    counts_t = torch.bincount(out.outcome, minlength=len(tank.OUTCOME_CLASSES))
    outcome_counts = {
        name: int(counts_t[i]) for i, name in enumerate(tank.OUTCOME_CLASSES) if int(counts_t[i]) > 0
    }
    severity = [SEVERITY.get(name, "incident") for name in tank.OUTCOME_CLASSES]
    incidents = int(sum(int(counts_t[i]) for i, s in enumerate(severity) if s == "incident"))
    upsets = int(sum(int(counts_t[i]) for i, s in enumerate(severity) if s == "upset"))

    escaped = out.escaped.sum(dim=0)
    caught = out.caught.sum(dim=0)
    firsts = out.first_causal_step
    causal = torch.bincount(firsts[firsts >= 0], minlength=len(steps))
    reached = out.reached.sum(dim=0).to(torch.float64)
    p_mean = torch.where(reached > 0, (out.p * out.reached).sum(dim=0) / torch.clamp(reached, min=1), torch.zeros_like(reached))

    first_on_failed = torch.where(
        out.failed, out.first_causal_step, torch.full_like(out.first_causal_step, -1)
    )
    causal_failure = torch.bincount(first_on_failed[first_on_failed >= 0], minlength=len(steps))

    failed = int(out.failed.sum())
    total_cost = float(out.cost.sum())
    mean_cost = total_cost / n if n else 0.0
    spy = shifts_per_year(plant)

    per_step = {}
    escaped_total = int(escaped.sum())
    for j, step in enumerate(steps):
        esc_j = int(escaped[j])
        per_step[step["id"]] = {
            "thrown": esc_j + int(caught[j]),
            "caught": int(caught[j]),
            "escaped": esc_j,
            "causal": int(causal[j]),
            "causalFailure": int(causal_failure[j]),
            "p": float(p_mean[j]),
            "reached": int(reached[j]),
            "title": step["title"],
            "escapeShare": esc_j / escaped_total if escaped_total else 0.0,
        }

    order = torch.argsort(out.cost, descending=True, stable=True)
    worst = [int(i) for i in order[: max(0, collect_worst)] if float(out.cost[int(i)]) > 0]

    return {
        "variantId": variant_id or f"{procedure['id']}@{procedure.get('revision', '0')}",
        "seed": seed,
        "n": n,
        "failed": failed,
        "failureRate": failed / n if n else 0.0,
        "incidents": incidents,
        "incidentRate": incidents / n if n else 0.0,
        "upsets": upsets,
        "upsetRate": upsets / n if n else 0.0,
        "nearMissRate": int(out.near_miss.sum()) / n if n else 0.0,
        "outcomeCounts": outcome_counts,
        "perStep": per_step,
        "meanCostEur": mean_cost,
        "costCi": _mean_ci(out.cost, seed=_stream_seed(seed)),
        "p95CostEur": _quantile(out.cost, 0.95),
        "cvarCostEur": _cvar(out.cost, 0.95),
        "meanReleaseM3": float(out.magnitudes["releaseM3"].mean()) if n else 0.0,
        "meanElapsedS": float(out.elapsed.mean()) if n else 0.0,
        "meanHazardS": float(out.hazard_seconds.mean()) if n else 0.0,
        "shiftsPerYear": spy,
        "annualLossEur": mean_cost * spy,
        "annualEscalatedEur": mean_cost * spy + (float(out.escalation.sum()) / n if n else 0.0) * spy,
        "wallMs": wall_ms,
        "shiftsPerSecond": (n / wall_ms) * 1000.0 if wall_ms > 0 else 0.0,
        "worst": worst,
    }


def _stream_seed(text: str) -> int:
    """A stable integer for the bootstrap's own stream, taken from the run seed,
    so that asking for the same batch twice returns the same interval."""
    import zlib

    return zlib.crc32(text.encode("utf-8")) & 0x7FFFFFFF


def device_label(dev: torch.device) -> str:
    """What machine actually answered, in the words the UI shows.

    Never a guess: a CPU-only process must not report an AMD device, because the
    whole point of the readout is that the user can tell which engine ran the
    batch.
    """
    if dev.type == "cuda":
        try:
            return torch.cuda.get_device_name(dev)
        except Exception:  # pragma: no cover - driver dependent
            return str(dev)
    return f"cpu ({torch.get_num_threads()} threads)"


def traced_shifts(
    out: kernel.ShiftOutcome,
    procedure: dict,
    persona: dict,
    plant: dict,
    method: str,
    rows: list[int],
) -> list[dict]:
    """ShiftDto-shaped replay records for the scenarios the batch kept.

    The event tape is rebuilt from the tensors that are already there - when each
    step was picked up, when each deviation was thrown, which check closed it -
    so no scenario is re-simulated to answer a click. What is *not* here is the
    per-tick process series and the PSF worksheet of a step: the batched kernel
    keeps the state it needs to decide, not the history a chart wants, so the
    replay from the accelerator is event-level and the local engine remains the
    one that draws the curve.
    """
    steps = procedure["steps"]
    shifts = []
    for i in rows:
        errors: list[dict] = []
        caught_by: dict[str, str] = {}
        trace: list[dict] = [{
            "tS": 0.0, "kind": "clock", "label": "Shift start",
            "detail": f"{persona.get('label', persona['id'])} - {plant.get('label', plant['id'])}",
        }]
        for j, step in enumerate(steps):
            if not bool(out.reached[i, j]):
                continue
            surface = step.get("errors") or []
            trace.append({
                "tS": float(out.started_at_s[i, j]), "kind": "step", "stepId": step["id"],
                "label": step["title"], "detail": step.get("text", ""),
                "vars": {"p": float(out.p[i, j])},
            })
            if not (surface and bool(out.thrown[i, j])):
                continue
            alt = surface[int(out.alternative[i, j])]
            at = float(out.error_at_s[i, j])
            trace.append({
                "tS": at, "kind": "error", "stepId": step["id"], "label": alt["kind"],
                "detail": alt.get("text", ""), "vars": {"p": float(out.p[i, j])},
            })
            if bool(out.caught[i, j]):
                k = int(out.caught_by[i, j])
                if 0 <= k < len(steps):
                    catcher = steps[k]
                    caught_by[f"{step['id']}/{alt['id']}"] = catcher["id"]
                    trace.append({
                        "tS": float(out.started_at_s[i, k]), "kind": "recovery",
                        "stepId": catcher["id"], "label": "Deviation caught",
                        "detail": f"{catcher['title']} caught {alt.get('text', step['id'])}",
                    })
            else:
                errors.append({
                    "stepId": step["id"], "errorId": alt["id"], "kind": alt["kind"],
                    "atS": at, "p": float(out.p[i, j]),
                })

        name = tank.OUTCOME_CLASSES[int(out.outcome[i])]
        note = tank.hazard_note(out.state, i)
        trace.append({
            "tS": float(out.elapsed[i]), "kind": "outcome", "label": name, "detail": note,
            "vars": {k: float(v[i]) for k, v in out.magnitudes.items()},
        })
        trace.sort(key=lambda e: e["tS"])
        shifts.append({
            "scn": int(i),
            "outcome": name,
            "failed": bool(out.failed[i]),
            "nearMiss": bool(out.near_miss[i]),
            "note": note,
            "method": method,
            "errors": errors,
            "caughtBy": caught_by,
            "peak": {k: float(v[i]) for k, v in out.magnitudes.items()},
            "elapsedS": float(out.elapsed[i]),
            "hazardSeconds": float(out.hazard_seconds[i]),
            "scheduleSlip": float(out.schedule_slip[i]),
            "trace": trace,
            "series": [],
            "audit": [],
        })
    return shifts


def run_batch(
    registry: Registry,
    procedure: Any,
    persona: Any,
    plant: Any,
    method: str,
    seed: str,
    n: int,
    device: str | torch.device = "cpu",
    overrides: dict[str, Any] | None = None,
    variant_id: str | None = None,
    collect_worst: int = 0,
) -> dict:
    """Run `n` shifts and return the `{summary, traced, device}` envelope."""
    if method not in METHODS:
        raise ConfigError(f"method must be one of {', '.join(METHODS)}")
    dev = device if isinstance(device, torch.device) else resolve_device(device)
    procedure = apply_overrides(resolve_document(registry, "procedure", procedure), _scoped(overrides, "procedure"))
    persona = apply_overrides(resolve_document(registry, "persona", persona), _scoped(overrides, "persona"))
    plant = apply_overrides(resolve_document(registry, "plant", plant), _scoped(overrides, "plant"))
    if procedure.get("twin") != "tank_transfer":
        raise ConfigError(
            f"the batched engine implements the tank twin; '{procedure.get('twin')}' is not ported"
        )

    t0 = time.perf_counter()
    out = kernel.run_shifts(procedure, persona, plant, method, seed, n, dev, registry.costs())
    if dev.type == "cuda":
        # the queue is asynchronous; the wall time has to include the device work
        torch.cuda.synchronize(dev)
    wall_ms = (time.perf_counter() - t0) * 1000.0
    head = summary(out, procedure, plant, seed, wall_ms, dev, variant_id, collect_worst)
    return {
        "summary": head,
        "traced": traced_shifts(out, procedure, persona, plant, method, head["worst"]),
        "device": device_label(dev),
    }


def _scoped(overrides: dict[str, Any] | None, prefix: str) -> dict[str, Any]:
    if not overrides:
        return {}
    head = prefix + "."
    return {k[len(head):]: v for k, v in overrides.items() if k.startswith(head)}


def psf_reference() -> list[dict]:
    """The published shaping factors, for the reference sheet."""
    return [
        {
            "id": psf,
            "label": {"AVL": "Available time", "STR": "Stress / stressors", "CX": "Complexity",
                      "E-T": "Experience and training", "PRU": "Procedures",
                      "HCI": "Ergonomics / HMI", "FFD": "Fitness for duty", "WMP": "Work processes"}[psf],
            "levels": [
                {"name": lv[0], "mult": lv[1], "fails": lv[3]} for lv in hra.SPAR_PSFS[psf]
            ],
        }
        for psf in hra.PSF_ORDER
    ]
