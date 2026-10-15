# murphy_gpu — batched PyTorch engine

A re-implementation of the simulation kernel in `src/engine` as tensor programs,
so that a hundred thousand shifts can be sampled in one pass instead of one loop
per shift. It is an independent implementation of the same model: the TypeScript
is the reference, and the numbers it produces into `data/golden` are the contract
this engine has to reproduce. It is not a transpiler's output and it does not
share a line of code with the reference.

What it does: a shift of a work procedure is a sequence of human actions, each
with a modelled error probability, over a process twin that integrates the plant
state in continuous time. A batch runs `B` scenarios side by side; every
per-scenario decision (does this step go wrong, which failure mode, did a later
check catch it, when did the operator act) is a mask, not a branch. Scenario `i`
draws its random numbers from addresses `(i, slot, lane)` rather than from a
cursor, so it gets the same draws whether it runs alone or inside a million —
which is what makes a before/after comparison of a procedure edit a paired test,
and what lets the replay view reproduce exactly the failure a user clicked on.

## Layout

| file | role |
| --- | --- |
| `murphy_gpu/philox.py` | the counter-based RNG: seed to key, one u32 word per `(scenario, position, lane)` |
| `murphy_gpu/tank.py` | the tanker-to-TK-101 transfer twin: state, scenario vector, integration, magnitudes, outcome classes |
| `murphy_gpu/hra.py` | the HRA worksheet: conditions, the SPAR-H PSF table, THERP Table G-1 base rates, HEART generic task types and EPCs, detection probability |
| `murphy_gpu/kernel.py` | the shift itself: step loop, watch windows, run-out, emergency response |
| `murphy_gpu/economics.py` | the money: terminal costs, fines, expected escalated loss |
| `murphy_gpu/engine.py` | the `BatchSummary` / `ShiftDto` field names the web console already consumes |
| `murphy_gpu/api.py` | FastAPI service: `/health` `/run` `/bench` `/equivalence` `/configurations` |
| `verify_golden.py` | the gate against `data/golden` and against the live reference engine |
| `bench.py` | throughput, CPU against AMD Instinct |
| `tools/` | diagnostics: per-step traces, the reference replay dumper |

## Commands

```bash
cd services/gpu
python -m venv .venv && ./.venv/Scripts/python.exe -m pip install -r requirements.txt   # Windows
./.venv/Scripts/python.exe verify_golden.py
./.venv/Scripts/python.exe bench.py --batches 1000,10000,100000
./.venv/Scripts/python.exe -m uvicorn murphy_gpu.api:app --host 0.0.0.0 --port 8000
```

On Linux the same three commands with `python3` and `bin/activate`. Nothing here
needs a GPU to run: the kernels are ordinary float64 tensor arithmetic, and CPU
and GPU take the same route through them.

## Verification

`verify_golden.py` gates five things, all of them measured rather than asserted,
and prints the worst error it saw. It also replays every configuration in
`data/golden/shifts.json` against the **live** reference engine, so a disagreement
can be attributed instead of guessed at:

```bash
npx tsx services/gpu/tools/reference_replay.ts   # writes data/bench/reference_replay.json
./.venv/Scripts/python.exe verify_golden.py
```

The three columns of that table mean different things:

- **fixture gates** — kernel against `data/golden`. This is the contract.
- **reference engine gates** — kernel against `src/engine` as it is right now.
  The expected answer is bit-exact, because both engines are the same double
  precision arithmetic in the same order; anything above a rounding tolerance is
  a real difference.
- **the staleness row** — `data/golden` against the live reference. The golden
  files are a snapshot taken when someone runs `scripts/golden.ts`, and the
  procedure, persona and plant JSON keep being edited afterwards. When the last
  two rows agree with each other but not with the snapshot, the snapshot is what
  is out of date, and the fix is to regenerate it (`npx tsx scripts/golden.ts`,
  from the repository root) — not to bend the kernel to an old configuration.
  That happened to the `tk_uprated` plant during development: the fixture was
  generated before `data/plants.json` changed, the two engines disagreed with it
  identically, and reproducing the fixture needed only the pre-edit freeboard.

The paired property is checked too: two identical batch-1000 runs agree on every
field, `batch=1` scenario 0 equals `batch=1000` scenario 0, and `batch=250` is a
prefix of `batch=1000`. A kernel that got a shared cursor anywhere would fail
those rather than the fixture.

## HTTP contract

`POST /run` takes the compiled procedure inline — a variant that exists only in
one console session still has to be fuzzed on the accelerator — and answers with
the field names `src/lib/dto.ts` declares:

