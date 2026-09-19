# Jev City

A top-down 2D traffic simulation in which 20–50 cars are driven by TypeSafe's Jev model, with a hand-written rule-based driver as the baseline. The spec is in [`claude.md`](claude.md). This is a decision-making demo, not a self-driving system: Jev never sees pixels. Code turns the world into short text descriptions and Jev makes tactical choices.

## Run it

Requirements: Node 20+ and pnpm.

```sh
pnpm install
cp .env.example .env        # then set TYPESAFE_API_KEY (only needed for Jev)
pnpm dev                    # server on :8787 and web on :5173
```

Open http://localhost:5173. Everything runs without a key: pick **Mock** in the top bar. With a key in `.env`, **Jev** drives live. Useful URL parameters: `?brain=jev`, `?view=sbs` (side by side), `?seed=42`, `?cars=50`.

| Command | What it does |
| --- | --- |
| `pnpm dev` | Starts the Jev proxy (`server/`) and the Vite app (`web/`) together |
| `pnpm smoke` | One real Jev call through the SDK to check the key and the pinned model (costs about $0.00005) |
| `pnpm bench` | Runs the 100 benchmark scenarios through Rules, Mock and Jev, three runs each, and writes `bench/results.json` and `bench/results.md` |
| `pnpm sim:check -- --minutes 5 --no-left` | Headless city run with RuleBrain; exits non-zero on any violation, safety intervention or gridlock |
| `pnpm typecheck` | Type-checks every package |

More headless tools live in `web/scripts/`:

- `async-check.ts` runs the city in real time with Mock or Jev (`--brain jev`) and reports latency, stale decisions and fallbacks.
- `events-check.ts` injects all nine judgment events on a schedule and prints the scored responses.

Run either one with `pnpm --filter @jev-city/web exec tsx scripts/<name>.ts`.

The API key lives only in the repo-root `.env`, which is git-ignored. The browser never talks to TypeSafe: it posts decision batches to `/api/decide`, and the server calls Jev with `@typesafe-ai/sdk`.

## Using the app

- **Top bar:** brain (Rules, Mock, Jev, Mixed), batching mode, safety reflex, time (pause, step, 1×/2×/4×), sim clock with the school-zone indicator, seed and reset, running cost, and Live versus Side-by-side view.
- **Canvas:** scroll to zoom, drag to pan, double-click to fit, click a car to inspect it. Keyboard: Space pauses, S steps 1/3 s, 1/2/4 set the speed, Esc cancels.
- **Right panel:**
  - **Inspector:** the selected car's perception text, action probabilities, speed and hazard scores, latency, decision age and model.
  - **Metrics:** live counters, violations, fallbacks, per-brain latency, tokens and cost, and event responses.
  - **Log:** the decision stream plus violations and events, exportable as JSONL.
  - **Results:** the latest `pnpm bench` output.
- **Event toolbar:** pick an event, then click the map. School dismissal and signal failure trigger at once. In side-by-side view the same event goes into both cities at the same place and moment.

Recording tips: use a 1920×1080 browser window at 100% zoom. The frame loop pauses when the tab is hidden, which also stops Jev spending in background tabs.

## Layout

```
shared/   brain types, perception serializer, question builders, RuleBrain, MockJevBrain, scenario schema
web/      simulation (sim/), canvas renderer (render/), UI (ui/), JevBrain client (brains/), headless scripts
server/   Hono proxy: /api/decide, /api/health, /api/bench; logs every response's model to logs/jev-<date>.jsonl
bench/    scenarios.json (DRAFT labels), build-scenarios.ts, run.ts, results.json, results.md
```

## Architecture

| Layer | Rate | Owner | Job |
| --- | --- | --- | --- |
| Control | 30 Hz physics, 60 fps render | Code | IDM car following on lane/connector routes, turn-speed caps, stop-point profiles, pulling over, going around a stalled car |
| Safety reflex | 30 Hz | Code (toggle) | Brakes hard on time-to-collision under 1.2 s: vehicles ahead, crossing traffic in the box, a pedestrian in the car's path, head-on risk while passing. Every trigger is logged as an intervention against the driving brain |
| Decision | up to 3 Hz per zone | Rules, Mock or Jev | Tactical action plus speed, hazard, must_stop and right-of-way answers |

