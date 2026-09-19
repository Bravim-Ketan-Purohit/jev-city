# Jev City benchmark results

> **Draft labels: needs human review.** Every expected action, acceptable set and must_stop label in `bench/scenarios.json` was drafted with the code. They are the ground truth for the numbers below, so review them by hand before publishing anything from this file.

Generated 2026-09-19 09:32 UTC · 100 scenarios (40 rule, 40 judgment, 20 ambiguous) · 3 runs per brain · Jev model pinned to `jev-1.13.0` (SDK 0.6.0) · $0.042 per million input tokens.

## Summary

| Brain | Accuracy (acceptable set) | Exact match | Rule | Judgment | Ambiguous | must_stop Brier | p50 latency | p95 latency | Runs agree | Tokens / request | Cost, all runs |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Rules | 90.0% | 80.0% | 100.0% | 75.0% | 100.0% | 0.030 | 0.001 ms | 0.006 ms | 100.0% | n/a | n/a |
| Mock Jev | 87.3% | 76.3% | 96.7% | 73.3% | 96.7% | 0.032 | 302 ms | 483 ms | 84.0% | 584 (est.) | $0.0074 |
| Jev | 88.3% | 74.3% | 88.3% | 85.0% | 95.0% | 0.109 | 199 ms | 396 ms | 95.0% | 932 | $0.0117 |

Accuracy counts an answer as correct when the chosen action is in the scenario's acceptable set; exact match requires the single expected action. Mock Jev latency is sampled (70 to 500 ms) rather than waited for, and its tokens are a characters ÷ 4 estimate; Jev latency is measured around each API call and its tokens come from the response's `usage`.

## Accuracy by category

| Category | Scenarios | Rules | Mock Jev | Jev |
| --- | --- | --- | --- | --- |
| rule | 40 | 100.0% (exact 100.0%) | 96.7% (exact 95.8%) | 88.3% (exact 85.8%) |
| judgment | 40 | 75.0% (exact 67.5%) | 73.3% (exact 64.2%) | 85.0% (exact 67.5%) |
| ambiguous | 20 | 100.0% (exact 65.0%) | 96.7% (exact 61.7%) | 95.0% (exact 65.0%) |

## Calibration

Action confidence bucketed against observed accuracy (acceptable set). A well-calibrated brain has accuracy close to its mean confidence in each bucket. Rules always report 1.0, so only the top bucket is populated for it.

**Mock Jev**

| Confidence | Decisions | Mean confidence | Observed accuracy |
| --- | --- | --- | --- |
| below 0.5 | 3 | 0.466 | 100.0% |
| 0.5 to 0.6 | 32 | 0.560 | 90.6% |
| 0.6 to 0.7 | 63 | 0.653 | 82.5% |
| 0.7 to 0.8 | 87 | 0.752 | 87.4% |
| 0.8 to 0.9 | 57 | 0.841 | 86.0% |
| 0.9 to 1.0 | 58 | 0.948 | 91.4% |

**Jev**

| Confidence | Decisions | Mean confidence | Observed accuracy |
| --- | --- | --- | --- |
| below 0.5 | 68 | 0.380 | 70.6% |
| 0.5 to 0.6 | 20 | 0.545 | 70.0% |
| 0.6 to 0.7 | 24 | 0.643 | 87.5% |
| 0.7 to 0.8 | 38 | 0.751 | 97.4% |
| 0.8 to 0.9 | 43 | 0.841 | 88.4% |
| 0.9 to 1.0 | 107 | 0.972 | 100.0% |

## must_stop

Brier score of the `must_stop` probability against the label (0 is perfect, 0.25 is a coin flip at 0.5).

| Brain | Brier | Brier, rule | Brier, judgment | Brier, ambiguous |
| --- | --- | --- | --- | --- |
| Rules | 0.030 | 0.050 | 0.000 | 0.050 |
| Mock Jev | 0.032 | 0.050 | 0.006 | 0.049 |
| Jev | 0.109 | 0.099 | 0.108 | 0.130 |

## Latency and cost

| Brain | p50 | p95 | Requests | Input tokens | Cost | Model(s) |
| --- | --- | --- | --- | --- | --- | --- |
| Rules | 0.001 ms | 0.006 ms | 300 | 0 | $0.0000 | rules |
| Mock Jev | 302 ms | 483 ms | 300 | 175,233 (est.) | $0.0074 | mock-jev |
| Jev | 199 ms | 396 ms | 300 | 279,558 | $0.0117 | jev-1.13.0 |

