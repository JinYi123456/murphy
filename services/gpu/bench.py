#!/usr/bin/env python
"""Throughput benchmark: CPU against the AMD Instinct device.

Runs the same kernel, the same configuration and the same scenarios on both
machines and reports scenarios per second, the memory high-water each one reached
and the speedup. With no accelerator visible it still completes and says plainly
that only the CPU column was measured - a missing GPU is a fact to report, not an
error to raise.

    python bench.py --batches 1000,10000,100000
    python bench.py --batches 1000,10000,100000,1000000 --device both

Writes data/bench/cpu_vs_amd.json and data/bench/cpu_vs_amd.csv, and nothing
else: the artefacts are the ones the console's evidence sheet links to.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import os
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

# Resident bytes per scenario: a state row (19 doubles), a scenario row (18), and
# one column per step for the deviation record, plus the temporaries each tensor
# expression allocates and the caching allocator keeps. Measured on this tree: a
# batch of 100000 raises the process high-water mark from about 205 MiB of baseline
# to 532 MiB, so ~3.4 KiB per scenario. The high-water column in the output is the
# check on this number - if it drifts, the budget here is wrong, not the run.
BYTES_PER_SCENARIO = 3400


def peak_rss_bytes() -> int:
    """High-water mark of this process's resident memory, or 0 if unknown.

    Asked of the operating system rather than of torch, because on CPU the batch
    lives in torch's ordinary allocations and the interesting number is the whole
    process. torch's own device counters cover the accelerator.
    """
    if os.name == "nt":
        # the 10 members of PROCESS_MEMORY_COUNTERS, in order: a struct with an
        # extra field makes the call fail with ERROR_INVALID_PARAMETER (6)
        class Counters(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_uint32),
                ("PageFaultCount", ctypes.c_uint32),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = Counters()
        counters.cb = ctypes.sizeof(counters)
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        # GetCurrentProcess must not be truncated to a C int: the pseudo handle is
        # -1, and a 32-bit copy of it is an invalid handle
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        handle = kernel32.GetCurrentProcess()
        for dll, name in (("kernel32", "K32GetProcessMemoryInfo"), ("psapi", "GetProcessMemoryInfo")):
            try:
                lib = ctypes.WinDLL(dll, use_last_error=True)
                fn = getattr(lib, name)
            except (OSError, AttributeError):
                continue
            fn.argtypes = [ctypes.c_void_p, ctypes.POINTER(Counters), ctypes.c_uint32]
            fn.restype = ctypes.c_int
            if fn(handle, ctypes.byref(counters), counters.cb):
                return int(counters.PeakWorkingSetSize)
        return 0
    try:
        with open("/proc/self/status", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("VmHWM:"):
                    return int(line.split()[1]) * 1024
    except OSError:
        pass
    return 0


def available_bytes(device: torch.device) -> int:
    """How many bytes this device can reasonably spend on one batch.

    Half of what the machine says is free. The batch is refused rather than
    started when it does not fit, because a run that is swapped out measures the
    disk and not the kernel.
    """
    if device.type == "cuda":
        try:
            free, _total = torch.cuda.mem_get_info(device)
            return int(free * 0.7)
        except Exception:  # pragma: no cover - driver dependent
            return 1 << 30
    try:
        with open("/proc/meminfo", encoding="utf-8") as fh:
            for line in fh:
                if line.startswith("MemAvailable:"):
                    return int(line.split()[1]) * 1024 // 2
    except OSError:
        pass
    if os.name == "nt":
        try:
            class Status(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_uint32),
                    ("dwMemoryLoad", ctypes.c_uint32),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            st = Status()
            st.dwLength = ctypes.sizeof(st)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(st)):
                return int(st.ullAvailPhys // 2)
        except Exception:  # pragma: no cover - depends on the Windows build
            return 4 << 30
    return 4 << 30


def time_run(
    registry: engine.Registry, device: torch.device, batch: int, repeats: int,
    procedure: str, persona: str, plant: str, method: str, seed: str,
) -> dict:
    """Best of `repeats` measured runs of one batch size on one device."""
    cfg = (
        registry.procedure(procedure), registry.persona(persona), registry.plant(plant),
    )
    costs = registry.costs()
    best = None
    for _ in range(max(1, repeats)):
        if device.type == "cuda":
            torch.cuda.reset_peak_memory_stats(device)
        before = peak_rss_bytes()
        t0 = time.perf_counter()
        out = kernel.run_shifts(*cfg, method, seed, batch, device, costs)
        if device.type == "cuda":
            torch.cuda.synchronize(device)
        wall = time.perf_counter() - t0
        host_peak = peak_rss_bytes()
        device_peak = (
            torch.cuda.max_memory_allocated(device) if device.type == "cuda" else 0
        )
        row = {
            "wallS": wall,
            "scenariosPerSecond": batch / wall,
            "failed": int(out.failed.sum()),
            "meanCostEur": float(out.cost.mean()),
            "peakHostMiB": round(max(host_peak, before) / 2**20, 1),
            "peakDeviceMiB": round(device_peak / 2**20, 1),
            "grewMiB": round(max(0, host_peak - before) / 2**20, 1),
        }
        if best is None or wall < best["wallS"]:
            best = row
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
    allow_oversubscribe: bool = False,
) -> dict:
    """Measure one device across a list of batch sizes; never raises for a GPU."""
    gpu_wanted = device_name in ("cuda", "auto")
    gpu_visible = gpu_wanted and torch.cuda.is_available()
    note = None
    if gpu_wanted and not gpu_visible:
        note = (
            f"device '{device_name}' requested but torch.cuda.is_available() is false: "
            "no AMD Instinct (HIP) runtime is visible to this process, so nothing ran on a GPU"
        )
        device = torch.device("cpu")
    else:
        device = engine.resolve_device(None if device_name in ("auto", "both") else device_name)

    budget = available_bytes(device)
    rows = []
    for batch in batches:
        need = batch * BYTES_PER_SCENARIO
        if need > budget and not allow_oversubscribe:
            rows.append({
                "batch": batch, "skipped": True, "device": str(device),
                "reason": f"needs about {need / 2**30:.1f} GiB, over the "
                          f"{budget / 2**30:.1f} GiB headroom allowed on {device}",
            })
            continue
        try:
            measured = time_run(registry, device, batch, repeats, procedure, persona, plant, method, seed)
        except RuntimeError as exc:
            rows.append({"batch": batch, "skipped": True, "device": str(device),
                         "reason": f"{type(exc).__name__}: {exc}"[:300]})
            continue
        rows.append({"batch": batch, "skipped": False, "device": str(device), **measured})
    return {
        "requested": device_name,
        "used": str(device),
        "deviceLabel": engine.device_label(device),
        "gpuVisible": bool(gpu_visible),
        "note": note,
        "torchVersion": torch.__version__,
        "hip": getattr(torch.version, "hip", None),
        "threads": torch.get_num_threads(),
        "budgetGiB": round(budget / 2**30, 1),
        "rows": rows,
    }


def speedups(runs: list[dict]) -> list[dict]:
    """Scenario rate of each non-CPU device over the CPU rate at the same size."""
    base = next((r for r in runs if r["used"] == "cpu"), None)
    if base is None:
        return []
    rates = {row["batch"]: row["scenariosPerSecond"] for row in base["rows"] if not row.get("skipped")}
    out = []
    for run in runs:
        if run["used"] == "cpu":
            continue
        for row in run["rows"]:
            if row.get("skipped"):
                continue
            ref = rates.get(row["batch"])
            if ref and ref > 0:
                out.append({
                    "batch": row["batch"], "device": run["deviceLabel"],
                    "cpuScenariosPerSecond": ref,
                    "deviceScenariosPerSecond": row["scenariosPerSecond"],
                    "speedup": row["scenariosPerSecond"] / ref,
                })
    return out


def print_table(run: dict) -> None:
    print(f"\ndevice {run['deviceLabel']} ({run['used']})  torch {run['torchVersion']}  "
          f"hip {run['hip'] or 'not built with ROCm'}  threads {run['threads']}")
    if run.get("note"):
        print(f"  NOTE: {run['note']}")
    print(f"  {'batch':>10}  {'wall s':>9}  {'scen/s':>12}  {'failed':>7}  "
          f"{'host MiB':>9}  {'device MiB':>11}")
    for r in run["rows"]:
        if r.get("skipped"):
            print(f"  {r['batch']:>10}  {'-':>9}  {'-':>12}  {'-':>7}  {'-':>9}  {'-':>11}"
                  f"   skipped: {r['reason']}")
        else:
            print(f"  {r['batch']:>10}  {r['wallS']:>9.2f}  {r['scenariosPerSecond']:>12.1f}  "
                  f"{r['failed']:>7}  {r['peakHostMiB']:>9.1f}  {r['peakDeviceMiB']:>11.1f}")


def write_outputs(payload: dict, json_path: Path, csv_path: Path) -> None:
    """Write exactly the two artefacts, nothing else."""
    for path in (json_path, csv_path):
        path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(json.dumps(payload, indent=1), encoding="utf-8")

    by_batch = {r["batch"]: r for r in payload["speedup"]}
    lines = ["device,batch,wallS,scenariosPerSecond,failed,meanCostEur,"
             "peakHostMiB,peakDeviceMiB,speedupVsCpu,note"]
    for run in payload["runs"]:
        for r in run["rows"]:
            sp = by_batch.get(r["batch"], {})
            note = r.get("reason") or run.get("note") or ""
            lines.append(
                f"{run['deviceLabel']},{r['batch']},{'' if r.get('skipped') else round(r['wallS'], 4)},"
                f"{'' if r.get('skipped') else round(r['scenariosPerSecond'], 1)},"
                f"{'' if r.get('skipped') else r['failed']},"
                f"{'' if r.get('skipped') else round(r['meanCostEur'], 2)},"
                f"{'' if r.get('skipped') else r['peakHostMiB']},"
                f"{'' if r.get('skipped') else r['peakDeviceMiB']},"
                f"{round(sp['speedup'], 3) if sp else ''},"
                f"{json.dumps(note)}"
            )
    csv_path.write_text("\n".join(lines) + "\n", encoding="utf-8")


GPU_ABSENT = (
    "No AMD Instinct device was visible: torch.cuda.is_available() is false and torch is "
    "not built with ROCm. ONLY THE CPU COLUMN WAS MEASURED - there is no accelerator number "
    "in this run and no speedup claim. The same code runs unmodified on the ROCm wheel: "
    "install a ROCm torch build, ask for --device both, and these kernels dispatch to the "
    "GPU without any change."
)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--batches", default=",".join(str(b) for b in DEFAULT_BATCHES))
    ap.add_argument("--device", default="both", help="both | cpu | cuda | auto")
    ap.add_argument("--repeats", type=int, default=1)
    ap.add_argument("--out", default=str(OUT_JSON))
    ap.add_argument("--csv", default=str(OUT_CSV))
    ap.add_argument("--config", default="OP-TRF-014,night_trainee,tk_after_instrument_work,sparh")
    ap.add_argument(
        "--allow-oversubscribe", action="store_true",
        help="run a batch the memory guard says will not fit, and let the high-water "
             "column show what it cost; off by default, because a swapped run measures "
             "the disk and not the kernel",
    )
    args = ap.parse_args()

    batches = [int(b) for b in args.batches.split(",") if b.strip()]
    procedure, persona, plant, method = (s.strip() for s in args.config.split(","))
    registry = engine.Registry()

    if args.device == "both":
        wanted = ["cpu", "cuda"] if torch.cuda.is_available() else ["cpu"]
    else:
        wanted = [args.device]

    runs = []
    for name in wanted:
        runs.append(sweep(registry, name, batches, args.repeats, procedure, persona, plant,
                          method, allow_oversubscribe=args.allow_oversubscribe))
        print_table(runs[-1])

    payload = {
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "host": {
            "platform": platform.platform(),
            "python": platform.python_version(),
            "processor": platform.processor() or "unknown",
        },
        "config": {"procedure": procedure, "persona": persona, "plant": plant, "method": method},
        "batches": batches,
        "runs": runs,
        "speedup": speedups(runs),
        "gpuPresent": any(r["gpuVisible"] for r in runs),
    }
    if not payload["gpuPresent"]:
        payload["gpuAbsentReason"] = GPU_ABSENT
        print("\n" + GPU_ABSENT)
    else:
        gpu = payload["runs"][-1]
        print(f"\nmeasured on {gpu['deviceLabel']}; "
              f"speedups are against the CPU column at the same batch size.")

    json_path = Path(args.out)
    csv_path = Path(args.csv)
    write_outputs(payload, json_path, csv_path)
    print(f"wrote {json_path}")
    print(f"wrote {csv_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
