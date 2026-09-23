# Jev City

**Thirty cars. Four intersections. Every driving decision made by an AI model.**

[Open the live demo](https://jevcity.vercel.app) · [Watch the clip](docs/media/jev-city-demo.mp4) · [See the numbers](bench/results.md)

![Click any car and watch what Jev is told and what it decides](docs/media/city-and-inspector.gif)

## How I ended up building a city

I could not stop reading about Jev.

If you missed the hype: TypeSafe's Jev is a System One model. It does not write you an essay. You hand it some state and a typed question, and it hands back an answer with a probability on it, in about 200 milliseconds, for a few cents a million tokens. Choice, Score, yes or no. That is the whole surface area. It is the first model I have seen that feels less like a chatbot and more like a function you can call in a loop.

And every demo I saw was routing a support ticket.

Nothing wrong with support tickets. But a model that answers in 200 ms with calibrated confidence is begging to be put somewhere with a clock running. So I kept asking myself where common sense actually gets expensive, and I landed on the oldest hard problem in the book: driving.

Self-driving has been two years away for about a decade, and the hard part was never staying in the lane. It is the judgment. A ball bounces into the road and nothing is in your lane, but you lift off anyway, because a kid is about to follow it. A police officer waves you through a red light and the rulebook loses to a hand. That is not perception. That is knowing what a situation means.

Then it clicked: Jev does not need to see any of this. It never touches a pixel. Code can do the geometry and the timing, write three lines of plain English, and ask one question. What should this car do next?

So I built a city and gave it the keys.

## The clip

Nine judgment events you can drop into traffic with a click. Here is the ball rolling out from between parked cars, and a pedestrian at the curb staring at a phone. Watch the inspector on the right: that is the exact text Jev received and the probabilities it sent back.

![Judgment events](docs/media/judgment-events.gif)

Then the part I actually built this for. Same seed, same second, same event, two cities. A hand written rule based driver on the left, Jev on the right.

![Rules on the left, Jev on the right](docs/media/side-by-side.gif)

[Full clip, 1 minute 49 seconds, 1080p](docs/media/jev-city-demo.mp4)

## How it works

- Code turns each car's situation into a few lines of plain text. Distances, timings and "can it still stop" are all worked out in code, because a model that is fast and calibrated is still not a calculator.
- Jev answers five typed questions per car. What to do, how fast, how dangerous this is, whether the law says stop, and whether it has the right of way.
- Code keeps the wheel. Car following, braking, turning and a hard safety reflex all live in code. Jev makes the tactical call, not the muscle movements.
- Every car at one intersection rides in a single request, about three times a second, and the whole city stays under 15 requests a second.
- A rule based driver reads the same structured facts but never the text. It is what a careful engineer writes in an afternoon, and it is there so every number has something to beat.
- Violations are caught by geometry, not by asking the driver how it thinks it did.

## What happened

**The benchmark.** 100 frozen situations, three runs each. 40 are clear cut, 40 are judgment calls, 20 are genuinely ambiguous.

| | Overall | Clear cut | Judgment | Ambiguous | Latency (p50) | Same answer all 3 runs |
|---|---|---|---|---|---|---|
| Rule based | 90.0% | 100% | 75.0% | 100% | under 1 ms | 100% |
| Jev | 88.3% | 88.3% | **85.0%** | 95.0% | 199 ms | 95% |

**The live city.** Same seed, 30 cars, two minutes of real traffic.

| | Cars through intersections per minute | Average trip | Violations | Safety interventions |
|---|---|---|---|---|
| Rule based | 56.0 | 57 s | 0 | 0 |
| Jev | 42.5 | 72 s | 0 | 0 |

The headline: **Jev is ten points better than the rulebook exactly where the rulebook has nothing to say.** The ball that already rolled past, the person on their phone, the kids at the curb. The rule driver looks at an empty lane and keeps its foot down. Jev slows.

It also drove two full minutes of city traffic without a single red light run, rolled stop, missed pedestrian or collision.

## Where it breaks

I am not going to pretend this is a self driving stack.

- **One step of logic is one step too many.** At a four way stop it sometimes pulls out when it arrived second. Show it an officer waving it through a red and it often stops anyway, because the red light is right there in the text. TypeSafe documents this: the model reads literally and struggles with indirection.
- **Caution has a price.** About one live decision in ten comes back under 50% confidence, usually "go or slow down?" while creeping through a queue. Those cars drop into a careful mode, and the city moves 24% fewer cars per minute than the rulebook does. Safety is free here. Throughput is not.
- **Confidence is worth listening to.** At 90% or higher it was right every single time in the benchmark. Under 50% it was right 71% of the time. That gap is what makes a confidence gate worth building.
- **Batching is free.** Five cars in one request scored the same as one car per request and used 24% fewer tokens each.
- **It is cheap.** About 3,500 tokens a request. A whole city on Jev runs roughly $7 to $8 per simulated hour, and the 300 call benchmark cost about one cent.

One caveat worth stating plainly: I wrote both the scenario labels and the rule based driver, so the clear cut column leans in its favour.

## Try it

The [live demo](https://jevcity.vercel.app) runs the Mock brain, which is the rule driver with noise on its probabilities. No API key is deployed with it, because anyone could then spend my tokens. Everything else is real: the city, the events, side by side, the metrics, the benchmark tab.

To drive with actual Jev, run it yourself. You need Node 20+, pnpm and a TypeSafe key.

```sh
git clone https://github.com/Bravim-Ketan-Purohit/jev-city
cd jev-city
pnpm install
cp .env.example .env    # put your TYPESAFE_API_KEY in here
pnpm dev
```

Open http://localhost:5173/?brain=jev and watch 30 cars think.

| Command | What it does |
|---|---|
| `pnpm bench` | Runs the 100 scenarios and rewrites `bench/results.md` |
| `pnpm sim:check` | Runs the city with no browser and fails on any violation |
| `pnpm smoke` | One Jev call, to check your key |
| `pnpm record:demo` | Re-records the clip at the top of this page |

## Under the hood

- [How it works](docs/how-it-works.md): the three layers, the exact questions, the events, and every judgment call I made building it
- [Benchmark](bench/README.md): how the scenarios are scored
- [Full results](bench/results.md)

TypeScript, Canvas 2D, Vite, Hono and the TypeSafe SDK, with Jev pinned to `jev-1.13.0`.

## License

MIT, so take it anywhere. This is a finished experiment rather than a project I am maintaining, so issues and pull requests are closed. Fork it and make it yours.
