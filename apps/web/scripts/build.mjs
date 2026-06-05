import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";

await mkdir("dist", { recursive: true });
const buildId = process.env.HYPERSPACE_WEB_BUILD_ID ?? new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
const index = await readFile("index.html", "utf8");
await writeFile("dist/index.html", index.replaceAll("__HYPERSPACE_WEB_BUILD_ID__", buildId));
await copyFile("favicon-48x48.png", "dist/favicon-48x48.png");
await copyFile("styles.css", "dist/styles.css");
