// Optional simulation layers (pedestrians, judgment events). Filled in by M4.

import type { Simulation } from "./sim.ts";

export interface LayerOptions {
  pedestrians: boolean;
}

export function installLayers(sim: Simulation, opts: LayerOptions): void {
  void sim;
  void opts;
}
