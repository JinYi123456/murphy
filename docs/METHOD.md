# Method

What a probability in this repository means, and where it came from.

## The object of study

A controlled procedure is normally read as a text: numbered instructions, a
signature block, a revision number. MURPHY reads it as an executable artifact.
Each step carries an action kind (`actuate`, `verify`, `communicate`,
`authorise`, `monitor`, `recover`), the cue the operator relies on (`label`,
`gauge`, `light`, `checklist`, `memory`, `physical`, `verbal`, `document`), a
nominal duration, and the plant variables the step is supposed to change. The
document `data/sop/OP-TRF-014.md` compiles to `data/procedures/OP-TRF-014.json`,
and the simulator runs that. Nothing is hand-written about the plant that is not
traceable to a line of the document — including the wording that produced a
finding: the note on step 8 in the model is quoted from the step itself.

## A step is a typed error surface

Every step declares the ways it can go wrong. Each alternative has an error kind,
a relative weight, a sentence describing how a real crew makes that mistake on
that site, and a `patch`: the plant variables the mistake forces.

The patch is the load-bearing part. "Operator error" is not a mechanism; it is a
verdict. An error only becomes testable when it is an executable state of the
plant. `d4e1` opens the draw-off valve instead of the inlet, so the model sets
`V2 = 1` and the transfer quietly starts feeding the manifold. `d6e1` leaves the
cross-connect two turns off its seat, so `V3LEAK = 1` and the tank keeps
receiving after the pump is stopped. The same wording that a reviewer would skip
over becomes a trajectory you can replay and price. Before anything enters the
simulator, `inspectModel` checks every patch key against the twin it claims to
operate. A name the twin does not have is an error, not a warning.

## Three reliability methods, one interface

`computeHep` takes a method name and returns the same structure for all three.
The ranking of failure modes has to survive a change of method before it is
called a finding, and the interface says which method produced what you are
looking at.

| Method | Primary source | What is published | What is our judgement |
| --- | --- | --- | --- |
| SPAR-H | NUREG/CR-6883 | Nominal HEP 1.0E-03 action, 1.0E-02 diagnosis; floor 1.0E-05; eight PSFs with graded multipliers; multiplication rule; adjustment factor at three or more negative PSFs | Which published level a named site condition sits at |
| THERP | NUREG/CR-1278, Appendix G Table G-1 | Base rates keyed by error type — wrong key-protected switch 1E-04, dissimilar switch 1E-03, misreading a label 3E-03, omission inside a procedure 3E-03, walk-around check 5E-01, first 60 s of extreme stress 1.0; general first estimate 0.003 | Which row an action kind selects |
| HEART | HSE RR679, generic task types | GEPs from 0.00002 (act correctly on a system demand) to 0.55 (unfamiliar task at speed); HEP = GEP x product of EPC factors, capped at 1.0 | The APOA assumed for each condition |

THERP is keyed by error *type*, which is exactly how a step's error surface is
written, so the base rate does not have to be invented. HEART's error-producing
condition maximum factors are taken from the published 1.2–30 band in the NARA
methodology annex of IAEA PUB2102; the choice of a factor inside that band is an
analyst decision and is reported as one.

## Multiplication, the adjustment factor, and the cap

SPAR-H multiplies the nominal rate by the product C of the shaping factors that
were actually applied. Eight graded multipliers can produce an absurd number, so
when three or more factors are negative the product is run through the published
saturating transform instead:

```
HEP = NHEP x C / (1 + NHEP x (C - 1))
```

That is why a badly shaped step lands near 0.8 rather than at 40. SPAR-H also
refuses to report a human action below 1.0E-05, and a level that makes an action
unachievable — inadequate time, unfit for duty — is scored as a failure rather
than as a large multiplier.

**Not used, deliberately.** The widely reprinted THERP action-class ladder
(Ps = 0.9999 / 0.999 / 0.995) and PSF multipliers quoted as x10, x20 and x100
appear in a great many secondary papers. They do not appear in the primary
documents. They are not load-bearing here.

## At most three negative factors

A real SPAR-H assessment scores all eight factors for every action, and this
model starts from a baseline derived from the step, the crew and the plant. For a
trained operator working from a clear written procedure with a readable gauge,
that baseline is genuinely better than nominal — which is why the same procedure
is safe in one pair of hands and not in another.

Then the constraint. PSF-based methods are not independent. "Fatigued", "rushed"
and "poor procedure" are frequently three descriptions of one Tuesday night.
NUREG-1842 and the IAEA methodology annex both list this double-counting as the
standing criticism of the method. So at most three negative factors may act on a
single step: the three strongest. The rest are held at nominal and recorded as
suppressed, on screen, where somebody who disagrees can change the call. Hiding a
judgement is worse than showing it.

## Every figure carries a band

The source guidance says these numbers are screening values. Each result returns
`p` with a `lo` and `hi` around it: THERP's own conservative factor of ten, a
third of the value for SPAR-H, a fifth for HEART. A modelled 0.4% and a modelled
1.2% are the same quantity. Statements of the form "this edit halves the risk"
are not supported by this arithmetic and are not made.

## Two process twins

Both twins are one scalar step function over a flat `Float64Array`, written in
equations-in-words.

