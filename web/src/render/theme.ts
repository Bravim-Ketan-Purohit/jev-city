// Palette from road signage and civil-engineering plan sheets. Colors are
// functional: stop red for stops and violations, highway green for Jev and
// healthy states, service blue for rule-driven cars, school fluorescent
// yellow-green for the school zone and children, amber for warnings.

export const C = {
  paper: "#F3F0E7",
  paperDeep: "#ECE7DA",
  gridMinor: "#E7E2D5",
  gridMajor: "#DCD4C1",
  lot: "#EDE8DB",
  lotLine: "#CFC6B0",
  building: "#E3DCCB",
  buildingLine: "#A89E86",
  hatch: "#C9BFA7",
  park: "#E4E8D5",
  parkLine: "#B7BF9C",
  tree: "#AFB98F",
  sidewalk: "#E1DCCF",
  curb: "#A0978A",
  asphalt: "#5A5D62",
  asphaltLight: "#676A6F",
  laneWhite: "#F4F3EE",
  laneYellow: "#F2C12E",
  ink: "#1E2326",
  ink2: "#5B6166",
  ink3: "#8C8F8A",
  stop: "#C8102E",
  green: "#00764A",
  greenLight: "#3E9A6C",
  blue: "#1F4E96",
  school: "#C4E530",
  schoolInk: "#6E8A00",
  amber: "#E89A17",
  signalOff: "#2A2D31",
  lampRed: "#F0303C",
  lampYellow: "#FFC53D",
  lampGreen: "#2BD483",
  white: "#FFFFFF",
};

export const BRAIN_COLOR: Record<string, string> = {
  rules: C.blue,
  "mock-jev": C.greenLight,
  jev: C.green,
};

export const FONT = `"Overpass", "Helvetica Neue", Arial, sans-serif`;
export const MONO = `"Overpass Mono", ui-monospace, "SF Mono", Menlo, monospace`;
