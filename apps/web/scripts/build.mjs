import { copyFile, cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const buildId = process.env.HYPERSPACE_WEB_BUILD_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
if (!/^[A-Za-z0-9_-]+$/.test(buildId)) throw new Error("Invalid web build ID");
const index = await readFile("index.html", "utf8");
await writeFile("dist/index.html", index.replaceAll("__HYPERSPACE_WEB_BUILD_ID__", buildId));
await copyFile("favicon-48x48.png", "dist/favicon-48x48.png");
await copyFile("hyperspace-logo.svg", "dist/hyperspace-logo.svg");
await copyFile("../../node_modules/leaflet/dist/leaflet.css", "dist/leaflet.css");
await copyFile("../../node_modules/leaflet/dist/leaflet.js", "dist/leaflet.js");
await copyFile("styles.css", "dist/styles.css");
await copyFile("pairs.css", "dist/pairs.css");
await copyFile("../../scripts/trading/trading-pair-check.mjs", "dist/trading-pair-check.mjs");

// Every module import stays inside an immutable, versioned namespace. Root
// assets remain uncached for older clients during the deployment transition.
const assetDir = `dist/assets/${buildId}`;
await mkdir(assetDir, { recursive: true });
for (const name of await readdir("dist")) {
  if (/\.(js|mjs|css|svg|png)$/.test(name) && !name.endsWith(".test.js")) {
    await copyFile(`dist/${name}`, `${assetDir}/${name}`);
  }
}
await cp("../../node_modules/leaflet/dist/images", `${assetDir}/images`, { recursive: true });
