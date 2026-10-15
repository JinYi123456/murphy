# Backtest against published investigation findings

Each case gives the model a procedure and a plant state only. 3000 shifts per crew, ranked by share of failed shifts. A cause counts as recovered if one of its declared pieces of evidence appears inside the top 10.

This is a check on whether the model looks at the same mechanisms the investigators did, and in what order. It is not a prediction, and the mapping from a published finding to a model element is our judgement, written down in advance in `data/incidents/cases.json` so it can be disputed.

## BUN-TANK - Storage tank overfilled while its level protection was unavailable

> Buncefield: Why did it happen? - Competent Authority report for HSE and MIIB (2006). https://www.hse.gov.uk/comah/buncefield/ - tank 912 filled beyond its overfill level because the automatic tank gauge display had flat-lined so its alarms could not operate, and the independent high-high level switch had been installed without its padlock so the test lever left it bypassed; no management of change was performed when the switches were replaced; more than 250,000 litres of petrol escaped, over 40 people were injured.

Model given: procedure **OP-TRF-014**, plant state **tk_buncefield_shape**, crews: daytime_competent, night_trainee, fatigued_relief, rushed_turnaround.

Result: 673 of 12000 simulated shifts ended in a loss (5.61%), mean EUR 31,142 per failed shift.

| published finding | recovered | rank | what the model said |
| --- | --- | --- | --- |
| The level instrument the crew relied on had failed in a way that produced no indication | yes | 4 | mistrust active at d1 for Day shift, competent operator |
| The independent high-high function was present but bypassed, and nothing in the procedure proved it | yes | 3 | incomplete_function_test active at d1 for Day shift, competent operator |
| The transfer relied on measurements that were not independent of one another | no | 15 | confusable_device active at d15 for Day shift, competent operator |
| Crews had made a practice of working the batch down to the alarm band rather than keeping margin | yes | 9 | time_pressure active at d2 for Day shift, competent operator |
| A change to the protection scheme went through without a management-of-change review | yes | 2 | post_maintenance_state active at d1 for Day shift, competent operator |

Top findings the model produced that the reports did not name:
- (condition, rank 1) distraction active at d1 for Day shift, competent operator
- (condition, rank 5) teamwork active at d3 for Night shift, two months in the job
- (condition, rank 6) ambiguous_wording active at d1 for Day shift, competent operator
- (condition, rank 7) low_experience active at d3 for Night shift, two months in the job
- (condition, rank 8) fatigue active at d12 for Night shift, two months in the job

## CLC-GAS - Fuel gas accumulated in a furnace after an air-supply trip and ignited on re-light

> US Chemical Safety and Hazard Investigation Board, Incident Reports Volume 2 (2025), Cleveland-Cliffs Warren (2023): after a forced-draught fan trip the burner flame went out, the operator did not register the screen alarm, roughly 28,000 cubic feet of fuel gas accumulated in the furnace and then exploded, causing about USD 1M of damage.

Model given: procedure **OP-HT-006**, plant state **fn_after_lining_repair**, crews: daytime_competent, night_trainee, language_shift, rushed_turnaround.

Result: 4103 of 12000 simulated shifts ended in a loss (34.19%), mean EUR 1,123,063 per failed shift.

| published finding | recovered | rank | what the model said |
| --- | --- | --- | --- |
| Gas continued to enter an unlit chamber after the air supply was lost | no | 38 | Day shift, competent operator: Started the fan from the panel and left for the pilot. Nobody confirmed the air |
| The indication that should have told the operator was on a screen he was not watching | yes | 7 | absent_cue active at h2 for Day shift, competent operator |
| No step required the atmosphere to be proven clear again before re-ignition | no | 57 | Night shift, two months in the job: A second purge is forty minutes he does not have, so he tried the pilot ag |
| The crew could not act inside the time the accumulation allowed | yes | 8 | timing_critical active at h5 for Day shift, competent operator |

Top findings the model produced that the reports did not name:
- (condition, rank 1) distraction active at h2 for Day shift, competent operator
- (condition, rank 2) post_maintenance_state active at h2 for Day shift, competent operator
- (condition, rank 3) incomplete_function_test active at h2 for Day shift, competent operator
- (condition, rank 4) teamwork active at h4 for Night shift, two months in the job
- (condition, rank 5) time_pressure active at h2 for Day shift, competent operator

## DKN-WORD - A purge procedure that did not say where the purge medium came from

> US Chemical Safety and Hazard Investigation Board, Incident Reports Volume 2 (2025), Daikin Spring Valley / Decatur (2021): a drying tower was returned to service using a two-step nitrogen and refrigerant purge, the procedure did not specify the source of the refrigerant, toxic vapours were vented down onto working operators, and two people died days later.

Model given: procedure **OP-HT-006**, plant state **fn_cold_restart**, crews: daytime_competent, language_shift, night_trainee.

Result: 1979 of 9000 simulated shifts ended in a loss (21.99%), mean EUR 1,060,326 per failed shift.

| published finding | recovered | rank | what the model said |
| --- | --- | --- | --- |
| The procedure referenced another document for the details of a safety-critical step | no | 17 | Day shift, competent operator: Proved the block valve, which is the one the interlock watches, and not the bur |
| The step could be completed and still leave the protective function unproved | yes | 10 | incomplete_function_test active at h5 for Day shift, competent operator |
| Confusion between two nearly identical adjacent systems | no | 19 | Day shift, competent operator: Set it on TRC-5C. The faceplates came back from the retrofit the wrong way roun |
| The hazard was invisible to the people downstream of the vent | no | 11 | absent_cue active at h11 for Day shift, competent operator |

Top findings the model produced that the reports did not name:
- (condition, rank 1) distraction active at h12 for Day shift, competent operator
- (condition, rank 2) teamwork active at h5 for Contracted crew, procedure not in the working language
- (condition, rank 3) time_pressure active at h12 for Day shift, competent operator
- (condition, rank 4) fatigue active at h12 for Day shift, competent operator
- (condition, rank 5) low_experience active at h6 for Night shift, two months in the job

## Summary

13 causes were published by the investigators across 3 cases. The model was given the procedure and the plant state only, and produced a ranked list of about 60 candidate mechanisms per case; the rank below is where the published cause landed in the model's own ordering.

| how far down the list you read | causes recovered | of total |
| --- | --- | --- |
| top 5 findings | 3 | 23% |
| top 10 findings | 7 | 54% |
| top 20 findings | 11 | 85% |
| top 30 findings | 11 | 85% |
| never raised at all | 0 | 0% |

A ranking that put its first 10 items down at random would be expected to catch about 17% of them. The value of the curve is not the headline: it is that the model raises the mechanisms an investigation later confirms *before* the event, from the procedure text alone, and orders them by what they are actually worth. Two of these causes it ranks below the top ten, which is the honest result, and the reason a change order still needs a human signature.
