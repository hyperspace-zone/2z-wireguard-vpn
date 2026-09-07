#!/usr/bin/env node
// Read-only client-side measurements. This tool never reads a WireGuard key,
// changes routes, installs software, authenticates to an exchange, or trades.
import https from "node:https";
import dns from "node:dns/promises";
import { hostname } from "node:os";
import { readFile, readlink } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

const hosts = new Set([
  "api.binance.com", "api.bitget.com", "www.bitstamp.net", "api.exchange.bullish.com", "api.bybit.com", "api.coinbase.com", "www.deribit.com", "api.kraken.com", "www.okx.com", "sg-api.upbit.com", "api.hyperliquid.xyz",
  "omni-client-api.prod.ap-northeast-1.variational.io", "api.starknet.extended.exchange", "api.rise.trade", "mainnet.zklighter.elliot.ai", "clob.polymarket.com", "api.elections.kalshi.com"
]);

export function quantile(values, q) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b); const position = (sorted.length - 1) * q; const lower = Math.floor(position);
  return sorted[lower] + (sorted[Math.ceil(position)] - sorted[lower]) * (position - lower);
}

export function compareReports(direct, vpn) {
  if (direct.version !== 1 || vpn.version !== 1 || direct.profile !== "direct" || vpn.profile !== "vpn") throw new Error("Supply version-1 direct and vpn reports, in that order.");
  if (!direct.sourceHost || direct.sourceHost !== vpn.sourceHost) throw new Error("Reports must originate from the same source host.");
  if (direct.environment !== vpn.environment || JSON.stringify(direct.targets) !== JSON.stringify(vpn.targets)) throw new Error("Venue targets/revisions or environments differ; collect new comparable reports.");
  if (Math.abs(Date.parse(direct.finishedAt) - Date.parse(vpn.finishedAt)) > 30 * 60_000) throw new Error("Reports are more than 30 minutes apart. Repeat the comparison.");
  const legs = direct.targets.map(target => {
    const d = direct.samples.filter(sample => sample.venue === target.venue);
    const v = vpn.samples.filter(sample => sample.venue === target.venue);
    const ds = d.filter(sample => sample.ok); const vs = v.filter(sample => sample.ok);
    const dm = quantile(ds.map(sample => sample.totalMs), 0.5); const vm = quantile(vs.map(sample => sample.totalMs), 0.5);
    return { venue: target.venue, directP50Ms: dm, vpnP50Ms: vm, savedMs: dm !== null && vm !== null ? dm - vm : null, directP95Ms: quantile(ds.map(sample => sample.totalMs), 0.95), vpnP95Ms: quantile(vs.map(sample => sample.totalMs), 0.95), directAttempts: d.length, vpnAttempts: v.length, directFailures: d.length - ds.length, vpnFailures: v.length - vs.length };
  });
  const complete = legs.length === 2 && legs.every(leg => leg.directAttempts >= 3 && leg.vpnAttempts >= 3 && leg.directFailures === 0 && leg.vpnFailures === 0 && leg.savedMs !== null);
  return { version: 1, sourceHost: direct.sourceHost, evidence: "client-reported sequential A/B, not publicly verified", methodology: "cold HTTPS response, DNS excluded; sum of medians is an index, not a trading cycle", transportProof: "VPN label and namespace identity do not prove DoubleZero underlay; independently verify the tunnel and route.", legs, pairIndexSavedMs: complete ? legs.reduce((sum, leg) => sum + leg.savedMs, 0) : null, warning: complete ? "Short sequential test; not a persistent-session or execution benchmark. Repeated interleaved trials are needed to establish stability." : "Incomplete or failed samples. Do not infer improvement from successful requests alone." };
}

