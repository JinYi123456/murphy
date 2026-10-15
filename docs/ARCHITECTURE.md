# Architecture

For the person who has to maintain this.

## The rule that everything else follows from

**The TypeScript engine is the reference implementation.** `src/engine/` runs
identically in a browser worker, in a Node route and as the source of truth for
the batched PyTorch service. The GPU is an accelerator: it must reproduce the
fixtures in `data/golden/`, and when it disagrees, that is a bug report, not a
rounding note. Nothing in the product is allowed to depend on a GPU being
present, and nothing is allowed to claim one that is not attached.

## Module map

### `src/engine/` — the model

| File | One line |
| --- | --- |
| `hra.ts` | SPAR-H, THERP and HEART behind one `computeHep` interface, plus detection probability and fail-on-demand rates. |
| `conditions.ts` | The 19 site conditions, their SPAR-H level bindings at severity 1/2/3, and `PSF_REFERENCE` for the UI. |
| `assess.ts` | Fills all eight PSF rows from step, crew and plant, applies conditions, and enforces `MAX_NEGATIVE_PSFS`. |
| `prng.ts` | Philox-4x32-10 over exact 32-bit integer arithmetic; `drawFrac(key, scenario, position, lane)`. |
| `twins/twin.ts` | The `TwinDef` contract: one scalar step function over a flat `Float64Array`. |
| `twins/tank.ts` | Tanker-to-TK-101 transfer: mass balance, dead-heading, vapour space, bund. |
| `twins/furnace.ts` | Reheat furnace light-off: purge, unburnt gas, drive-out, spalling, shell temperature. |
| `twins/furnaceOps.ts` | Reheat furnace on production: six commanded levers, the procedure's rate limits as physics, controller wind-up into the slab, chamber pressure against flame lift-off. |
| `twins/index.ts` | Twin registry — `getTwin(id)` throws on an unknown id. |
| `runner.ts` | `simulateShift`: one shift, step by step, with `slotFor` and `conditionsFor`. |
| `diagnose.ts` | Diagnosis by forward simulation: each error mode run as a single-cause counterfactual, scored against the observed increments, normalised with the priors. |
| `batch.ts` | `runBatch` over n shifts into typed arrays; `evaluateVariant`, the gate a candidate edit must pass. |
| `repair.ts` | The 12-control catalogue, hierarchy-of-controls tiers, and the typed mutations they apply. |
| `model.ts` | `inspectModel`: the integrity gate between a parsed document and a runnable model. |
| `stats.ts` | Paired percentile bootstrap, confidence interval, quantile, CVaR, Benjamini-Hochberg. |
| `economics.ts` | `costOf`: magnitudes to euros, every rate read from `data/costs.json` with its source string. |
| `types.ts` | The data model and the `SEVERITY` map that classes an outcome normal / upset / incident. |
| `index.ts` | Public barrel. No behaviour of its own. |

The engine imports nothing Node-only and nothing DOM-only. That is what lets the
same file run in three places (`next.config.ts` says so explicitly).

### `src/lib/` — the service layer

| File | One line |
| --- | --- |
| `registry.ts` | Loads the shipped procedures, crews and plant states; `buildDraft` applies controls and splices verifications; `buildRunConfig`. |
| `diagnosis.ts` | Turns one recorded shift into a diagnosis case, and looks up the measured benchmark for a procedure and plant state. |
| `dto.ts` | Plain-JSON projections of engine objects, because typed arrays do not cross a wire. |
| `engine.worker.ts` | The worker: receives a request, runs the engine, posts a JSON-safe reply. |
| `engineClient.ts` | Promise wrapper over one shared worker, with an inline fallback when there is no `Worker`. |
| `fuzz.ts` | The layer both browser and routes call: `runFuzzLocal`, `replayLocal`, `runRepairLoop`. |
| `useConsole.ts` | The single client store; every number on screen came from a run that happened. |
| `gpu.ts` | Client for the batched AMD service: `gpuHealth`, `gpuRun`, `gpuBench`. |
| `llm/client.ts` | OpenAI-compatible served-model client, reachability probe, hand-written defensive JSON extraction. |
| `llm/agents.ts` | Four model-backed agents, each with a deterministic fallback and `LlmProvenance` accounting. |
| `evolus/client.ts` | Platform client to the documented contract: multipart execution, polled results, redacted errors. |
| `evolus/workflows.ts` | Three business flows — intake diff, change-order routing, knowledge ask — each with a local path. |
| `evolus/ledger.ts` | In-process ring buffer of calls, credits, timings and platform ids. No payloads. |

