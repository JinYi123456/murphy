"""FastAPI service around the batched engine.

Endpoints:
  GET  /health        what device this process actually sees
  POST /run           one configuration, n scenarios, BatchSummary-shaped JSON
  POST /bench         throughput across batch sizes, on the device you name
  GET  /equivalence   re-run the golden-fixture gates and report match rates

The web app talks to this over HTTP; it is deliberately stateless so that a
browser on a laptop and a batch on an AMD Instinct part ask the same questions
and get the same field names back.
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

import torch
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from . import engine, kernel

APP_DIR = Path(__file__).resolve().parents[1]
if str(APP_DIR) not in sys.path:
    sys.path.insert(0, str(APP_DIR))


def load_sibling(module: str, filename: str):
    """Import a script that sits next to the package (bench.py, verify_golden.py).

    Loaded by path so the service answers correctly no matter which directory
    uvicorn was started from.
    """
    import importlib.util

    spec = importlib.util.spec_from_file_location(module, APP_DIR / filename)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"cannot load {filename}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

app = FastAPI(title="MURPHY GPU engine", version="1.0.0")
REGISTRY = engine.Registry()

MAX_SHIFTS = 2_000_000


class RunRequest(BaseModel):
    procedure: str = "OP-TRF-014"
    persona: str = "daytime_competent"
    plant: str = "tk_asdesigned"
    method: str = "sparh"
    seed: str = "murphy-gpu"
    n: int = Field(1000, ge=1, le=MAX_SHIFTS)
    device: str = "cpu"
    overrides: dict[str, Any] | None = None


class BenchRequest(BaseModel):
    device: str = "cpu"
    batches: list[int] = Field(default_factory=lambda: [1000, 10000, 100000])
    repeats: int = Field(1, ge=1, le=20)
    procedure: str = "OP-TRF-014"
    persona: str = "night_trainee"
    plant: str = "tk_after_instrument_work"
    method: str = "sparh"
    seed: str = "bench"


def _run_shim(cmd: list[str], timeout: float = 4.0) -> dict:
    exe = shutil.which(cmd[0])
    if not exe:
        return {"available": False, "reason": f"{cmd[0]} not on PATH"}
    try:
        res = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        return {"available": False, "reason": f"{cmd[0]} timed out"}
    except OSError as exc:  # pragma: no cover - platform specific
        return {"available": False, "reason": f"{cmd[0]}: {exc}"}
    if res.returncode != 0:
        return {"available": False, "reason": (res.stderr or "").strip()[:400] or f"exit {res.returncode}"}
    return {"available": True, "output": (res.stdout or "").strip()[:4000]}


@app.get("/health")
def health() -> dict:
    cuda = torch.cuda.is_available()
    info: dict[str, Any] = {
        "status": "ok",
        "deviceName": None,
        "torchVersion": torch.__version__,
        "hipAvailable": cuda,
        "cudaAvailable": cuda,
        "builtWithRocm": getattr(torch.version, "hip", None) is not None,
        "torchVersionHip": getattr(torch.version, "hip", None),
        "cpuThreads": torch.get_num_threads(),
        "python": platform.python_version(),
        "platform": platform.platform(),
        "procedures": REGISTRY.procedure_ids(),
        "personas": REGISTRY.persona_ids(),
        "plants": REGISTRY.plant_ids(),
        "methods": list(engine.METHODS),
    }
    if cuda:
        try:
            info["deviceName"] = torch.cuda.get_device_name(0)
            props = torch.cuda.get_device_properties(0)
            info["device"] = {
                "name": props.name,
                "totalMemoryGiB": round(props.total_memory / 1024**3, 2),
                "multiProcessorCount": getattr(props, "multi_processor_count", None),
                "gcnArchName": getattr(props, "gcnArchName", None),
            }
        except Exception as exc:  # pragma: no cover - driver dependent
            info["deviceNameError"] = str(exc)
    info["amdSmi"] = _run_shim(["amd-smi", "static", "--json"]) if cuda or shutil.which("amd-smi") else {
        "available": False, "reason": "amd-smi not consulted: no AMD device visible to torch"
    }
    if not info["amdSmi"].get("available"):
        info["rocmSmi"] = _run_shim(["rocm-smi", "--showproductname"])
    return info


@app.post("/run")
def run(req: RunRequest) -> dict:
    try:
        return engine.run_batch(
            REGISTRY, req.procedure, req.persona, req.plant, req.method,
            req.seed, req.n, req.device, req.overrides,
        )
    except engine.ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except KeyError as exc:
        raise HTTPException(status_code=400, detail=f"unknown configuration key {exc}") from exc


@app.get("/configurations")
def configurations() -> dict:
    return {
        "procedures": REGISTRY.procedure_ids(),
        "personas": REGISTRY.persona_ids(),
        "plants": {"tank_transfer": REGISTRY.plant_ids("tank_transfer")},
        "methods": list(engine.METHODS),
        "psfReference": engine.psf_reference(),
        "outcomeClasses": kernel.tank.OUTCOME_CLASSES,
    }


@app.post("/bench")
def bench(req: BenchRequest) -> dict:
    try:
        bench_mod = load_sibling("murphy_bench_cli", "bench.py")
        return bench_mod.sweep(
            REGISTRY, req.device, req.batches, req.repeats,
            req.procedure, req.persona, req.plant, req.method, req.seed,
        )
    except engine.ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/equivalence")
def equivalence(groups: int = 2, device: str = "cpu") -> dict:
    """Re-run the fixture gates. `groups` caps how many shift groups are
    replayed, because the full fixture sweep takes minutes on a CPU."""
    try:
        vg = load_sibling("murphy_verify_golden", "verify_golden.py")
    except Exception as exc:  # pragma: no cover - depends on checkout layout
        raise HTTPException(status_code=500, detail=f"verify_golden not loadable: {exc}") from exc

    dev = engine.resolve_device(device)
    rep = vg.Report()
    vg.check_philox(rep, dev)
    vg.check_tank(rep, dev)
    vg.check_hep(rep, dev)
    vg.check_shifts(rep, dev, quick=True, limit_groups=groups)
    return {
        "device": str(dev),
        "overall": all(row[3] == vg.PASS for row in rep.rows),
        "gates": [
            {"fixture": r[0], "gate": r[1], "measured": r[2], "result": r[3], "detail": r[4]}
            for r in rep.rows
        ],
    }


@app.get("/")
def index() -> dict:
    return {
        "service": "murphy_gpu",
        "endpoints": ["/health", "/run", "/bench", "/equivalence", "/configurations"],
        "note": "batched PyTorch re-implementation of src/engine; scenario i is "
                "paired by index across runs, so variants difference cleanly",
    }
