# Method

Where every probability in this repository comes from, and what it does not mean.

## The object of study

A controlled procedure is normally read as a text: instructions, a signature block, a
revision number. MURPHY reads it as an executable artifact. Each step carries an action
kind (`actuate`, `verify`, `communicate`, `authorise`, `monitor`, `recover`), the cue
the operator relies on (`label`, `gauge`, `light`, `checklist`, `memory`, `physical`,
`verbal`, `document`), a duration, and the plant variables it changes. The markdown
document in `data/sop/` compiles to the model in `data/procedures/`, and the simulator
runs that. Findings rest on the wording itself, including "if in doubt" in step 8.

## A step is a typed error surface

Every step declares how it goes wrong. Each alternative carries an error kind, a weight,
a sentence about how a real crew makes that mistake here, and a `patch`: the plant
variables the mistake forces.

The patch is the load-bearing part. "Operator error" is a verdict, not a mechanism. An
error is testable only once it is a state of the plant. `d4e1` opens the draw-off
instead of the inlet, so the transfer feeds the manifold. `d6e1` leaves the cross-connect
two turns off its seat, so the tank keeps receiving after the pump stops. `inspectModel`
checks every patch key against the twin the step claims to operate. An unknown name is an
error, never a warning.

## Three reliability methods, one interface

`computeHep` takes a method name and returns the same shape for all three. A ranking
must survive a change of method before it is called a finding.

| Method | Primary source | What is published | What is our judgement |
| --- | --- | --- | --- |
| SPAR-H | NUREG/CR-6883 | Nominal HEP 1.0E-03 action, 1.0E-02 diagnosis; floor 1.0E-05; eight PSFs with graded multipliers; multiplication rule; adjustment factor at three or more negative PSFs | Which published level a site condition sits at |
| THERP | NUREG/CR-1278, Appendix G Table G-1 | Base rates keyed by error type: wrong key-protected switch 1E-04, dissimilar switch 1E-03, misreading a label 3E-03, omission inside a procedure 3E-03, walk-around check 5E-01, first 60 s of extreme stress 1.0, general first estimate 0.003 | Which row an action kind selects |
| HEART | HSE RR679, with the NARA annex of IAEA PUB2102 | Generic task types with GEPs from 0.00002 to 0.55; HEP = GEP x product of condition factors, capped at 1.0; maximum factors in the 1.2-30 band | The factor chosen inside that band, and each APOA |

THERP is keyed by error *type*, which is how a step's error surface is written, so no
base rate has to be invented. HEART's factors stay inside the published 1.2-30 band;
the choice within it is analyst work and is shown as such.

## Multiplication, and the adjustment that tames it

SPAR-H multiplies the nominal rate by the product C of the factors applied. Eight
graded multipliers produce absurd numbers, so when three or more are negative the
published saturating transform replaces the product:

```
HEP = NHEP x C / (1 + NHEP x (C - 1))
```

A badly shaped step then lands near 0.8, not at 40. SPAR-H also refuses an action below
1.0E-05, and scores a level that makes the action unachievable — inadequate time, unfit
for duty — as a failure rather than a large multiplier.

**Not used, deliberately.** The reprinted THERP action-class ladder (Ps 0.9999, 0.999,
0.995) and PSF multipliers quoted as x10, x20 and x100 are common in secondary
literature. They are not in the primary documents, so they are not load-bearing here.

## At most three negative factors

A real SPAR-H worksheet scores all eight factors for every action, so this model begins
from a baseline built from the step, the crew and the plant. For a trained operator with
a clear document and a readable gauge, that baseline is genuinely better than nominal.
It is why one procedure is safe in one pair of hands and not in another.

Then the constraint. PSFs are not independent. Fatigued, rushed and poor procedure are
often one situation described three times, and multiplying all three re-counts the same
cause. NUREG-1842 and the IAEA annex both list that double-counting as the standing
criticism of these methods. So at most three negative factors act on a step: the
strongest three. The rest are held at nominal and listed as suppressed, on screen, where
an engineer can overrule the call.

## Every figure carries a band

These are screening values, as the source documents say. Each result returns `lo` and
`hi` around `p`: THERP's own conservative factor of ten, a third for SPAR-H, a fifth for
HEART. A modelled 0.4% and a modelled 1.2% are the same quantity, and no sharper claim is
made anywhere in this tool.

## Two process twins

Both are one scalar step function over a flat `Float64Array`, written as
equations-in-words.