### `src/app/api/` — routes, all `runtime = 'nodejs'`

| Route | One line |
| --- | --- |
| `GET /api/health` | Honest self-description: which backends are attached, what the model contains, integrity of each procedure. |
| `POST /api/fuzz` | One batch; AMD service if configured and reachable, otherwise the Node engine, and the answer says which. |
| `POST /api/replay` | Recompute one shift from the seed and its scenario index. Nothing is stored. |
| `POST /api/repair` | The candidate loop as newline-delimited JSON, one event per finished trial. `GET` probes the service. |
| `POST /api/agents/parse` | Compile a controlled document into the model. |
| `POST /api/agents/scenario` | Write one error mode for one step, one crew, one plant state. |
| `POST /api/agents/review` | Adversarial review of findings, given the derivation rows rather than the prose. |
| `POST /api/agents/change-order` | Draft the change order; every figure interpolated from the run record, never typed by a model. |
| `POST /api/evolus/intake` | Document intake passed through to the platform, bytes unmodified. |
| `POST /api/evolus/change-order` | Anonymise, digest, route to the approval workflow. |
| `POST /api/evolus/ask` | Knowledge-library question; `?stream=1` gives SSE. |
| `GET /api/evolus/status` | Presence of each variable and the ledger's identifiers. Makes no platform call. |

### `src/components/`

| File | One line |
| --- | --- |
| `Shell.tsx` | Instrument face: the configuration under test, backend chips, the six views, the standing limitations note. |
| `LineMap.tsx` | The procedure on its own time axis, error terrain above it, catch and escape rings, response-budget bars. |
| `PressureTest.tsx` | Batch and seed-sweep runs, progress, incident versus upset split. |
| `BlackBox.tsx` | Replay of one recorded shift: plant on the left, paperwork on the right, one shared clock. |
| `CauseFinder.tsx` | An instrument window in, a ranked set of causes out, with the visibility question answered first and the recording's answer revealed underneath. |
| `ChangeLab.tsx` | Stack candidate controls, stream the loop, produce the change order. |
| `Evidence.tsx` | Provenance panel: which machine answered, which agent wrote what, what the platform charged. |
| `StepInspector.tsx` | The full derivation worksheet for one step, including suppressed factors. |

### `services/gpu/` — the optional accelerator

| File | One line |
| --- | --- |
| `murphy_gpu/philox.py` | The same stream as `prng.ts`, as int64 tensor operations. |
| `murphy_gpu/tank.py` | The transfer twin, ported line for line. |
| `murphy_gpu/hra.py` | The same published tables, tensorised. |
| `murphy_gpu/economics.py` | The same cost layer over the same `data/costs.json`. |
| `murphy_gpu/kernel.py` | A whole batch advancing together; per-scenario decisions are masks, never loops. |
| `murphy_gpu/engine.py` | Configuration registry and batch runner, mirroring `src/engine/batch.ts` field for field. |
| `murphy_gpu/api.py` | Stateless FastAPI service — `/health`, `/run`, `/bench`, `/equivalence`, `/configurations` — served with uvicorn. |
| `verify_golden.py` | The gate: philox exact, tank state to 1e-9 relative, HEP to 1e-12, outcome class match at 99.5%. |
| `bench.py` | Throughput of CPU against the AMD device, written to `data/bench/`. |
| `tools/` | Reference-audit and kernel-inspection helpers used while porting. |

The service implements the transfer twin only. A twin that has not been ported
still runs at full fidelity on the reference engine — slower, and labelled as
such. `GET /equivalence` re-runs the fixture gates inside the service, so the web
app can ask whether the accelerator currently agrees with the engine.

## Data flow