Benchmark requests carry one car and average 932 input tokens. Live zone requests carry every car in the zone; the live Metrics panel reports measured tokens and cost per simulated hour.

## Consistency across runs

Share of scenarios where all 3 runs chose the same action.

| Brain | All runs agree |
| --- | --- |
| Rules | 100.0% of 100 |
| Mock Jev | 84.0% of 100 |
| Jev | 95.0% of 100 |

## Where the brains differ

Majority action per brain for scenarios where at least one brain chose an action outside the acceptable set.

| ID | Scenario | Expected (acceptable) | Rules | Mock Jev | Jev |
| --- | --- | --- | --- | --- | --- |
| R18 | Stopped at stop sign, arrived second, earlier car crosses its path | yield (yield, stop_at_line) | yield | yield | **proceed** ✗ |
| R25 | Two pedestrians in the crosswalk 12 m ahead, green light | yield (yield, stop_at_line) | yield | yield | **slow_down** ✗ |
| R31 | Green light but the exit lane is backed up | stop_at_line (stop_at_line, yield) | stop_at_line | stop_at_line | **slow_down** ✗ |
| R32 | Officer waves the lane through a red light | proceed (proceed) | proceed | proceed | **stop_at_line** ✗ |
| R37 | Ambulance about to cross the intersection, light green | yield (yield, stop_at_line) | yield | yield | **proceed** ✗ |
| J01 | Ball just rolled across the road 25 m ahead | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J03 | Ball rolled across 45 m ahead, car at 25 mph | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J05 | Distracted pedestrian at the right curb 30 m ahead | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J06 | Distracted pedestrian at the right curb 12 m ahead | slow_down (slow_down, yield) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J07 | Distracted pedestrian at the left curb, far side, 35 m | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J08 | Children at the curb by the crosswalk, one stepping toward the road | slow_down (slow_down, yield) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J10 | School zone active, children near the curb, no crosswalk use yet | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | **proceed** ✗ |
| J14 | Ambulance crossing on the other road, this car has a green | yield (yield, stop_at_line, slow_down) | yield | yield | **proceed** ✗ |
| J21 | Signal failed, stopped, arrived second, earlier car crosses | yield (yield, stop_at_line) | yield | yield | **proceed** ✗ |
| J23 | Yellow dilemma: comfortable stop barely possible | stop_at_line (stop_at_line) | stop_at_line | stop_at_line | **proceed** ✗ |
| J26 | Yellow on the arterial, 40 m at 35 mph | stop_at_line (stop_at_line) | stop_at_line | **proceed** ✗ | **proceed** ✗ |
| J31 | Vehicle ahead stopped suddenly 10 m ahead at 25 mph | emergency_stop (emergency_stop, slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J32 | Children gathered at the curb, school zone, car at 20 mph | slow_down (slow_down, yield) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J35 | Distracted pedestrian beside a green light approach | slow_down (slow_down) | **proceed** ✗ | **proceed** ✗ | slow_down |
| J38 | Stalled car just before the intersection, oncoming clear | yield (yield, stop_at_line) | yield | yield | **slow_down** ✗ |
| A14 | Pedestrian in the crosswalk on the far side of the road, moving away | yield (yield, slow_down) | yield | yield | **proceed** ✗ |

## Method

- Each scenario is one request: the zone scene plus the car's perception as state, and the car's questions (`action` Choice with an explicit `other`, `speed` and `hazard` Scores, `must_stop` Noul, and `right_of_way` Noul where it applies). The same question builders drive the live simulation.
- The perception text is rendered from structured facts by the same serializer the live simulation uses; all distances, times, stopping feasibility and arrival order are computed in code and stated in words.
- RuleBrain reads only the structured facts, never the free text, so judgment events that only appear in text (a ball that has already left the lane, a distracted pedestrian) are invisible to it by design.
- Mock Jev wraps RuleBrain with noisy probabilities, 70 to 500 ms sampled latency and a 5% second-best pick; it is a plumbing check, not a model.
- Caveat on fairness: the scenario labels and RuleBrain were drafted together. RuleBrain's `must_stop` logic implements the same label convention (see the top of `bench/src/build-scenarios.ts`), so its Brier score is low by construction, and its rule-category accuracy reflects shared assumptions. Independent label review is the main way to remove that bias.