**Tanker to TK-101.** Mass balance sets the level: pump flow in through the inlet,
draw-off out, plus a cross-connect off its seat still feeding the tank from the header.
Discharge pressure seeks the running value with the line open and the dead-head value
with it shut, and time above the sustained rating fails the line. With the vent shut,
incoming volume compresses the vapour space until the roof seam gives. Every release
fills the bund first; whatever exceeds the remaining headroom escapes. Protection
follows the API RP 2350 pattern: transfer control, high-level alarm, an independent
high-high function, containment.

**Reheat furnace light-off.** Purge effectiveness is clean-air flow time against the
required duration. Unburnt gas accumulates when the main valve feeds a chamber with no
flame or no air; only the fan clears it, and an ignition source meeting that inventory
deflagrates. Water drives out as temperature rises. Ramping above the wet limit spalls
the lining, and shell temperature — the visible sign, the one a person can read —
follows insulation loss through a long lag.

The physics contains no randomness and makes no transcendental calls. Only `+ - * /`,
comparisons and clamping appear in a state update, so IEEE-754 doubles give identical
trajectories in a browser, on a CPU and on a GPU. The PyTorch engine mirrors these files
and is gated on the same fixtures. Uncertainty lives in human action, equipment
configuration and instrument health, sampled at decision points. That is cheaper, and it
is where procedural risk actually comes from.

## Common random numbers

Each step id hashes to a stable slot in the stream, so a step keeps its draws across
revisions and an inserted step cannot reshuffle the others. Scenario `i` sees the same
crew, the same equipment and the same tosses in both arms. The variance of the difference
is far smaller than that of either arm, which is what makes a one-point improvement
measurable at a batch a laptop runs. It is also why the replay view recomputes a shift
instead of storing one.

## Incident is not upset

| Class | Outcomes | Meaning |
| --- | --- | --- |
| normal | `normal`, `intercepted` | The batch completed and nothing was released |
| upset | `no_flow`, `short_batch`, `trip_stop`, `no_light_off` | The job did not finish; every barrier held |
| incident | `minor_release`, `overfill`, `containment_escape`, `line_failure`, `tank_breach`, `misrouting`, `deflagration`, `refractory_damage`, `shell_hotspot`, `hot_start` | Something left containment, or the asset was damaged |

An aborted batch and a loss of containment are not the same event. A plant reports them
to different people on different sheets, so they are counted separately and never
blended into one failure percentage.

## How a candidate control is gated

A fix is a typed mutation of the model, not a paragraph of advice, and each one names
its tier in the hierarchy of controls. A candidate passes only when all of these hold:

1. the paired bootstrap says the failure rate fell, with one-sided risk below 2.5%;
2. expected loss fell as well;
3. the net annual gain exceeds the control's own annualised cost;
4. it survives Benjamini-Hochberg correction across the whole candidate set, because twelve attempts will surface one winner by luck;
5. the survivors are stacked into one revised procedure and re-tested together, since controls interact and a loop that ignores that sells a saving twice.

Rejections keep their reasons on screen. "We could not show it" and "it made something
else worse" are different conversations with an operations manager.

## The response budget

The twin reports the arithmetic a procedure quietly depends on:

```
seconds the tank gives   = (hAh - hAl) x area / (qPump / 3600)
seconds a person needs   = walk to the pump + close the valve and stop it
```

With the shipped parameters the first is about 124 s and the second 75 s, with a further
165 s between the trip and the overflow. Those are model parameters, not measurements.
The finding is the comparison. A procedure that rests on a human action inside this
window fails when freeboard shortens, when the crew is new, or when the batch runs late.
The `automate_stop` control takes the person out of the gap instead of asking them to be
quicker.

## Backtest

`npx tsx scripts/backtest.ts` re-ranks against published investigations. Each case gives
the model a procedure and a plant state, and nothing else.

| Case | Plant state | Published causes | Recovered in the top 10 |
| --- | --- | --- | --- |
| BUN-TANK | `tk_buncefield_shape` | 5 | 4 |
| CLC-GAS | `fn_after_lining_repair` | 4 | 2 |
| DKN-WORD | `fn_cold_restart` | 4 | 1 |
| **Total** | 3 cases | **13** | **7 (54%)** |

11 of 13 (85%) land inside the top 20, none is never raised, and each case ranks about
60 candidate mechanisms. A top 10 picked at random catches about 17%.

**What this does not prove.** It does not predict an accident. Three reports is a small
sample with a heavy survivorship bias: the events investigated, not the procedures that
were merely bad. Mapping a finding to a model element is our reading of their report,
written in advance in `data/incidents/cases.json` so it can be argued with. Only three of
the thirteen land in the top five. What the curve does show is that a mechanism an
investigation later confirmed can be raised from the procedure text alone, before the
event, and ordered by what it is worth.
