// Question builders and answer mapping for Jev. Used by the server proxy,
// the benchmark, and MockJevBrain (to estimate request size).
//
// The shapes follow the TypeSafe HTTP API: choice / score / noul questions
// keyed by an id that is never sent to the model, so every instruction names
// the car and points at its entry in the state.

import {
  ACTIONS,
  needsRightOfWay,
  type Action,
  type CarDecision,
  type DecisionRequest,
} from "./brain.ts";

export type QuestionJson =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | { type: "noul"; instructions: string };

export const ACTION_CRITERIA: Record<Action, string> = {
  proceed: "Continue toward the target speed.",
  slow_down: "Reduce speed and stay ready to stop.",
  stop_at_line: "Come to a controlled stop at the next stop line.",
  emergency_stop: "Brake as hard as possible now.",
  yield: "Wait for another road user to go first.",
  pull_over: "Move to the right edge of the road and stop.",
  other: "None of these fit.",
};

export const SPEED_LEVELS = [
  "Stopped",
  "Crawling, about 5 mph",
  "Clearly below the posted limit",
  "At the posted limit",
];

export const HAZARD_LEVELS = [
  "No hazards",
  "Minor, stay aware",
  "Significant, slow down and watch",
  "Imminent, act immediately",
];

export const carStateKey = (carId: string) => `car_${carId}`;

function ref(carId: string): string {
  return `car ${carId} (described in \`cars.${carStateKey(carId)}\`)`;
}

export function buildQuestionsForCar(
  carId: string,
  rightOfWay: boolean,
): Record<string, QuestionJson> {
  const p = `c${carId}_`;
  const q: Record<string, QuestionJson> = {
    [`${p}action`]: {
      type: "choice",
      instructions: `The best next driving action for ${ref(carId)}, following traffic law and driving defensively`,
      criteria: { ...ACTION_CRITERIA },
    },
    [`${p}speed`]: {
      type: "score",
      instructions: `Appropriate speed for ${ref(carId)} over the next few seconds`,
      criteria: [...SPEED_LEVELS],
    },
    [`${p}must_stop`]: {
      type: "noul",
      instructions: `Traffic law requires ${ref(carId)} to stop before the next stop line`,
    },
    [`${p}hazard`]: {
      type: "score",
      instructions: `Danger level around ${ref(carId)} right now`,
      criteria: [...HAZARD_LEVELS],
    },
  };
  if (rightOfWay) {
    q[`${p}right_of_way`] = {
      type: "noul",
      instructions: `Car ${carId} (described in \`cars.${carStateKey(carId)}\`) has the right of way to enter the intersection now`,
    };
  }
  return q;
}

export interface JevPayload {
  state: { scene: string; cars: Record<string, string> };
  questions: Record<string, QuestionJson>;
}

/** One request per zone: the scene plus every car's perception, and all per-car questions. */
export function buildJevPayload(req: DecisionRequest): JevPayload {
  const cars: Record<string, string> = {};
  let questions: Record<string, QuestionJson> = {};
  for (const c of req.cars) {
    cars[carStateKey(c.carId)] = c.text;
    questions = { ...questions, ...buildQuestionsForCar(c.carId, needsRightOfWay(c.facts)) };
  }
  return { state: { scene: req.sceneText, cars }, questions };
}

/** Rough token estimate (characters / 4) when the API does not report usage. */
export function estimateTokens(payload: JevPayload): number {
  return Math.ceil(JSON.stringify(payload).length / 4);
}

// ---------------------------------------------------------------------------
// Answer mapping.

interface ChoiceAnswer {
  type: "choice";
  choice: string;
  confidence: number;
  probabilities: Record<string, number>;
}
interface ScoreAnswer {
  type: "score";
  score: number;
  confidence: number;
}
interface NoulAnswer {
  type: "noul";
  noul: number;
}
type AnyAnswer = ChoiceAnswer | ScoreAnswer | NoulAnswer;

export function parseJevAnswers(
  req: DecisionRequest,
  answers: Record<string, AnyAnswer | undefined>,
  latencyMs: number,
  model: string | undefined,
): CarDecision[] {
  return req.cars.map((c) => {
    const p = `c${c.carId}_`;
    const a = answers[`${p}action`] as ChoiceAnswer | undefined;
    const sp = answers[`${p}speed`] as ScoreAnswer | undefined;
    const ms = answers[`${p}must_stop`] as NoulAnswer | undefined;
    const hz = answers[`${p}hazard`] as ScoreAnswer | undefined;
    const row = answers[`${p}right_of_way`] as NoulAnswer | undefined;
    if (!a || !sp || !ms || !hz) throw new Error(`missing answers for car ${c.carId}`);
    const probs = Object.fromEntries(
      ACTIONS.map((k) => [k, a.probabilities[k] ?? 0]),
    ) as Record<Action, number>;
    const action = (ACTIONS as string[]).includes(a.choice) ? (a.choice as Action) : "other";
    return {
      carId: c.carId,
      action,
      actionProbs: probs,
      actionConfidence: a.confidence,
      speedLevel: sp.score,
      mustStopProb: ms.noul,
      hazardLevel: hz.score,
      rightOfWayProb: row?.noul,
      latencyMs,
      model,
    };
  });
}
