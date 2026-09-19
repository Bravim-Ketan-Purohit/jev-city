// Benchmark scenario schema: frozen perception snapshots with labels.

import type { Action, CarPerception } from "./brain.ts";

export type ScenarioCategory = "rule" | "judgment" | "ambiguous";

export interface Scenario {
  id: string;
  category: ScenarioCategory;
  title: string;
  sceneText: string;
  perception: CarPerception;
  expectedAction: Action;
  acceptableActions: Action[];
  expectedMustStop: boolean;
  notes?: string;
}

export interface ScenarioFile {
  version: number;
  scenarios: Scenario[];
}