Decisions are event-driven. A car asks for one within 80 m of an intersection, near an active event, or while its last action is not `proceed`. Requests are batched per zone, and a zone sends its next request as soon as its previous reply lands (at most 3 Hz). No second ever holds more than 15 requests, enforced in the browser and again in the proxy. A decision older than 1.0 s of sim time puts the car in cautious mode (half the limit, stop at the next line). The same happens on API errors and when action confidence is below 0.5. Entering an intersection needs `proceed` or `slow_down` with at least 0.7 confidence, plus a right-of-way probability of at least 0.5 where that question applies.

Violations are detected geometrically and independently of the brains. The detector covers ran red, rolled stop, speeding, school-zone speeding, failure to yield to a pedestrian or ambulance, blocking the box, collisions and gridlock.

## Jev integration

- The SDK is `@typesafe-ai/sdk` 0.6.0. The model is pinned to `jev-1.13.0`, and the `model` field of every response is logged.
- **State:** `{ scene, cars: { car_<id>: text } }`. Each car gets four questions (`action` Choice, `speed` Score, `must_stop` Noul, `hazard` Score) plus `right_of_way` (Noul) at all-way stops, left turns and failed signals. Question IDs are never sent to the model, so every instruction names the car and points at its entry in the state (`cars.car_17`).
- **Arithmetic stays in code.** The serializer states distances, times, stopping feasibility, arrival order, oncoming gaps and box occupancy in words (YES/NO).
- **Cost:** live zone requests averaged about 3.5k input tokens, roughly 42k tokens per second with every car on Jev, which is about $6.50 per simulated hour at $0.042 per million input tokens. The top bar shows the running figure from the API's `usage`.

## Where this departs from or interprets the spec

- **Action descriptions:** the option descriptions keep the spec's wording as their first sentence and add a "when to use" sentence, following TypeSafe's advice that options should separate cleanly. `proceed` and `slow_down` otherwise overlap on ordinary approaches.
- **Stopping-time line:** the "reaches the stop line in X s, so it will (not) clear before red" line is shown for yellow lights only. On green it made Jev stop early at lights that were about to change.
- **Speed levels:** speed levels map onto the effective limit, which already anticipates a lower limit ahead (the school zone). The control layer never targets more than the posted limit, so speeding violations can only come from edge cases. They are still measured as a sanity check. The school zone and a newly failed signal give committed cars a 4 s grace before school-speeding or rolled-stop violations count.
- **Extra structured facts:** `PerceptionFacts` gained a few fields the rule baseline needs to be fair: turn direction, box clear, earlier conflicting arrivals, exit room, oncoming gap, crosswalk distance, lower limit ahead, obstacle kind, pass feasibility, flagger, and an emergency vehicle crossing.
- **Left turns:** left turns that are committed on yellow wait at a point 4 m inside the box and are exempt from blocked-the-box.
- **must_stop labels:** they read the question literally. A stop sign requires a stop even after the car has made it, and open-road hazards are labelled false because no stop line is involved.

## Findings so far (draft labels)

From `bench/results.md` (100 scenarios, 3 runs each):

| | Overall | Rule | Judgment | Ambiguous | p50 latency | Runs agree |
| --- | --- | --- | --- | --- | --- | --- |
| Rules | 90.0% | 100% | 75.0% | 100% | <1 ms | 100% |
| Jev | 88.3% | 88.3% | 85.0% | 95.0% | 199 ms | 95% |

- **Where Jev wins:** it handles the hazards that only exist in text. The ball that has already left the lane, the distracted pedestrian, children at the curb and a car stopping ahead all get slow_down with raised hazard, where Rules and Mock proceed. In the live event run Jev passed the ball and distracted-pedestrian events that Rules failed.
- **Where Jev loses:** it proceeds at all-way stops when it arrived second behind a crossing car, and it follows a red light over an officer waving the lane through. These are indirection and conflicting-instruction cases, as in TypeSafe's jaggedness notes.
- **Confidence is informative.** Decisions at 0.9+ confidence were correct about 97–100% of the time; those below 0.5 about 70%.
- **The live cost of the confidence gate.** About 17% of live Jev decisions fall under 0.5 confidence, mostly proceed versus slow_down in slow queues at green lights. The spec's gate sends those cars into cautious mode, which costs throughput.
- **Batching is safe.** Packing 5 cars into one request (`pnpm bench -- --pack 5`) scored 87.7% against 85.3% with one car per request, which is within noise, and cost 24% fewer tokens per car.

The scenario labels and RuleBrain were drafted together, so Rules' rule-category score and must_stop Brier reflect shared assumptions. Review `bench/scenarios.json` (edit `bench/src/build-scenarios.ts`, then run `pnpm --filter @jev-city/bench scenarios`) before publishing any of these numbers.