```
controlled document            data/sop/OP-TRF-014.md
  -> compile                    POST /api/agents/parse  (model, or offlineParse with no model)
  -> integrity gate             inspectModel() in src/engine/model.ts
  -> procedure model            data/procedures/OP-TRF-014.json  (17 typed steps)
  -> run configuration          buildRunConfig(): procedure + persona + plant state + method + seed
  -> batch                      runBatch(): n shifts, one scenario index per shift, typed arrays out
  -> economics                  costOf(): magnitudes to euros, escalation kept separate
  -> statistics                 pairedBootstrap() against the baseline batch on the same indices
  -> verdict                    evaluateVariant(): one-sided risk, cost gate, Benjamini-Hochberg
  -> change order               draftChangeOrder(): figures interpolated, prose drafted, then /api/evolus/change-order
  -> signature                  a competent person. The model stops here and says so.
```

Candidate controls never bypass the gate: `applyIntervention` returns a typed
variant of the procedure, `materialiseVerifications` splices the inserted check
steps into it, and only then does another batch run against it.

## Three execution paths

| Path | Engine | Provenance label |
| --- | --- | --- |
| Browser worker | `engine.worker.ts` runs `runBatch` off the main thread | `source: 'browser'` |
| Node API route | `/api/fuzz` and `/api/repair` call the same `runBatch` in the request | `source: 'node'` |
| AMD batched service | `gpuRun` posts the compiled procedure and the run config to `AMD_GPU_URL` | `source: 'amd'`, plus `device` |

`/api/fuzz` prefers the service when it is configured and falls back to Node when
it errors, returning `amdError` alongside the result so the interface can say
what happened. The worker path is chosen by `engineClient.batch()`; with no
`Worker` available it inlines the same engine call.

## Determinism contract

1. All randomness comes from `prng.ts`: a seed string, a scenario index, a stream position and a lane. No framework RNG is used anywhere.
2. A step id hashes to a stable slot (`slotFor`), so its draws survive edits to other steps.
3. `simulateShift(cfg, scn)` is a pure function of `(cfg, scn)`. It returns the same trajectory in a batch of one and a batch of a million, which `tests/simulation.test.ts` asserts.
4. Physics uses only `+ - * /`, comparisons and clamping. No transcendental call appears in a state update, so doubles agree bit for bit across CPU, browser and GPU.
5. Bootstrap resampling is driven by its own deterministic integer hash with a fixed seed, so confidence intervals reproduce.
6. Only the worst shifts are re-simulated with a full record. The replay view recomputes rather than reads a stored tape, which makes the contract self-testing every time somebody opens it.

Fixtures: `npm run golden` writes `data/golden/{philox,tank_steps,hep,shifts}.json`;
`python services/gpu/verify_golden.py` holds the accelerator to them.

## Worker protocol

`src/lib/engine.worker.ts` exchanges plain, JSON-safe messages. Requests carry a
monotonic `id` from `engineClient.ts`:

| Request | Reply |
| --- | --- |
| `batch { id, run, n, variantId, collectWorst }` | `progress { id, done, total }` many times, then `batch { id, summary, traced, ms }` |
| `replay { id, run, scn }` | `replay { id, shift }` |
| `sweep { id, run, n, seeds }` | `sweep { id, rows[] }` — same model, different random streams |
| any throw inside the handler | `error { id, message }`, which the client rejects on |

Typed arrays never leave the worker: `dto.ts` strips them first. Progress is
emitted every 20 shifts so the interface animates while the kernel runs.

## Provenance

Three separate claims, three separate records.

- **Which machine computed it.** `RunEnvelope.source` is `'browser'`, `'node'` or `'amd'`, set by the code that ran, with `device` and `ms`. The header chip and the Evidence panel read this field; there is no path in which the UI shows a GPU it does not have.
- **Who wrote the prose.** Every agent returns `llm: LlmProvenance`. `used` is an authorship claim, not a traffic claim: if a served model answered but its output was rejected, `Accounting.decline()` reports `used: false` with the reason, alongside the rule that ran instead. Token counts come from the server's `usage` or are zero, never estimated.
- **What the platform did.** `evolus/ledger.ts` records block, endpoint path, timing, status, credits and the platform's own identifiers — execution, job, trace, audit, conversation. Payloads are not recorded. `GET /api/evolus/status` hands the identifiers out so a claim can be checked by somebody else. The ledger is in-process and ring-buffered; a restart clears it, and the status route says so rather than hiding it.

## Environment variables

Read server-side, on every call, never at import. `.env.example` is the full list.

