// One real Jev call (two cars at a yellow/red light) to confirm the key,
// the pinned model and the answer mapping. Costs about 1-2k input tokens.
//
//   pnpm smoke

import { PRICE_PER_MTOK, renderPerceptionText, renderSceneText, type PerceptionFacts } from "@jev-city/shared";
import { MODEL, callJev, hasKey } from "../src/jev.ts";

if (!hasKey()) {
  console.error("TYPESAFE_API_KEY is missing: add it to .env at the repo root.");
  process.exit(1);
}

const yellow: PerceptionFacts = {
  speedMph: 31,
  limitMph: 35,
  schoolZoneActive: false,
  nextControl: { kind: "light", distanceM: 38, lightState: "yellow", secondsToRed: 1.5, canStopComfortably: true, willClearBeforeRed: false },
  pedestriansInCrosswalk: 0,
  pedestriansAtCurb: 0,
  turn: "straight",
};
const red: PerceptionFacts = {
  speedMph: 0,
  limitMph: 25,
  schoolZoneActive: false,
  nextControl: { kind: "light", distanceM: 1, lightState: "red", canStopComfortably: true },
  pedestriansInCrosswalk: 0,
  pedestriansAtCurb: 0,
  turn: "right",
};
const req = {
  zoneId: "A",
  simTime: 0,
  sceneText: renderSceneText({
    zoneId: "A",
    title: "Intersection A (Grand Ave and Elm St)",
    controlText: "traffic light with crosswalks",
    signalText: "Grand Ave (north-south) YELLOW, changes in about 2 s; Elm St (east-west) RED, changes in about 4 s.",
    carsInBox: [],
    events: [],
  }),
  cars: [
    { carId: "17", facts: yellow, text: renderPerceptionText("17", yellow) },
    { carId: "4", facts: red, text: renderPerceptionText("4", red) },
  ],
};

const r = await callJev(req);
console.log(`model requested ${MODEL}, answered by ${r.model}; ${r.jevLatencyMs.toFixed(0)} ms; ${r.usage.inputTokens} input tokens (estimate was ${r.estimatedTokens}); cost $${((r.usage.inputTokens / 1e6) * PRICE_PER_MTOK).toFixed(6)}`);
for (const d of r.decisions) {
  const probs = Object.entries(d.actionProbs)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(", ");
  console.log(`car ${d.carId}: ${d.action} (conf ${d.actionConfidence.toFixed(2)}; ${probs}) speed ${d.speedLevel.toFixed(2)} must_stop ${d.mustStopProb.toFixed(2)} hazard ${d.hazardLevel.toFixed(2)}${d.rightOfWayProb !== undefined ? ` row ${d.rightOfWayProb.toFixed(2)}` : ""}`);
}