**Tanker to TK-101 transfer.** Mass balance sets the level: pump flow in through
the inlet, draw-off out, minus a cross-connect that is off its seat and still
feeding the tank from the header. Pump discharge pressure seeks the running
pressure when the line is open and the dead-head pressure when it is not. Time
above the sustained rating accumulates until the line fails and releases. With
the vent shut, incoming volume compresses the vapour space; above the roof seam
rating the tank loses containment. Every release first fills the bund; whatever
exceeds the remaining bund headroom escapes to drainage. Protection follows the
API RP 2350 pattern: soft alarm, independent high-high function, containment.

**Reheat furnace light-off.** Purge effectiveness is the clean-air flow time
against the required duration. Unburnt gas accumulates when the main valve feeds
a chamber with no flame or no air, and is removed only by the fan. An ignition
source meeting that inventory is a deflagration. Moisture drives out of the
lining as a function of temperature; ramping above the wet limit while water
remains spalls the lining, and the shell temperature — the visible sign, and the
one a person can actually see — follows insulation loss with a long lag.

The physics contains no randomness and no transcendental calls. Only `+ - * /`,
comparisons and clamping appear in the state update, so IEEE-754 doubles give
identical trajectories in a browser, on a CPU and on a GPU. The PyTorch engine
mirrors these files and is gated against the same fixtures. Uncertainty lives in
human action, equipment configuration and instrument health, sampled at discrete
decision points. That is cheaper, and it is a truer statement of where procedural
risk comes from than a stochastic differential equation.

## Common random numbers

Each step id hashes to a stable slot in the random stream. A step keeps its draws
across procedure revisions, so inserting or deleting one step cannot reshuffle the
others. Scenario index `i` therefore sees the same crew, the same equipment state
and the same coin tosses in the baseline and in the candidate. The variance of the
difference is far smaller than the variance of either arm, which is what makes a
one-percentage-point improvement measurable at a batch size a laptop can run. It
is also why a shift you click on in the replay view is recomputed, not stored, and
comes back identical.

## Incident is not upset

A shift is classified `normal`, `upset` or `incident` before anyone spends money
on it.

| Class | Examples | Meaning |
| --- | --- | --- |
| normal | `normal` | The batch completed and nothing was released |
| upset | `no_flow`, `short_batch`, `trip_stop`, `no_light_off` | The job did not finish; the barriers held |
| incident | `minor_release`, `overfill`, `containment_escape`, `line_failure`, `tank_breach`, `misrouting`, `deflagration`, `refractory_damage`, `shell_hotspot`, `hot_start` | Something left containment or the asset was damaged |

An aborted batch and a loss of containment are not the same event. They go to
different people on different sheets, so they are counted and reported separately.

## How a candidate control is gated

A fix is a typed mutation of the model, not a paragraph of advice, and each one
is labelled with its tier in the hierarchy of controls. The catalogue runs from
rewriting a step and tagging a valve through keying the device, fitting an
independent automatic stop, capping the starting level, and taking the schedule
pressure off the task. A candidate passes only when all of these hold:

1. the paired bootstrap says the failure rate fell, with one-sided risk below 2.5%;
2. the expected loss fell too;
3. the net annual gain exceeds the control's own annualised cost;
4. it survives Benjamini-Hochberg correction across the whole candidate set — testing twelve ideas and keeping the best is how you manufacture a result that does not exist;
5. the accepted survivors are then stacked into one revised procedure and re-tested, because controls interact and a loop that ignores that sells a saving twice.

Rejections are shown with their reasons. "We could not show it" and "it made
something else worse" are different conversations with an operations manager.

## The response budget

The twin reports the arithmetic that a procedure quietly depends on:

```
seconds the tank gives between the alarm and the independent trip
    = (hAh - hAl) x area / (qPump / 3600)
seconds a person needs
    = walk to the pump + close the valve and stop it
```

With the shipped parameters the first is about 124 s and the second 75 s, with a
further 165 s between the trip and the overflow. Those are model parameters, not
measurements. The finding is the comparison: a procedure whose safety rests on a
human action inside that window fails when the freeboard is shortened, the crew
is new, or the batch is late — and the `automate_stop` control removes the human
from the gap instead of asking them to be quicker.

## Backtest

`npx tsx scripts/backtest.ts` re-ranks against published investigations. Each
case gives the model a procedure and a plant state and nothing else.

| Case | Plant state | Published causes | Recovered in top 10 |
| --- | --- | --- | --- |
| BUN-TANK | `tk_buncefield_shape` | 5 | 4 |
| CLC-GAS | `fn_after_lining_repair` | 4 | 2 |
| DKN-WORD | `fn_cold_restart` | 4 | 1 |
| **Total** | 3 cases | **13** | **7 (54%)** |

Across all three, 11 of 13 (85%) landed inside the top 20, 0 were never raised,
and the model ranked about 60 candidate mechanisms per case. A random top 10
catches about 17%.

**What this does not prove.** It does not predict an accident. Three published
reports is a small sample with a strong survivorship bias: the events that were
investigated, not the procedures that were merely bad. The mapping from a finding
to a model element was written by us, in advance, in
`data/incidents/cases.json`, so it can be argued with — but it is still our
reading of their report. Two causes rank below the top ten, which is the honest
result. What the curve does show is that the mechanism an investigation later
confirmed can be raised from the procedure text alone, before the event, and
ordered by what it is actually worth.