| Variable | Purpose |
| --- | --- |
| `AMD_VLLM_BASE_URL` | OpenAI-compatible inference service you host; unset means agents run their deterministic path |
| `AMD_VLLM_MODEL` | Served model name; with the base URL it enables the four agents |
| `AMD_VLLM_API_KEY` | Bearer token for that service |
| `AMD_VLLM_MAX_TOKENS` | Generation cap, default 900 |
| `AMD_VLLM_TIMEOUT_MS` | Per-attempt budget, default 45000; one retry on transport or 5xx, none on 4xx |
| `AMD_VLLM_JSON_MODE` | Set to `1` only when your stack implements `response_format: json_object` |
| `AMD_GPU_URL` | Batched PyTorch engine; unset means the Node engine answers |
| `EVOLUS_API_KEY` | Platform key, sent as `X-ApiKey` |
| `EVOLUS_USER_API_KEY` | Alternative key, sent as `X-User-ApiKey`, preferred when both are present |
| `EVOLUS_APP_ID` | Space id, sent as `X-Application-Id`, used to form `<applicationId>:<agentId>` |
| `EVOLUS_WORKFLOW_CHANGE_ORDER` | Workflow that approves a change order; a switched-off workflow returns 409 |
| `EVOLUS_AGENT_ID` | Agent for knowledge chat and file extraction |
| `EVOLUS_EXTRACTOR_ID` | Document extractor for intake; unset falls back to the `doc-structure` tool |
| `EVOLUS_MEMORY_LIBRARY_ID` | Incident and SOP library |
| `EVOLUS_CALLBACK_BASE_URL` | Optional completion callback instead of polling |
| `EVOLUS_POLL_MS`, `EVOLUS_POLL_TIMEOUT_MS`, `EVOLUS_TIMEOUT_MS` | Poll interval, execution budget, per-call timeout |

Presence is reported by name in `/api/health` and `/api/evolus/status`. Values
never leave the server.

## Adding a third process twin

Four things, in this order.

**1. Write the twin.** Create `src/engine/twins/polymer.ts` and implement
`TwinDef`. `vars` is the continuous state and `discs` the per-scenario flags and
parameters; their index order is the wire format for both engines, so append
rather than reorder. Implement `init`, `advance`, `indication`, `magnitudes`,
`classify`, `hazardNote`, `varIndex`, `discIndex`, plus `iface` (which key is
`progress`, `target`, `rate`, `runFlag`, `stopFlag`, `alarm`, `hazard`, `clock`)
and the `display` units. State updates must use only `+ - * /`, comparisons and
clamping. Set `tickS` if the asset is slow — a furnace cures for hours and a
transfer breathes in seconds, and the run-out loop is sized from `target`, `rate`
and `tickS`, not from a constant.

**2. Name it.** Add it to `REGISTRY` in `src/engine/twins/index.ts`. `getTwin`
throws on an unknown id, so this is also the step that makes a typo fail loudly.

**3. Add a procedure.** Write `data/procedures/<ID>.json` with `"twin":
"polymer_transfer"`, add it to `PROCEDURES` in `src/lib/registry.ts`, and add at
least one plant state to `data/plants.json` with the matching `twin`. If the
consequences are not already priced, extend `costOf` in `src/engine/economics.ts`
and add rates with source strings to `data/costs.json`. Keep the source document
in `data/sop/`.

**4. Prove it.** Add the twin to `tests/simulation.test.ts` the way the tank and
furnace blocks are written, run `npm run golden` to extend the fixtures, and port
it to `services/gpu/murphy_gpu/` only if you want accelerator throughput.

**Why `inspectModel` rejects a procedure that names a variable your twin does not
have.** A parsed procedure is a hypothesis about a plant, and it usually arrives
from something that cannot be trusted to read carefully: an OCR pass, a served
model, a tired engineer. A patch key such as `REFLUX_COOL: 1` that is neither a
`disc` nor a `var` on the named twin would be accepted silently, applied to
nothing, and the simulator would report a clean shift. The finding would be a
fiction wearing the numbers of a measurement. So the gate checks every `applies`
key, every error `patch` key, every `watch.onHit` key, every watch criterion and
process limit, plus step-id uniqueness, verification references that point backwards,
known action kinds, cues, conditions and error weights. `loadProcedure` refuses
to return anything that fails, and `compileProcedure` drops unknown keys and
reports them rather than guessing. That is the same rule the agents obey when
they parse a real document: unknown tags are removed and listed, never invented
into existence.