```jsonc
// request
{ "variant_id": "OP-TRF-014@7", "procedure": { ...steps... }, "persona": { ...traits... },
  "plant": { ...protection... }, "method": "sparh", "seed": "G-...", "n": 1000, "collect_worst": 12 }
// response
{ "summary": { "failureRate", "incidentRate", "upsetRate", "meanCostEur", "costCi",
               "p95CostEur", "cvarCostEur", "perStep": { "thrown", "caught", "escaped",
               "causal", "causalFailure", "p", "reached", "title", "escapeShare" },
               "annualLossEur", "shiftsPerSecond", "wallMs", "worst", ... },
  "traced": [ ...ShiftDto, one per scenario in summary.worst... ],
  "device": "AMD Instinct MI300X" | "cpu (10 threads)" }
```

`GET /health` answers `device`, `torch` and `hip`, which is what the console's
`gpuHealth()` shows on the evidence sheet. `device` names the machine that
actually answered, so a process without a visible accelerator says
`cpu (n threads)` rather than letting the caller fall back to a flattering label.

## Running it on AMD Developer Cloud

1. Create an **Instinct MI300X** instance (droplet) in the AMD Developer Cloud
   and wait for it to boot with the ROCm driver stack already installed.
2. `ssh <user>@<instance-ip>`
3. Build the image (copy or clone the repository so `data/` sits beside
   `services/gpu/`, then from the repository root):
   `docker build -f services/gpu/Dockerfile -t murphy-gpu .`
4. Run it with the devices exposed — without these flags torch sees no GPU and
   the service will honestly report itself as CPU-only:
   ```bash
   docker run -d --name murphy-gpu \
     --device /dev/kfd --device /dev/dri --ipc=host --group-add video \
     --cap-add SYS_PTRACE --security-opt seccomp=unconfined \
     -p 8000:8000 murphy-gpu
   ```
5. Open port 8000 in the instance firewall / security group.
6. Point the application at it — in the app's `.env`:
   `AMD_GPU_URL=http://<instance-ip>:8000`, restart the app.
   The console then shows the batch as having run on the AMD engine, with the
   device name and the throughput the service measured.

## Checking the GPU is really being used

```bash
rocminfo | grep -m3 "Marketing Name"          # the driver sees the part
amd-smi static --json | head -40              # clocks, memory, busy state
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
curl -s localhost:8000/health | python -m json.tool | head -20   # "device": "AMD Instinct MI300X"
curl -s -X POST localhost:8000/run -H 'content-type: application/json' \
  -d '{"procedure":"OP-TRF-014","persona":"night_trainee","plant":"tk_after_instrument_work","method":"sparh","seed":"smoke","n":100000,"device":"cuda"}' \
  | python -c "import json,sys; s=json.load(sys.stdin); print(s['device'], s['summary']['shiftsPerSecond'], 'scen/s')"
watch -n1 amd-smi metric --process            # a running batch shows up as a process
```

`torch.cuda.is_available()` returning true **is** the AMD check: on a ROCm build
of torch the HIP backend is spelled `cuda`. If `/health` says `cpu`, the device
nodes were not passed to the container, and any throughput number from that
process is a CPU number.

## What is ported, and what is not

Ported, and gated against the fixtures:

- the Philox 4x32 counter RNG, the seed-to-key derivation, and the stream-slot
  addressing (stable slot per step id, lanes for each kind of draw);
- the **tank transfer twin** — mass balance, pump hydraulics, line stress and
  burst, vapour-space pressure and roof failure, overflow, secondary containment
  with limited bund headroom, the high-level alarm latch and the independent
  high-high function on demand, one-shot field-action releases, outcome
  classification and magnitudes;
- the HRA layer: the three published methods the reference implements - SPAR-H
  (NUREG/CR-6883) with its graded PSFs, adjustment factor and floor, THERP
  (NUREG/CR-1278 Appendix G Table G-1) base rates by error type, and HEART
  (HSE RR679) generic task types with EPC scaling - plus task classification,
  detection probability and the protection on-demand failure rates;
- the shift kernel: guard and deadline conditions, error surfaces and weighted
  alternative selection, verify-and-recover with the configuration it restores,
  watch windows with cue-and-reaction lateness, schedule-drift accounting, the
  hazard-time break, the run-out of whatever is still running, and the emergency
  response roll;
- the economics: terminal costs, fines, aborted-batch and lost-volume terms, and
  expected escalated loss.

**Not ported:** the **furnace light-off twin** (`src/engine/twins/furnace.ts`) —
its procedures (`OP-HT-006`, `OP-HT-021`) are rejected by `/run` with an explicit
error rather than silently approximated. Also not ported: the paired-bootstrap
variant acceptance test in `batch.ts` (the service returns the summary, the
browser still differences two runs itself), the per-tick process series and the
per-step PSF worksheet inside a traced replay (`traced[].series` and
`traced[].audit` come back empty; the event tape is complete), and the confidence
interval's exact resample order, which uses its own seeded stream instead of the
simulation's.
