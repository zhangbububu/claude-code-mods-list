// Renders banner.html to the README's images with headless Google Chrome over CDP (Node 22+).
// The images hold no figures, so they only need redrawing when the design changes.
// usage, from the repo root: node assets/source/render.mjs assets/source/banner.html assets [light,dark,social]
// writes banner-light.png and banner-dark.png (880px wide at 2x) and social-preview.png (1280x640).
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [html, outdir, only] = process.argv.slice(2);
const chrome = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const profile = mkdtempSync(path.join(process.env.TMPDIR || tmpdir(), "chrome-"));
const port = 9333;
const proc = spawn(chrome, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--hide-scrollbars", "about:blank"], { stdio: "ignore" });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ws;
for (let i = 0; i < 50; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const page = list.find((t) => t.type === "page");
    if (page) { ws = new WebSocket(page.webSocketDebuggerUrl); break; }
  } catch {}
  await sleep(200);
}
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(e.data);
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const n = ++id;
  pending.set(n, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
  ws.send(JSON.stringify({ id: n, method, params }));
});

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDefaultBackgroundColorOverride", { color: { r: 0, g: 0, b: 0, a: 0 } });

const variants = only ? only.split(",") : ["light", "dark", "social"];
for (const v of variants) {
  const width = v === "social" ? 1280 : 880;
  const scale = v === "social" ? 1 : 2;
  await send("Emulation.setDeviceMetricsOverride", { width, height: 800, deviceScaleFactor: scale, mobile: false });
  await send("Page.navigate", { url: `${pathToFileURL(path.resolve(html)).href}?v=${v}` });
  await sleep(500);
  const { result } = await send("Runtime.evaluate", {
    expression: `document.fonts.ready.then(() => { const r = document.getElementById("art").getBoundingClientRect(); return JSON.stringify({ w: r.width, h: r.height, fonts: [...document.fonts].filter(f => f.status === "loaded").map(f => f.family + " " + f.weight + " " + f.stretch) }); })`,
    awaitPromise: true,
    returnByValue: true,
  });
  const box = JSON.parse(result.value);
  await sleep(300);
  const shot = await send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: box.w, height: box.h, scale: 1 }, captureBeyondViewport: true });
  const file = path.join(outdir, v === "social" ? "social-preview.png" : `banner-${v}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  console.log(file, `${box.w}x${box.h} css @${scale}x`, box.fonts.join(", "));
}
ws.close();
proc.kill();
