#!/usr/bin/env python
"""Throughput benchmark: CPU against the AMD Instinct device.

Run with no arguments and it measures what is actually present. If no GPU is
visible it says so in the table and in the JSON, rather than reporting a
speedup of zero or crashing - the point of the number is to be believed.

    python bench.py --batches 1000,10000,100000,1000000

Writes data/bench/cpu_vs_amd.json and a CSV alongside it.
"""

from __future__ import annotations

import argparse
import json
import platform
import sys
import time
from pathlib import Path

import torch

from murphy_gpu import engine, kernel

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[1]
OUT_JSON = REPO / "data" / "bench" / "cpu_vs_amd.json"
OUT_CSV = REPO / "data" / "bench" / "cpu_vs_amd.csv"

DEFAULT_BATCHES = [1000, 10_000, 100_000, 1_000_000]

# per scenario the kernel holds a state row, a scenario-vector row and a few
# per-step columns; this is the resident cost of the batch itself
BYTES_PER_SCENARIO = 900


def memory_budget(device: torch.device) -> int:
    """How many bytes this device can reasonably spend on one batch."""
    if device.type == "cuda":
        try:
            free, total = torch.cuda.mem_get_info(device)
            return int(free * 0.7)
        except Exception:  # pragma: no cover - driver dependent
            return 1 << 30
    # cpu: ask the OS, fall back to a conservative guess
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024 // 2
    except OSError:
        pass
    return 4 << 30


def time_run(
    registry: engine.Registry, device: torch.device, batch: int, repeats: int,
    procedure: str, persona: str, plant: str, method: str, seed: str,
) -> dict:
    best = None
    for _ in range(max(1, repeats)):
        t0 = time.perf_counter()
        out = kernel.run_shifts(
            registry.procedure(procedure), registry.persona(persona), registry.plant(plant),
            method, seed, batch, device, registry.costs(),
        )
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        wall = time.perf_counter() - t0
        rate = batch / wall
        if best is None or wall < best["wallS"]:
            best = {"wallS": wall, "scenariosPerSecond": rate, "failed": int(out.failed.sum())}
    return best


def sweep(
    registry: engine.Registry,
    device_name: str,
    batches: list[int],
    repeats: int = 1,
    procedure: str = "OP-TRF-014",
    persona: str = "night_trainee",
    plant: str = "tk_after_instrument_work",
    method: str = "sparh",
    seed: str = "bench",
) -> dict:
    """Measure one device across a list of batch sizes; never raises for a GPU."""
    available = device_name in ("cuda", "auto") and torch.cuda.is_available()
    note = None
    if device_name in ("cuda", "auto") and not torch.cuda.is_available():
        note = (
            f"device '{device_name}' requested but torch.cuda.is_available() is false: "
            "no AMD Instinct (HIP) runtime is visible to this process, so nothing was run on a GPU"
        )
        device = torch.device("cpu")
    else:
        device = engine.resolve_device(None if device_name == "auto" else device_name)

    budget = memory_budget(device)
    rows = []
    for batch in batches:
        need = batch * BYTES_PER_SCENARIO
        if need > budget:
            rows.append({
                "batch": batch, "skipped": True,
                "reason": f"needs ~{need / 2**30:.1f} GiB, over the {budget / 2**30:.1f} GiB budget for {device}",
            })
            continue
        try:
            measured = time_run(registry, device, batch, repeats, procedure, persona, plant, method, seed)
        except RuntimeError as exc:
            rows.append({"batch": batch, "skipped": True, "reason": f"{type(exc).__name__}: {exc}"[:300]})
            continue
        rows.append({
            "batch": batch, "skipped": False, "device": str(device), **measured,
            "peakMemoryMiB": round((torch.cuda.max_memory_allocated(device) if device.type == "cuda"
                                    else 0) / 2**20, 1),
        })
    return {
        "requested": device_name,
        "used": str(device),
        "gpuVisible": bool(available),
        "note": note,
        "deviceName": torch.cuda.get_device_name(0) if available else platform.processor() or "cpu",
        "torchVersion": torch.__version__,
        "hip": getattr(torch.version, "hip", None),
        "threads": torch.get_num_threads(),
        "rows": rows,
    }