async function measure(target) {
  const addresses = await dns.resolve4(target.hostname);
  const address = addresses.find(ip => !/^(0|10|127|169\.254|192\.168|172\.(1[6-9]|2\d|3[01]))\./.test(ip));
  if (!address) throw new Error("No public IPv4 address available");
  const body = target.venue === "hyperliquid" ? JSON.stringify({ type: "allMids" }) : undefined;
  return new Promise(resolve => {
    let tcpMs; let totalBytes = 0; const chunks = []; const start = performance.now(); let completed = false;
    const finish = result => { if (!completed) { completed = true; clearTimeout(deadline); resolve({ venue: target.venue, measuredAt: new Date().toISOString(), ...result }); } };
    const request = https.request({ hostname: target.hostname, path: target.path, method: body ? "POST" : "GET", agent: false, lookup: (_host, options, callback) => options.all ? callback(null, [{ address, family: 4 }]) : callback(null, address, 4), headers: { accept: "application/json", "cache-control": "no-cache", "user-agent": "HyperspacePairCheck/1", ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) } }, response => {
      response.on("data", chunk => { totalBytes += chunk.length; if (totalBytes > 1048576) request.destroy(new Error("response_too_large")); else chunks.push(chunk); });
      response.on("end", () => {
        let valid = false; try { JSON.parse(Buffer.concat(chunks).toString()); valid = true; } catch {}
        finish({ ok: response.statusCode === 200 && valid, httpStatus: response.statusCode, tcpMs, totalMs: performance.now() - start, bytes: totalBytes, resolvedIp: address, ...(!valid ? { error: "invalid_json" } : {}) });
      });
      response.on("error", error => finish({ ok: false, error: error.message }));
    });
    const deadline = setTimeout(() => request.destroy(new Error("timeout")), 5000);
    request.on("socket", socket => socket.on("connect", () => { tcpMs = performance.now() - start; }));
    request.on("error", error => finish({ ok: false, error: error.message }));
    request.end(body);
  });
}

async function main(args) {
  if (!args.length || args.includes("--help")) {
    process.stdout.write(`Hyperspace Pair Check (Node.js >=22)\n\nRead-only, no keys, no orders, no route changes. Run on the SAME server.\n\n  node trading-pair-check.mjs --venues binance,lighter --profile direct > direct.json\n  # Activate your OWN config in an isolated network namespace; verify its route.\n  sudo ip netns exec YOUR_NAMESPACE node trading-pair-check.mjs --venues binance,lighter --profile vpn > vpn.json\n  node trading-pair-check.mjs --compare direct.json vpn.json\n\nOptions: --environment production|staging (default production), --count 3..100 (default 20).\nThe VPN profile is a label, NOT tunnel or DoubleZero verification. This tool\ndoes not create a namespace or install a config. Do not change a live bot's\ndefault route to run a test. Keep raw reports private; they contain host/IP data.\n`); return;
  }
  const compare = args.indexOf("--compare");
  if (compare >= 0) { const direct = JSON.parse(await readFile(args[compare + 1], "utf8")); const vpn = JSON.parse(await readFile(args[compare + 2], "utf8")); process.stdout.write(`${JSON.stringify(compareReports(direct, vpn), null, 2)}\n`); return; }
  const value = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
  const environment = value("--environment", "production"); const profile = value("--profile", "direct"); const count = Number(value("--count", "20")); const venues = value("--venues", "").split(",");
  if (!["production", "staging"].includes(environment) || !["direct", "vpn"].includes(profile) || !Number.isInteger(count) || count < 3 || count > 100 || venues.length !== 2 || new Set(venues).size !== 2) throw new Error("Choose two distinct venues, direct|vpn, production|staging and count 3..100. See --help.");
  const origin = environment === "staging" ? "https://app.staging.hyperspace.zone" : "https://app.hyperspace.zone";
  const response = await fetch(`${origin}/api/v1/public/trading/latency`, { signal: AbortSignal.timeout(15000) }); if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
  const catalog = await response.json();
  const targets = venues.sort().map(venue => {
    const target = catalog.targets.find(target => target.venueKey === venue);
    if (!target || !hosts.has(target.hostname) || !target.path.startsWith("/") || /[\r\n]/.test(target.path)) throw new Error(`Unsupported public venue: ${venue}`);
    return { venue, id: target.id, revision: target.revision, hostname: target.hostname, path: target.path };
  });
  const report = { version: 1, environment, profile, sourceHost: hostname(), networkNamespace: await readlink("/proc/self/ns/net").catch(() => "unknown"), startedAt: new Date().toISOString(), targets, samples: [] };
  for (let index = 0; index < count; index += 1) {
    for (const target of targets) { try { report.samples.push(await measure(target)); } catch (error) { report.samples.push({ venue: target.venue, measuredAt: new Date().toISOString(), ok: false, error: error.message }); } }
    if (index + 1 < count) await delay(1000);
  }
  report.finishedAt = new Date().toISOString();
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
