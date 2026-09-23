import "./ui/styles.css";
import { App } from "./app.ts";

const root = document.getElementById("app")!;

// The canvas draws its labels in Overpass, so ask for the weights we use and
// wait for them before the first frame. `document.fonts.ready` alone resolves
// before anything has requested the family.
const FACES = [
  '600 16px "Overpass"',
  '700 16px "Overpass"',
  '800 16px "Overpass"',
  '900 16px "Overpass"',
  '400 12px "Overpass Mono"',
  '600 12px "Overpass Mono"',
];

const loadFonts = async () => {
  try {
    await Promise.allSettled(FACES.map((f) => document.fonts.load(f)));
  } catch {
    /* the app looks fine in the fallback face */
  }
};
const timeout = new Promise((r) => setTimeout(r, 2500));

Promise.race([loadFonts(), timeout]).then(() => {
  const app = new App(root);
  (window as unknown as { app: App }).app = app;
  // A late-arriving font still needs the cached map background redrawn.
  void document.fonts.ready.then(() => app.invalidateRenderers());
});
