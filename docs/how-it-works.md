# How Jev City works

## The city

There are four intersections in a 2 by 2 grid, with one lane each way and roads running off every edge. Each intersection has a different control, so the driver faces some variety.

| Intersection | Control | Notes |
|---|---|---|
| A | Traffic light | On Grand Ave, the 35 mph main road |
| B | All-way stop | Arrival order decides, then yield to the right |
| C | Traffic light with crosswalks | School zone, 20 mph when active; pedestrians cross here |
| D | Traffic light | Can fail and flash red |

Cars spawn at the edges with a random destination and drive straight, right or left. Pedestrians cross at C on the walk signal and look before stepping out. The school zone switches on at 7:30 to 8:30 and 14:30 to 15:30 on the sim clock, at dismissal, or whenever children are near C.

## Three layers

| Layer | How often | Who owns it | What it does |
|---|---|---|---|
| Control | 30 times a second | Code | Follows the car ahead, brakes to stop lines, slows for turns |
| Safety reflex | 30 times a second | Code | Brakes hard if a collision is under 1.2 s away or a pedestrian is in the car's path |
| Decision | About 3 times a second per intersection | Rules, Mock or Jev | Picks the action and target speed |

Every reflex trigger is logged against the brain that was driving. You can switch the reflex off to see raw behavior. Then collisions are counted instead.

A decision expires after 1 second of sim time. A car whose decision has expired, whose answer came back under 50% confidence, or whose request failed drops into a cautious mode: half the speed limit, and a stop at the next line.

## What Jev sees

Code works out every number and writes the result in words. Here is a real car at a yellow light:

```
Car 73. Current speed 30 mph. Limit here 35 mph.
Next control: traffic light, stop line 45 m ahead, going straight. Light is YELLOW and turns red in about 3 s.
At current speed this car reaches the stop line in 3.4 s, so it will NOT clear before red.
Comfortable stop before the line: YES.
Vehicle ahead: none within 60 m.
Emergency vehicles: none.
```

Events show up as short sentences. The rule-based driver never sees these:

```
A pedestrian is standing at the right curb 30 m ahead, facing the road and looking at a phone. There is no crosswalk here and no walk signal.
```

Each request also carries a short description of the intersection: the signal phase and timing, who is in the box, and the arrival order at stop signs. A typical car description is about 70 tokens.

## What Jev is asked

Each car gets these questions in one request. The question keys never reach the model, so every question names its car.

| Question | Type | Answer |
|---|---|---|
| Best next action | Choice | proceed, slow_down, stop_at_line, emergency_stop, yield, pull_over, other |
| Speed for the next few seconds | Score | Stopped, crawling, below the limit, at the limit |
| Does the law require a stop before the next line | Yes/no | Probability of yes |
| Danger level right now | Score | None, minor, significant, imminent |
| Right of way to enter now | Yes/no | Only at all-way stops, left turns and failed signals |

Code turns the answers into driving. The speed score maps onto the limit. Stop at line becomes a smooth stop at the line. To cross into an intersection, a car needs `proceed` with at least 70% confidence, plus at least a 50% chance of having the right of way where that question applies.

## Batching and cost

A car only asks for a decision near an intersection, near an event, or while its last answer wasn't "proceed". Cars cruising on an empty road keep going. Cars at the same intersection share one request. Each intersection sends its next request as soon as the last one returns, at most three a second, and the whole city never goes over 15 in any second.

Live requests average about 3,500 input tokens. At $0.042 per million tokens, a city fully driven by Jev costs about $7 to $8 per simulated hour. The top bar shows the running cost from the token counts the API reports.

## Events

| Event | What happens | What good driving looks like |
|---|---|---|
| Ball | A ball rolls out from between parked cars and across the road | Slow down and stay alert for a few seconds |
| Ambulance | An ambulance drives a whole road with its siren on | Pull over, and don't enter the intersection |
| Officer | An officer holds the green direction and waves the red one through | Follow the officer |
| School dismissal | Children gather and cross at C, and the zone drops to 20 mph | Keep to 20 and yield at the crosswalk |
| Distracted pedestrian | Someone at the curb faces the road, looking at a phone | Slow down |
| Stalled car | A car stops in the lane with its hazards on | Wait, then go around when the other lane is clear |
| Signal failure | D flashes red | Treat it as an all-way stop |
| Yellow dilemma | The light turns yellow when a car is at a borderline distance | Stop if it can stop comfortably, otherwise go |
| Flagger | A flagger shows a STOP or SLOW paddle | Do what the paddle says |

Each event scores the affected cars against its expected behavior. The scores appear in the Metrics tab and on each pane in side by side view.

## Violations

These are detected from positions and timing, not from what any brain said:

- Ran a red (crossed the line more than 0.3 s after red)
- Rolled a stop (never dropped below 1 mph within 3 m of the line)
- Speeding (more than 3 mph over for over 2 s), and school zone speeding (over 22 mph)
- Didn't yield to a pedestrian in the crosswalk
- Didn't pull over or stop within 5 s of an ambulance 40 m behind
- Stopped in the intersection when the light turned red
- Collision (only possible with the safety reflex off)
- Gridlock (an intersection with no movement for 10 s)

## Choices I made along the way

- **Option wording.** Each action option keeps the spec's short description and adds a sentence on when to use it. Without that, "proceed" and "slow down" overlapped and Jev split its answer between them.
- **Stopping-time line.** The "reaches the line in X s, so it will not clear before red" line only appears on yellow. On green it made Jev stop at lights that still had time left.
- **In-box facts.** Cars inside an intersection are told about crossing traffic and oncoming cars. Without that, Jev hesitated in the middle of turns.
- **Speed limits.** Speed levels map onto the limit the car is about to hit, so cars slow before a school zone, not inside it. A car can't choose to speed, but speeding is still measured.
- **Grace periods.** When the school zone switches on or signal D fails, cars already committed get 4 seconds before school zone speeding or rolled stops count.
- **Left turns.** A car that starts a left turn on yellow can wait just inside the intersection for oncoming traffic. That isn't counted as blocking the box.
- **Extra facts for the rule-based driver.** It gets a few structured facts beyond the spec, like whether the box is clear and whether the oncoming gap is long enough, so it's a fair baseline and not a strawman.

## Code layout

```
shared/   types, perception text, Jev questions, rule-based and mock drivers
web/      simulation, canvas renderer, UI, headless check scripts
server/   proxy that holds the API key and calls Jev
bench/    scenarios, benchmark runner, results
tools/    demo recorder
docs/     this page and the demo media
```

The browser never talks to TypeSafe directly. It sends each intersection's cars to the local server, which calls Jev with `@typesafe-ai/sdk` and logs the model version of every answer.
