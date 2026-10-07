import { WindowLimiter } from "./window-limiter.js";

/** Logging must not turn rejected public traffic into a disk/heap DoS.
 * Histograms/counters still account for every request. Operational failures
 * and auth audit are unchanged; successful high-frequency probe polls sampled.
 */
export class CompletionLogPolicy {
  private readonly publicBudget = new WindowLimiter(2);
  private probeSuccesses = 0;
  allow(path: string, status: number, now = Date.now()): boolean {
    if (path.startsWith("/v1/public/auth/")) return false; // separate auth audit
    if (["/v1/public/benchmarks/gate-matrix", "/v1/public/trading/latency", "/v1/public/trading/pairs"].includes(path)) {
      return this.publicBudget.consume(status >= 400 ? "error" : "success", 60, 60_000, now).allowed;
    }
    if (status < 400 && (path === "/v1/gate/jobs/claim" || path === "/v1/trading-probe/jobs/claim"
      || path === "/v1/trading-probe/heartbeat" || /^\/v1\/trading-probe\/jobs\/[^/]+\/report$/.test(path))) {
      this.probeSuccesses = (this.probeSuccesses + 1) % 100;
      return this.probeSuccesses === 1;
    }
    return true;
  }
}