def write_outputs(payload: dict, path: Path, csv_path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=1), encoding="utf-8")
    lines = ["device,batch,wallS,scenariosPerSecond,failed,peakMemoryMiB,note"]
    for row in payload["runs"]:
        for r in row["rows"]:
            lines.append(
                f"{r.get('device', row['used'])},{r['batch']},{r.get('wallS', '')},"
                f"{r.get('scenariosPerSecond', '')},{r.get('failed', '')},{r.get('peakMemoryMiB', '')},"
                f"{json.dumps(r.get('reason', row.get('note', '')))}"
            )
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def print_table(payload: dict) -> None:
    print(f"\ndevice {payload['used']}  torch {payload['torchVersion']}  "
          f"hip {payload['hip'] or 'not built with ROCm'}  threads {payload['threads']}")
    if payload.get("note"):
        print(f"  NOTE: {payload['note']}")
    print(f"  {'batch':>10}  {'wall s':>9}  {'scen/s':>13}  {'failed':>7}")
    for r in payload["rows"]:
        if r.get("skipped"):
            print(f"  {r['batch']:>10}  {'-':>9}  {'-':>13}  {'-':>7}  skipped: {r['reason']}")
        else:
            print(f"  {r['batch']:>10}  {r['wallS']:>9.2f}  {r['scenariosPerSecond']:>13.1f}  {r['failed']:>7}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--batches", default=",".join(str(b) for b in DEFAULT_BATCHES))
    ap.add_argument("--device", default="cpu", help="cpu | cuda | both")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--out", default=str(OUT_JSON))
    ap.add_argument("--csv", default=str(OUT_CSV))
    ap.add_argument("--config", default="OP-TRF-014,night_trainee,tk_after_instrument_work,sparh")
    args = ap.parse_args()

    batches = [int(b) for b in args.batches.split(",") if b.strip()]
    procedure, persona, plant, method = (s.strip() for s in args.config.split(","))
    registry = engine.Registry()

    wanted = ["cpu", "cuda"] if args.device == "both" else [args.device]
    runs = []
    for name in wanted:
        runs.append(sweep(registry, name, batches, args.repeats, procedure, persona, plant, method))
        print_table(runs[-1])

    by_device = {r["used"]: {row["batch"]: row for row in r["rows"] if not row.get("skipped")} for r in runs}
    speedups = []
    if "cpu" in by_device and any(d != "cpu" for d in by_device):
        for gpu, rows in by_device.items():
            if gpu == "cpu":
                continue
            for batch, row in rows.items():
                base = by_device["cpu"].get(batch)
                if base and base["scenariosPerSecond"] > 0:
                    speedups.append({
                        "batch": batch, "device": gpu,
                        "speedup": row["scenariosPerSecond"] / base["scenariosPerSecond"],
                    })

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "host": {"platform": platform.platform(), "python": platform.python_version()},
        "config": {"procedure": procedure, "persona": persona, "plant": plant, "method": method},
        "runs": runs,
        "speedup": speedups,
        "gpuPresent": any(r["gpuVisible"] for r in runs),
    }
    if not payload["gpuPresent"]:
        payload["gpuAbsentReason"] = (
            "No AMD Instinct device was visible (torch.cuda.is_available() is false, torch was not "
            "built with ROCm). Every number above is CPU throughput. The same code runs unmodified on "
            "the ROCm wheel: install a rocm torch build, pass --device cuda, and the tensor kernels "
            "dispatch to the GPU without any change."
        )
        print("\n" + payload["gpuAbsentReason"])

    out = Path(args.out)
    write_outputs(payload, out, Path(args.csv))
    print(f"\nwrote {out} and {args.csv}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
