import "./ui/styles.css";
import { App } from "./app.ts";

const root = document.getElementById("app")!;
// Wait for the Overpass font so canvas labels render in it from the first frame.
const ready = (document as Document & { fonts?: FontFaceSet }).fonts?.ready ?? Promise.resolve();
Promise.race([ready, new Promise((r) => setTimeout(r, 1500))]).then(() => {
  (window as unknown as { app: App }).app = new App(root);
});
